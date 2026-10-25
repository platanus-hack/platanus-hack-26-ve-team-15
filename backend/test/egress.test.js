import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MSG, decodePacket, verifyPacket } from '../src/codec.js';
import { startApp, makePhone, sosPlaintext, sosFields, T0 } from './helpers.js';

const examples = JSON.parse(readFileSync(fileURLToPath(new URL('../../docs/examples/examples.json', import.meta.url)), 'utf8'));

async function setup(opts) {
  const app = await startApp(opts);
  const phone = makePhone(app);
  const reg = await phone.register();
  assert.equal(reg.status, 201, reg.text);
  return { app, phone, reg };
}

test('registro: devuelve sender_id, llaves del servidor y contactos pending_verification', async () => {
  const { app, phone, reg } = await setup();
  try {
    assert.equal(reg.json.sender_id, phone.senderId);
    assert.equal(reg.json.server.key_id, 'k1');
    assert.equal(Buffer.from(reg.json.server.sign_pk_b64, 'base64').equals(app.keys.signPk), true);
    assert.deepEqual(reg.json.contacts.map(({ index, status }) => ({ index, status })), [{ index: 0, status: 'pending_verification' }, { index: 1, status: 'pending_verification' }]);
    for (const c of reg.json.contacts) assert.match(c.invite_code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  } finally { app.close(); }
});

test('registro: sin prueba de posesión o con firma ajena → 401; cuerpo alterado → 401', async () => {
  const app = await startApp();
  try {
    const phone = makePhone(app);
    const other = makePhone(app, 'otro-usuario');
    const body = JSON.stringify({ display_name: 'X', sign_pk_b64: phone.signPk.toString('base64'), seal_pk_b64: phone.sealKp.publicKey.toString('base64'), contacts: [] });
    const noHeaders = await app.call('POST', '/v1/users', body);
    assert.equal(noHeaders.status, 401);
    const { createHash, sign } = await import('node:crypto');
    const sigOther = sign(null, createHash('sha256').update(body).digest(), other.privateKey).toString('base64');
    const r = await app.call('POST', '/v1/users', body, { 'x-baliza-pubkey': phone.signPk.toString('base64'), 'x-baliza-signature': sigOther });
    assert.equal(r.status, 401);
    const sigOk = sign(null, createHash('sha256').update(body).digest(), phone.privateKey).toString('base64');
    const tampered = await app.call('POST', '/v1/users', body.replace('"X"', '"Y"'), { 'x-baliza-pubkey': phone.signPk.toString('base64'), 'x-baliza-signature': sigOk });
    assert.equal(tampered.status, 401);
  } finally { app.close(); }
});

test('registro: validaciones de contactos (índice repetido, sin canal)', async () => {
  const app = await startApp();
  try {
    const phone = makePhone(app);
    const dup = await phone.register([{ index: 0, name: 'A', channels: { sms: '1' } }, { index: 0, name: 'B', channels: { sms: '2' } }]);
    assert.equal(dup.status, 400);
    const noChannel = await phone.register([{ index: 2, name: 'A', channels: {} }]);
    assert.equal(noChannel.status, 400);
    const outOfRange = await phone.register([{ index: 32, name: 'A', channels: { sms: '1' } }]);
    assert.equal(outOfRange.status, 400);
  } finally { app.close(); }
});

test('SOS: accepted, ACK firmado por el servidor con seq confirmado y código 2', async () => {
  const { app, phone } = await setup();
  try {
    const pkt = phone.packet({ ...sosFields, plaintext: sosPlaintext() });
    const r = await phone.egress(pkt, { envelopeTtl: 5 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'accepted');
    assert.equal(r.json.incident_id, phone.incidentId);
    assert.equal(r.json.seq, 1);
    const ack = decodePacket(Buffer.from(r.json.ack_packet_b64, 'base64'));
    assert.equal(ack.msgType, MSG.ACK);
    assert.equal(ack.seq, 1);
    assert.equal(ack.category, 2);
    assert.equal(ack.senderId, app.keys.senderId);
    assert.ok(verifyPacket(ack, app.keys.signPk));
    assert.equal(ack.publicText, 'Recibido. El agente gestiona tu caso');
    await app.ctx.idle();
  } finally { app.close(); }
});

test('SOS: crea el incidente con saltos = ttl_interno − ttl_del_sobre', async () => {
  const { app, phone } = await setup();
  try {
    await phone.egress(phone.packet({ ...sosFields, plaintext: sosPlaintext() }), { envelopeTtl: 5 });
    await app.ctx.idle();
    const list = await app.call('GET', '/v1/incidents');
    assert.equal(list.json.incidents.length, 1);
    const i = list.json.incidents[0];
    assert.equal(i.hops, 2);
    assert.equal(i.lat, 10.497);
    assert.equal(i.lon, -66.853);
    assert.equal(i.severity, 3);
    assert.equal(i.category_label, 'médica');
    assert.equal(i.display_name, 'Usuario Demo');
    assert.equal(i.note, 'Persona inconsciente en la plaza');
  } finally { app.close(); }
});

test('reenvío del mismo paquete → duplicate con los mismos bytes de ACK, sin segundo incidente', async () => {
  const { app, phone } = await setup();
  try {
    const pkt = phone.packet({ ...sosFields, plaintext: sosPlaintext() });
    const first = await phone.egress(pkt);
    app.clock.t += 20; // el reloj avanza: un ACK re-firmado cambiaría de bytes
    const second = await phone.egress(pkt, { egressId: 'egress-otro' });
    assert.equal(second.json.status, 'duplicate');
    assert.equal(second.json.ack_packet_b64, first.json.ack_packet_b64);
    await app.ctx.idle();
    assert.equal((await app.call('GET', '/v1/incidents')).json.incidents.length, 1);
    assert.equal(app.channels.sent.length > 0, true);
    const sentBefore = app.channels.sent.length;
    await phone.egress(pkt);
    await app.ctx.idle();
    assert.equal(app.channels.sent.length, sentBefore, 'un duplicado no vuelve a avisar a nadie');
  } finally { app.close(); }
});

test('errores: 400 base64/tamaño/tipo, 404 desconocido, 401 firma, 422 ventana', async () => {
  const { app, phone } = await setup();
  try {
    const post = (body) => app.call('POST', '/v1/egress', body);
    const rx = { envelope_ttl: 7, egress_id: 'e1' };
    assert.equal((await post({ packet_b64: '%%%%', rx })).status, 400);
    assert.equal((await post({ packet_b64: 'AAAA', rx })).status, 400);
    assert.equal((await post({ rx })).status, 400);
    assert.equal((await post({ packet_b64: 'AAAA' })).status, 400);

    // 419 B → 400
    const big = Buffer.alloc(419, 1);
    assert.equal((await post({ packet_b64: big.toString('base64'), rx })).status, 400);

    // tipo que no entra por egress (ACK) → 400
    const ack = phone.packet({ msgType: MSG.ACK, seq: 1 });
    assert.equal((await phone.egress(ack)).status, 400);

    // remitente desconocido → 404
    const stranger = makePhone(app, 'desconocido');
    assert.equal((await stranger.egress(stranger.packet({ ...sosFields }))).status, 404);

    // firma inválida → 401
    const tampered = phone.packet({ ...sosFields });
    tampered[28] ^= 1;
    assert.equal((await phone.egress(tampered)).status, 401);

    // fuera de ventana → 422
    assert.equal((await phone.egress(phone.packet({ ...sosFields, seq: 2, ts: T0 + 30 + 601 }))).status, 422);
    assert.equal((await phone.egress(phone.packet({ ...sosFields, seq: 3, ts: T0 + 30 - 7 * 86400 - 1 }))).status, 422);
    assert.equal((await phone.egress(phone.packet({ ...sosFields, seq: 4, ts: T0 + 30 + 600 }))).status, 200);
    assert.equal((await phone.egress(phone.packet({ ...sosFields, seq: 5, ts: T0 + 30 - 7 * 86400 }))).status, 200);
  } finally { app.close(); }
});

test('429: límite por egress_id y por sender_id', async () => {
  const { app, phone } = await setup({ env: { RATE_EGRESS_PER_MIN: '3', RATE_SENDER_PER_MIN: '100' } });
  try {
    const codes = [];
    for (let seq = 1; seq <= 5; seq += 1) codes.push((await phone.egress(phone.packet({ ...sosFields, seq }))).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  } finally { app.close(); }
  const second = await setup({ env: { RATE_EGRESS_PER_MIN: '100', RATE_SENDER_PER_MIN: '2' } });
  try {
    const codes = [];
    for (let seq = 1; seq <= 4; seq += 1) codes.push((await second.phone.egress(second.phone.packet({ ...sosFields, seq }))).status);
    assert.deepEqual(codes, [200, 200, 429, 429]);
  } finally { second.app.close(); }
});

test('un emisor falso no puede agotar el límite de la víctima (la firma se verifica antes de contar)', async () => {
  const { app, phone } = await setup({ env: { RATE_SENDER_PER_MIN: '2' } });
  try {
    for (let i = 0; i < 5; i += 1) {
      const forged = phone.packet({ ...sosFields, seq: 10 + i });
      forged[28] ^= 1;
      assert.equal((await phone.egress(forged)).status, 401);
    }
    assert.equal((await phone.egress(phone.packet({ ...sosFields, seq: 1 }))).status, 200);
  } finally { app.close(); }
});

test('los paquetes del propio servidor (ACK firmado por él) no se aceptan por egress', async () => {
  const { app } = await setup();
  try {
    const serverAck = app.ctx.signServerPacket({ msgType: MSG.SOS, incidentId: '0a68279fb49bde12', seq: 1, timestamp: T0 + 30 });
    const r = await app.call('POST', '/v1/egress', { packet_b64: serverAck.toString('base64'), rx: { envelope_ttl: 7, egress_id: 'e' } });
    assert.equal(r.status, 400);
  } finally { app.close(); }
});

test('vectores de examples.json: sin registro, el SOS firmado de ejemplo da 404 (y la firma no se evalúa)', async () => {
  const app = await startApp({ now: T0 + 10 });
  try {
    const r = await app.call('POST', '/v1/egress', { packet_b64: examples.packets.SOS.base64, rx: { envelope_ttl: 5, egress_id: 'e' } });
    assert.equal(r.status, 404);
  } finally { app.close(); }
});

test('vectores de examples.json: registrado el usuario sintético, el SOS de ejemplo se acepta (blob de relleno → fallback)', async () => {
  const app = await startApp({ now: T0 + 10 });
  try {
    const { createHash, sign } = await import('node:crypto');
    const phone = makePhone(app, 'baliza-synthetic-user-1');
    assert.equal(phone.senderId, examples.keys.user.sender_id);
    assert.equal((await phone.register()).status, 201);
    const r = await app.call('POST', '/v1/egress', { packet_b64: examples.packets.SOS.base64, rx: { envelope_ttl: 5, egress_id: 'e' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.incident_id, examples.incident_id);
    await app.ctx.idle();
    const events = (await app.call('GET', '/v1/events')).json.events.map((e) => e.kind);
    assert.ok(events.includes('blob_unreadable'));
    // El fallback avisa a todos los contactos por SMS.
    assert.equal(app.channels.sent.filter((m) => m.channel === 'sms').length, 2);
    void createHash; void sign;
  } finally { app.close(); }
});

test('UPDATE: actualiza ubicación y cierra con severity 0; no pide aviso nuevo', async () => {
  const { app, phone } = await setup();
  try {
    await phone.egress(phone.packet({ ...sosFields, plaintext: sosPlaintext() }));
    await app.ctx.idle();
    const sentAfterSos = app.channels.sent.length;
    const upd = phone.packet({ msgType: MSG.UPDATE, seq: 2, ...sosFields, lat: 1049720, lon: -6685315, plaintext: sosPlaintext({ note: 'Sigo aqui' }) });
    const r = await phone.egress(upd);
    assert.equal(decodePacket(Buffer.from(r.json.ack_packet_b64, 'base64')).category, 2);
    const view = (await app.call('GET', `/v1/incidents/${phone.senderId}/${phone.incidentId}`)).json.incident;
    assert.equal(view.lat, 10.4972);
    assert.equal(view.note, 'Sigo aqui');
    const close = await phone.egress(phone.packet({ msgType: MSG.UPDATE, seq: 3, ...sosFields, severity: 0, plaintext: sosPlaintext({ note: 'ya estoy bien' }) }));
    assert.equal(decodePacket(Buffer.from(close.json.ack_packet_b64, 'base64')).category, 0);
    await app.ctx.idle();
    const closed = (await app.call('GET', `/v1/incidents/${phone.senderId}/${phone.incidentId}`)).json.incident;
    assert.equal(closed.status, 'closed');
    assert.equal(app.channels.sent.length, sentAfterSos);
  } finally { app.close(); }
});

test('una baliza que llega antes que el SOS crea el incidente y lanza el agente una sola vez', async () => {
  const { app, phone } = await setup();
  try {
    await phone.egress(phone.packet({ msgType: MSG.UPDATE, seq: 2, ...sosFields, plaintext: sosPlaintext() }));
    await app.ctx.idle();
    const first = app.channels.sent.length;
    assert.ok(first > 0);
    await phone.egress(phone.packet({ msgType: MSG.SOS, seq: 1, ...sosFields, plaintext: sosPlaintext() }));
    await app.ctx.idle();
    assert.equal(app.channels.sent.length, first);
  } finally { app.close(); }
});
