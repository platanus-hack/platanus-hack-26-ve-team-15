// Microcrédito simulado (credit.js + pagomovil.js): CMD firmado → pagar / recargar_saldo → cupo, recibo y panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MSG, decodePacket, verifyPacket } from '../src/codec.js';
import { unseal } from '../src/crypto.js';
import { decideCommand } from '../src/commands.js';
import { planFor } from '../src/credit.js';
import { fakeChannels, makePhone, sosFields, sosPlaintext, startApp } from './helpers.js';

const ON = { FEATURE_PAYMENTS: 'true', CMD_MAX_PER_DAY: '100', CMD_MAX_AMOUNT_PER_DAY: '100000' };
const PAGO = { banco: 'Banesco', cedula: 'V-12345678', telefono: '0412-1234567', concepto: 'medicinas' };
const RECARGA = { operador: 'Movistar', telefono: '0414 7654321' };

async function setup(env = {}, opts = {}) {
  const app = await startApp({ env: { ...ON, ...env }, ...opts });
  const phone = makePhone(app);
  assert.equal((await phone.register()).status, 201);
  let seq = 3;
  const cmd = (name, ref, args) => phone.egress(phone.packet({ msgType: MSG.CMD, seq: (seq += 1), plaintext: Buffer.from(JSON.stringify({ cmd: name, ref, args })) }));
  return { app, phone, cmd };
}

async function results(app, phone) {
  const poll = await app.call('POST', '/v1/mailbox/poll', { queries: [{ sender_id: phone.senderId, incident_ids: [phone.incidentId] }], cursor: null, limit: 50 });
  return poll.json.messages.filter((m) => m.msg_type === MSG.CMD_RESULT).map((m) => {
    const p = decodePacket(Buffer.from(m.packet_b64, 'base64'));
    assert.ok(verifyPacket(p, app.keys.signPk));
    const pt = unseal(p.sealedBlob, phone.sealKp.publicKey, phone.sealKp.privateKey);
    return { ref: pt.readUInt16BE(0), status: pt[2], text: pt.subarray(3).toString('utf8') };
  });
}

const credit = async (app, phone) => (await app.call('GET', `/v1/credit/${phone.senderId}`)).json;

test('planFor: 5 % de comisión, 3 cuotas que suman el total y el resto va a las primeras', () => {
  assert.deepEqual(planFor(2500), { fee: 125, total: 2625, parts: [875, 875, 875] });
  assert.deepEqual(planFor(1000), { fee: 50, total: 1050, parts: [350, 350, 350] });
  assert.deepEqual(planFor(1001), { fee: 50, total: 1051, parts: [351, 350, 350] });
  assert.deepEqual(planFor(1000, 0), { fee: 0, total: 1000, parts: [334, 333, 333] });
});

test('pagar con Pago Móvil: recibo [MOCK] firmado en el buzón, cupo descontado y plan de cuotas en /v1/credit', async () => {
  const { app, phone, cmd } = await setup();
  try {
    const before = await credit(app, phone);
    assert.deepEqual([before.limit_cents, before.used_cents, before.available_cents, before.transactions.length], [5000, 0, 5000, 0]);

    await cmd('pagar', 1, { ...PAGO, monto: 25, moneda: 'USD' });
    const [res] = await results(app, phone);
    assert.equal(res.status, 0);
    assert.match(res.text, /^\[MOCK\] Pago Móvil adelantado US\$25\.00 a \+58412\*\*\*4567\. 3 cuotas de US\$8\.75 \(com\. 5%\)\. Cupo restante US\$25\.00\. Ref MOCK-[0-9A-F]{8}$/);
    assert.ok(res.text.length <= 180, `${res.text.length} caracteres`);

    const after = await credit(app, phone);
    assert.deepEqual([after.used_cents, after.available_cents], [2500, 2500]);
    const [tx] = after.transactions;
    assert.deepEqual([tx.kind, tx.amount_cents, tx.fee_cents, tx.total_cents, tx.destination, tx.concept], ['pagar', 2500, 125, 2625, '+58412***4567', 'medicinas']);
    assert.deepEqual(tx.schedule.map((s) => s.amount_cents), [875, 875, 875]);
    assert.deepEqual(tx.schedule.map((s) => s.due_at - tx.created_at), [14, 28, 42].map((d) => d * 86400));
    assert.equal(res.text.endsWith(`Ref ${tx.ref}`), true);
  } finally { app.close(); }
});

test('recargar_saldo con teléfono usa el mismo cupo y deja el operador en el recibo', async () => {
  const { app, phone, cmd } = await setup();
  try {
    await cmd('pagar', 1, { ...PAGO, monto: 20 });
    await cmd('recargar_saldo', 2, { ...RECARGA, monto: 10, moneda: 'usd' });
    const res = await results(app, phone);
    assert.deepEqual(res.map((r) => [r.ref, r.status]), [[1, 0], [2, 0]]);
    assert.match(res[1].text, /^\[MOCK\] Recarga adelantada US\$10\.00 a Movistar \+58414\*\*\*4321\. 3 cuotas de US\$3\.50 \(com\. 5%\)\. Cupo restante US\$20\.00\. Ref MOCK-/);
    assert.ok(res[1].text.length <= 180);
    const c = await credit(app, phone);
    assert.deepEqual([c.used_cents, c.available_cents, c.transactions.map((t) => t.kind)], [3000, 2000, ['recargar_saldo', 'pagar']]);
  } finally { app.close(); }
});

test('cupo insuficiente: se rechaza con el disponible, no se descuenta nada y un monto menor sí pasa', async () => {
  const { app, phone, cmd } = await setup();
  try {
    await cmd('pagar', 1, { ...PAGO, monto: 40 });
    await cmd('pagar', 2, { ...PAGO, monto: 10.01 });
    await cmd('recargar_saldo', 3, { ...RECARGA, monto: 50 });
    await cmd('pagar', 4, { ...PAGO, monto: 10 });
    const res = await results(app, phone);
    assert.deepEqual(res.map((r) => [r.ref, r.status]), [[1, 0], [2, 1], [3, 1], [4, 0]]);
    assert.equal(res[1].text, 'Cupo insuficiente: disponible US$10.00');
    assert.match(res[3].text, /Cupo restante US\$0\.00/);
    assert.deepEqual((await credit(app, phone)).transactions.map((t) => t.amount_cents), [1000, 4000]);
    assert.equal((await credit(app, phone)).available_cents, 0);
  } finally { app.close(); }
});

test('idempotencia: repetir el ref no vuelve a cobrar ni a responder', async () => {
  const { app, phone, cmd } = await setup();
  try {
    await cmd('pagar', 7, { ...PAGO, monto: 30 });
    await cmd('pagar', 7, { ...PAGO, monto: 30 });
    await cmd('pagar', 7, { ...PAGO, monto: 5, banco: 'Otro' });
    assert.equal((await results(app, phone)).length, 1);
    const c = await credit(app, phone);
    assert.deepEqual([c.used_cents, c.transactions.length], [3000, 1]);
    assert.equal(app.store.countCommandsSince(phone.senderId, 0), 1);
    // un rechazo también queda fijado por su ref: reintentarlo con un monto válido no lo ejecuta
    await cmd('pagar', 8, { ...PAGO, monto: 99 });
    await cmd('pagar', 8, { ...PAGO, monto: 1 });
    assert.deepEqual((await results(app, phone)).map((r) => [r.ref, r.status]), [[7, 0], [8, 1]]);
    assert.equal((await credit(app, phone)).used_cents, 3000);
  } finally { app.close(); }
});

test('un adelanto que supera el tope diario de monto no consume cupo', async () => {
  const { app, phone, cmd } = await setup({ CMD_MAX_AMOUNT_PER_DAY: '20' });
  try {
    await cmd('pagar', 1, { ...PAGO, monto: 30 });
    await cmd('pagar', 2, { ...PAGO, monto: 15 });
    const res = await results(app, phone);
    assert.deepEqual(res.map((r) => [r.ref, r.status]), [[1, 1], [2, 0]]);
    assert.match(res[0].text, /Tope diario de monto/);
    assert.equal((await credit(app, phone)).used_cents, 1500);
  } finally { app.close(); }
});

test('con la bandera apagada no se ejecuta ni se toca el cupo; los usuarios no comparten línea', async () => {
  const off = await setup({ FEATURE_PAYMENTS: 'false' });
  try {
    await off.cmd('pagar', 1, { ...PAGO, monto: 10 });
    assert.deepEqual((await results(off.app, off.phone)).map((r) => [r.ref, r.status]), [[1, 3]]);
    const c = await credit(off.app, off.phone);
    assert.deepEqual([c.enabled, c.used_cents, c.transactions.length], [false, 0, 0]);
  } finally { off.app.close(); }

  const { app, phone, cmd } = await setup();
  try {
    const other = makePhone(app, 'otro-usuario');
    await other.register([]);
    await cmd('pagar', 1, { ...PAGO, monto: 45 });
    assert.equal((await credit(app, other)).available_cents, 5000);
    const run = decideCommand(app.ctx, { senderId: other.senderId, incidentId: other.incidentId, cmd: 'pagar', ref: 1, args: { ...PAGO, monto: 45 } });
    assert.equal(run.status, 0);
    assert.equal((await credit(app, phone)).available_cents, 500);
  } finally { app.close(); }
});

test('argumentos de Pago Móvil inválidos se rechazan con su motivo y no gastan cupo', async () => {
  const { app, phone } = await setup();
  try {
    let ref = 0;
    const run = (cmd, args) => decideCommand(app.ctx, { senderId: phone.senderId, incidentId: phone.incidentId, cmd, ref: (ref += 1), args });
    const pay = (over) => run('pagar', { ...PAGO, monto: 5, ...over });
    const rejected = (r, re) => { assert.equal(r.status, 1, r.text); assert.match(r.text, re); };

    rejected(pay({ telefono: '12345' }), /telefono inválido/);
    rejected(pay({ telefono: '0212-1234567' }), /telefono inválido/);
    rejected(pay({ telefono: 4121234567 }), /telefono inválido/);
    rejected(pay({ telefono: undefined, destino: undefined }), /telefono inválido/);
    rejected(pay({ banco: '' }), /banco inválido/);
    rejected(pay({ banco: undefined }), /banco inválido/);
    rejected(pay({ cedula: 'abc' }), /cedula inválida/);
    rejected(pay({ concepto: undefined }), /concepto inválido/);
    rejected(pay({ beneficiario: '  ' }), /beneficiario inválido/);
    rejected(pay({ monto: '5' }), /monto inválido/);
    rejected(pay({ monto: 0.001 }), /monto inválido/);
    rejected(pay({ moneda: 'VES' }), /solo USD/);
    rejected(pay({ moneda: 5 }), /moneda inválida/);
    rejected(pay({ cuotas: 4 }), /solo 3 cuotas/);
    rejected(run('recargar_saldo', { operador: 5, telefono: '0412-1234567', monto: 5 }), /operador inválido/);
    rejected(run('recargar_saldo', { operador: 'Digitel', monto: 5, cuotas: 3 }), /telefono inválido/);
    assert.equal((await credit(app, phone)).used_cents, 0);

    assert.equal(pay({ telefono: '+58 412 1234567', cuotas: 3, cedula: undefined, beneficiario: 'Farmacia' }).status, 0);
    assert.equal(pay({ telefono: undefined, destino: '584141234567', moneda: 'usd' }).status, 0);
    assert.equal(pay({ telefono: '+1 305 555 0100' }).status, 0, 'E.164 con «+» de otro país');
    assert.equal((await credit(app, phone)).used_cents, 1500);
  } finally { app.close(); }
});

test('los argumentos de siempre siguen siendo el mock plano: sin cupo, sin cuotas', async () => {
  const { app, phone, cmd } = await setup();
  try {
    await cmd('pagar', 1, { beneficiario: 'Farmacia Demo', monto: 25.5, moneda: 'USD', concepto: 'medicinas' });
    await cmd('pagar', 2, { beneficiario: 'Mayorista', monto: 5000, moneda: 'EUR', concepto: 'x' });
    await cmd('recargar_saldo', 3, { operador: 'Movilnet', monto: 10, moneda: 'usd' });
    const res = await results(app, phone);
    assert.deepEqual(res.map((r) => r.status), [0, 0, 0]);
    assert.match(res[0].text, /^\[MOCK\] Pago simulado de 25.5 USD a Farmacia Demo \(medicinas\)\. Ref MOCK-/);
    assert.match(res[2].text, /^\[MOCK\] Recarga simulada de 10 USD a Movilnet\. Ref MOCK-/);
    const c = await credit(app, phone);
    assert.deepEqual([c.used_cents, c.transactions.length], [0, 0]);
  } finally { app.close(); }
});

test('comprobante por WhatsApp al destinatario: normaliza 0412…, es best-effort y solo sale por un canal real', async () => {
  const sent = [];
  const channels = { ...fakeChannels(), sms: { name: 'sms', live: true, async send(m) { sent.push(m); return { state: 'sent', detail: 'test' }; } } };
  const live = await setup({}, { channels });
  try {
    await live.cmd('pagar', 1, { ...PAGO, monto: 12.5, concepto: 'agua\nmineral' });
    await live.cmd('recargar_saldo', 2, { ...RECARGA, monto: 5 });
    await live.app.ctx.idle();
    assert.deepEqual(sent.map((m) => m.to), ['584121234567', '584147654321']);
    assert.match(sent[0].text, /^Meshy: Usuario Demo te envió un Pago Móvil adelantado de US\$12\.50 \(agua mineral\)\. Ref MOCK-[0-9A-F]{8}\. Es una simulación/);
    assert.match(sent[1].text, /^Meshy: se simuló una recarga de US\$5\.00 \(Movistar\) a tu línea\. Ref MOCK-/);
    assert.equal(sent[0].kind, 'message');
    assert.equal(sent[0].text.includes('\n'), false);
    // lo pagado por ref repetido no se avisa dos veces
    await live.cmd('pagar', 1, { ...PAGO, monto: 12.5 });
    await live.app.ctx.idle();
    assert.equal(sent.length, 2);
    // un rechazo no avisa a nadie
    await live.cmd('pagar', 3, { ...PAGO, monto: 500 });
    await live.app.ctx.idle();
    assert.equal(sent.length, 2);
  } finally { live.app.close(); }

  const failing = await setup({}, { channels: { ...fakeChannels(), sms: { name: 'sms', live: true, async send() { throw new Error('Kapso caído'); } } } });
  try {
    await failing.cmd('pagar', 1, { ...PAGO, monto: 10 });
    await failing.app.ctx.idle();
    assert.deepEqual((await results(failing.app, failing.phone)).map((r) => r.status), [0]);
    assert.equal((await credit(failing.app, failing.phone)).used_cents, 1000);
  } finally { failing.app.close(); }

  const simulated = await setup();
  try {
    await simulated.cmd('pagar', 1, { ...PAGO, monto: 10 });
    await simulated.app.ctx.idle();
    assert.equal(simulated.app.channels.sent.length, 0, 'canal simulado: no se escribe a nadie');
  } finally { simulated.app.close(); }
});

test('el panel ve el pago: evento command con recibo y estado del crédito en el detalle del incidente', async () => {
  const { app, phone, cmd } = await setup();
  try {
    await phone.egress(phone.packet({ ...sosFields, plaintext: sosPlaintext({ mask: 0, channels: 0 }) }));
    await cmd('pagar', 1, { ...PAGO, monto: 25 });
    await cmd('pagar', 2, { ...PAGO, monto: 99 });
    const detail = await app.call('GET', `/v1/incidents/${phone.senderId}/${phone.incidentId}`);
    assert.equal(detail.status, 200);
    const commands = detail.json.events.filter((e) => e.kind === 'command');
    assert.equal(commands.length, 2);
    assert.deepEqual(commands[0].data.receipt, {
      kind: 'pagar', ref: commands[0].data.receipt.ref, amount_cents: 2500, fee_cents: 125, installments: 3, installment_cents: 875,
      available_cents: 2500, destination: '+58412***4567', concept: 'medicinas',
    });
    assert.match(commands[0].data.receipt.ref, /^MOCK-[0-9A-F]{8}$/);
    assert.equal(commands[0].data.status, 0);
    assert.match(commands[0].data.text, /^\[MOCK\] Pago Móvil adelantado/);
    assert.deepEqual([commands[1].data.status, commands[1].data.receipt, commands[1].data.text], [1, undefined, 'Cupo insuficiente: disponible US$25.00']);
    assert.deepEqual([detail.json.credit.used_cents, detail.json.credit.available_cents], [2500, 2500]);
    assert.equal(detail.json.credit.transactions[0].ref, commands[0].data.receipt.ref);
  } finally { app.close(); }
});

test('/v1/credit/:sender_id: 404 sin usuario, protegido por DASHBOARD_TOKEN y con cupo configurable', async () => {
  const { app, phone, cmd } = await setup({ DASHBOARD_TOKEN: 'panel', CREDIT_LIMIT_CENTS: '2000', CREDIT_FEE_BPS: '0' });
  try {
    const auth = { authorization: 'Bearer panel' };
    assert.equal((await app.call('GET', `/v1/credit/${phone.senderId}`)).status, 401);
    assert.equal((await app.call('GET', '/v1/credit/ffffffffffffffff', undefined, auth)).status, 404);
    await cmd('pagar', 1, { ...PAGO, monto: 15 });
    const c = (await app.call('GET', `/v1/credit/${phone.senderId}`, undefined, auth)).json;
    assert.deepEqual([c.enabled, c.limit_cents, c.used_cents, c.available_cents, c.fee_bps], [true, 2000, 1500, 500, 0]);
    assert.deepEqual(c.transactions[0].schedule.map((s) => s.amount_cents), [500, 500, 500]);
    const [res] = await results(app, phone);
    assert.match(res.text, /3 cuotas de US\$5\.00 \(com\. 0%\)\. Cupo restante US\$5\.00/);
    const nodetail = await app.call('GET', `/v1/incidents/${phone.senderId}/${phone.incidentId}`, undefined, auth);
    assert.equal(nodetail.status, 404, 'sin SOS no hay incidente que detallar');
  } finally { app.close(); }
});
