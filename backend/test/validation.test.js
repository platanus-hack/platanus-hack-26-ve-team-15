// Validaciones de entrada: cada cláusula de cada guarda se prueba por separado (los tests de mutación
// exigen que `a || b` falle cuando solo `a` o solo `b` es cierta).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { decodePacket, verifyPacket } from '../src/codec.js';
import { registrarIncidente } from '../src/agent.js';
import { decideCommand } from '../src/commands.js';
import { HttpError } from '../src/http.js';
import { startApp, makePhone, sosFields } from './helpers.js';

const ok = { packet_b64: 'AAAA', rx: { envelope_ttl: 7, egress_id: 'e1' } };
const egressError = async (app, body) => (await app.call('POST', '/v1/egress', body)).json?.error;

test('verifyPacket: una llave pública mal formada devuelve false en vez de lanzar', async () => {
  const app = await startApp();
  try {
    const phone = makePhone(app);
    const pkt = decodePacket(phone.packet({ ...sosFields }));
    assert.equal(verifyPacket(pkt, Buffer.alloc(5)), false);
    assert.equal(verifyPacket(pkt, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)), false);
    assert.equal(verifyPacket(pkt, phone.signPk), true);
  } finally { app.close(); }
});

test('POST /v1/egress: cada campo mal formado da su propio mensaje de 400', async () => {
  const app = await startApp();
  try {
    assert.equal(await egressError(app, 'null'), 'body must be a JSON object');
    assert.equal(await egressError(app, '"texto"'), 'body must be a JSON object');
    assert.equal(await egressError(app, '5'), 'body must be a JSON object');
    assert.equal(await egressError(app, { ...ok, packet_b64: 5 }), 'packet_b64 required');
    assert.equal(await egressError(app, { ...ok, packet_b64: '' }), 'packet_b64 required');
    assert.equal(await egressError(app, { ...ok, packet_b64: 'AAA' }), 'packet_b64 is not valid base64', 'largo no múltiplo de 4');
    assert.equal(await egressError(app, { ...ok, packet_b64: 'AA%A' }), 'packet_b64 is not valid base64', 'largo ok, carácter inválido');
    assert.equal(await egressError(app, { ...ok, rx: undefined }), 'rx required');
    assert.equal(await egressError(app, { ...ok, rx: 'e1' }), 'rx required');
    assert.equal(await egressError(app, { ...ok, rx: { envelope_ttl: 7, egress_id: 5 } }), 'rx.egress_id required');
    assert.equal(await egressError(app, { ...ok, rx: { envelope_ttl: 7, egress_id: '' } }), 'rx.egress_id required');
    assert.equal(await egressError(app, { ...ok, rx: { envelope_ttl: 7, egress_id: 'e'.repeat(65) } }), 'rx.egress_id required');
    assert.equal(await egressError(app, { ...ok, rx: { envelope_ttl: 256, egress_id: 'e' } }), 'rx.envelope_ttl must be 0..255');
    assert.equal(await egressError(app, { ...ok, rx: { envelope_ttl: -1, egress_id: 'e' } }), 'rx.envelope_ttl must be 0..255');
    assert.equal(await egressError(app, { ...ok, rx: { envelope_ttl: 1.5, egress_id: 'e' } }), 'rx.envelope_ttl must be 0..255');
    // egress_id de 64 caracteres y ttl 0 y 255 sí pasan la forma (fallan después, por el paquete)
    for (const ttl of [0, 255]) assert.notEqual(await egressError(app, { ...ok, rx: { envelope_ttl: ttl, egress_id: 'e'.repeat(64) } }), 'rx.envelope_ttl must be 0..255');
  } finally { app.close(); }
});

test('POST /v1/egress/presence: cuerpo no objeto y cada campo inválido', async () => {
  const app = await startApp();
  try {
    const err = async (body) => (await app.call('POST', '/v1/egress/presence', body)).json?.error;
    assert.equal(await err('null'), 'body must be a JSON object');
    assert.equal(await err('"x"'), 'body must be a JSON object');
    assert.equal(await err({ egress_id: 5, cell: 'u4pruy', valid_s: 60 }), 'egress_id required');
    assert.equal(await err({ egress_id: '', cell: 'u4pruy', valid_s: 60 }), 'egress_id required');
    assert.equal(await err({ egress_id: 'x'.repeat(65), cell: 'u4pruy', valid_s: 60 }), 'egress_id required');
    assert.equal(await err({ egress_id: 'a', cell: 5, valid_s: 60 }), 'cell must be a 6-char geohash');
    assert.equal(await err({ egress_id: 'a', cell: 'u4pru', valid_s: 60 }), 'cell must be a 6-char geohash');
    assert.equal(await err({ egress_id: 'a', cell: 'u4pruy', valid_s: 0 }), 'valid_s must be 1..300');
    assert.equal(await err({ egress_id: 'a', cell: 'u4pruy', valid_s: 301 }), 'valid_s must be 1..300');
    assert.equal(await err({ egress_id: 'a', cell: 'u4pruy', valid_s: 1.5 }), 'valid_s must be 1..300');
    assert.equal((await app.call('POST', '/v1/egress/presence', { egress_id: 'a', cell: 'u4pruy', valid_s: 300 })).status, 204);
    assert.equal((await app.call('POST', '/v1/egress/presence', { egress_id: 'a', cell: 'u4pruy', valid_s: 1 })).status, 204);
  } finally { app.close(); }
});

test('POST /v1/mailbox/poll: cada consulta mal formada da 400 con su motivo', async () => {
  const app = await startApp();
  try {
    const poll = async (body) => app.call('POST', '/v1/mailbox/poll', body);
    const bad = (r) => { assert.equal(r.status, 400); return r.json.error; };
    assert.equal(bad(await poll('null')), 'queries[] required');
    assert.equal(bad(await poll('"x"')), 'queries[] required');
    assert.equal(bad(await poll({})), 'queries[] required');
    assert.equal(bad(await poll({ queries: 'x' })), 'queries[] required');
    assert.equal(bad(await poll({ queries: Array(51).fill({ sender_id: 'a'.repeat(16), incident_ids: [] }) })), 'at most 50 queries');
    const q = (x) => ({ queries: [x] });
    const msg = 'each query needs a 16-hex sender_id and incident_ids[]';
    assert.equal(bad(await poll({ queries: [null] })), msg);
    assert.equal(bad(await poll(q({ incident_ids: [] }))), msg, 'sin sender_id');
    assert.equal(bad(await poll(q({ sender_id: 'zz'.repeat(8), incident_ids: [] }))), msg, 'sender_id no hex');
    assert.equal(bad(await poll(q({ sender_id: 'a'.repeat(16), incident_ids: 'x' }))), msg, 'incident_ids no es lista');
    assert.equal(bad(await poll(q({ sender_id: 'a'.repeat(16), incident_ids: Array(51).fill('a'.repeat(16)) }))), msg, 'demasiados ids');
    assert.equal(bad(await poll(q({ sender_id: 'a'.repeat(16), incident_ids: ['a'.repeat(16), 'nope'] }))), msg, 'un id no hex');
    assert.equal((await poll(q({ sender_id: 'a'.repeat(16), incident_ids: Array(50).fill('a'.repeat(16)) }))).status, 200);
  } finally { app.close(); }
});

// --- registrar_incidente (esquema de la herramienta) ------------------------------------------------

const baseArgs = (phone) => ({ sender_id: phone.senderId, incident_id: phone.incidentId, category: 1, severity: 2, lat: 1049700, lon: -6685300,
  accuracy_m: 10, location_age_s: 2, public_text: 'hola' });

test('registrar_incidente: valida cada argumento contra el esquema', async () => {
  const app = await startApp();
  try {
    const phone = makePhone(app);
    const err = (patch) => { try { registrarIncidente(app.ctx, { ...baseArgs(phone), ...patch }); } catch (e) { assert.ok(e instanceof HttpError); return e.message; } return 'sin error'; };
    assert.match(err({ category: 8 }), /category must be an integer 0\.\.7/);
    assert.match(err({ category: -1 }), /category must be an integer/);
    assert.match(err({ category: 1.5 }), /category must be an integer/);
    assert.match(err({ category: '1' }), /category must be an integer/);
    assert.match(err({ severity: 4 }), /severity must be an integer 0\.\.3/);
    assert.match(err({ accuracy_m: 65536 }), /accuracy_m/);
    assert.match(err({ public_text: 5 }), /public_text must be a string up to 120/);
    assert.match(err({ public_text: 'x'.repeat(121) }), /public_text must be a string up to 120/);
    assert.match(err({ nota: 'x'.repeat(401) }), /nota must be a string up to 400/);
    assert.match(err({ sender_id: 5 }), /sender_id must be a string/);
    assert.match(err({ sender_id: 'g'.repeat(16) }), /ids must be 16 hex chars/);
    assert.match(err({ incident_id: 'abc' }), /ids must be 16 hex chars/);
    assert.equal(err({}), 'sin error');
    assert.equal(err({ category: 0, severity: 0, accuracy_m: 65535, public_text: 'x'.repeat(120) }), 'sin error', 'los límites son inclusivos');
  } finally { app.close(); }
});

test('registrar_incidente: ubicación solo si lat Y lon son enteros; blob_readable por defecto 0', async () => {
  const app = await startApp();
  try {
    const a = makePhone(app, 'loc-a');
    registrarIncidente(app.ctx, { ...baseArgs(a), lon: null });
    let row = app.store.getIncident(a.senderId, a.incidentId);
    assert.equal(row.lat, null);
    assert.equal(row.lon, null);
    assert.equal(row.blob_readable, 0);

    const b = makePhone(app, 'loc-b');
    registrarIncidente(app.ctx, { ...baseArgs(b), lat: null });
    row = app.store.getIncident(b.senderId, b.incidentId);
    assert.equal(row.lat, null);
    assert.equal(row.lon, null);

    const c = makePhone(app, 'loc-c');
    registrarIncidente(app.ctx, baseArgs(c), { blobReadable: true });
    assert.equal(app.store.getIncident(c.senderId, c.incidentId).blob_readable, 1);
  } finally { app.close(); }
});

test('registrar_incidente: la actualización respeta hops (0 cuenta), ubicación previa y reabre un incidente cerrado', async () => {
  const app = await startApp();
  try {
    const p = makePhone(app, 'upd');
    const row = () => app.store.getIncident(p.senderId, p.incidentId);
    assert.equal(registrarIncidente(app.ctx, baseArgs(p), { hops: 3, seq: 1 }).creado, true);
    assert.equal(row().hops, 3);
    assert.equal(registrarIncidente(app.ctx, { ...baseArgs(p), lat: null, lon: null }, { seq: 2 }).creado, false);
    assert.equal(row().hops, 3, 'sin hops en meta se conserva');
    assert.equal(row().lat, 1049700, 'sin ubicación nueva se conserva la anterior');
    registrarIncidente(app.ctx, baseArgs(p), { hops: null, seq: 3 });
    assert.equal(row().hops, 3, 'hops null no pisa');
    registrarIncidente(app.ctx, baseArgs(p), { hops: 0, seq: 4 });
    assert.equal(row().hops, 0, 'hops 0 es un valor válido');
    assert.equal(row().last_seq, 4);
    registrarIncidente(app.ctx, { ...baseArgs(p), severity: 0 }, { seq: 5 });
    assert.equal(row().status, 'closed');
    registrarIncidente(app.ctx, { ...baseArgs(p), severity: 2 }, { seq: 6 });
    assert.equal(row().status, 'open', 'una baliza posterior con severidad > 0 lo reabre');
  } finally { app.close(); }
});

// --- argumentos de los CMD (mocks) --------------------------------------------------------------------

test('CMD: cada argumento inválido se rechaza (status 1) con su motivo; los límites válidos pasan', async () => {
  const app = await startApp({ env: { FEATURE_PAYMENTS: 'true', FEATURE_RIDES: 'true', CMD_MAX_PER_DAY: '1000', CMD_MAX_AMOUNT_PER_DAY: '1000000' } });
  try {
    const phone = makePhone(app);
    let ref = 0;
    const run = (cmd, args) => decideCommand(app.ctx, { senderId: phone.senderId, incidentId: phone.incidentId, cmd, ref: (ref += 1), args });
    const pay = (over) => run('pagar', { beneficiario: 'B', monto: 5, moneda: 'USD', concepto: 'c', ...over });
    const rejected = (r, re) => { assert.equal(r.status, 1, r.text); assert.match(r.text, re); };

    rejected(pay({ beneficiario: 5 }), /beneficiario inválido/);
    rejected(pay({ beneficiario: '   ' }), /beneficiario inválido/);
    rejected(pay({ beneficiario: 'x'.repeat(81) }), /beneficiario inválido/);
    rejected(pay({ monto: '5' }), /monto inválido/);
    rejected(pay({ monto: 0 }), /monto inválido/);
    rejected(pay({ monto: -1 }), /monto inválido/);
    rejected(pay({ monto: 100_001 }), /monto inválido/);
    rejected(pay({ moneda: 5 }), /moneda inválida/);
    rejected(pay({ moneda: 'US' }), /moneda inválida/);
    rejected(pay({ moneda: 'USDT' }), /moneda inválida/);
    rejected(pay({ concepto: undefined }), /concepto inválido/);
    assert.equal(pay({ beneficiario: 'x'.repeat(80), monto: 100_000, moneda: 'eur' }).status, 0, 'límites inclusivos');

    const delivery = (over) => run('pedir_delivery', { comercio: 'C', direccion: 'D', articulos: ['a'], ...over });
    rejected(delivery({ articulos: 'a' }), /articulos inválidos/);
    rejected(delivery({ articulos: [] }), /articulos inválidos/);
    rejected(delivery({ articulos: Array(11).fill('a') }), /articulos inválidos/);
    rejected(delivery({ articulos: [5] }), /articulo inválido/);
    rejected(delivery({ comercio: '' }), /comercio inválido/);
    rejected(delivery({ direccion: 'x'.repeat(121) }), /direccion inválido/);
    assert.equal(delivery({ articulos: Array(10).fill('a') }).status, 0);
    rejected(run('pedir_ride', { destino: 'D', modo: 'x'.repeat(21) }), /modo inválido/);
    rejected(run('recargar_saldo', { operador: 5, monto: 5, moneda: 'USD' }), /operador inválido/);
    assert.equal(run('pedir_ride', { destino: 'D' }).status, 0, 'modo es opcional');
    rejected(run('consultar_alertas', {}), /sin ubicación/);
  } finally { app.close(); }
});
