import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MSG, decodePacket } from '../src/codec.js';
import { geohashBounds, geohashEncode, radioTick, searchCircle, selectEgress } from '../src/radio.js';
import { startApp, makePhone, sosPlaintext, sosFields } from './helpers.js';

// Celdas de ~1,2 km × 0,6 km cerca de (10.497, -66.853) y una lejana (Madrid).
const HERE = geohashEncode(10.497, -66.853, 6);
const NEXT = geohashEncode(10.5, -66.853, 6);
const FAR = geohashEncode(40.4168, -3.7038, 6);

test('geohash: codifica y la celda contiene el punto', () => {
  assert.equal(geohashEncode(57.64911, 10.40744, 11), 'u4pruydqqvj');
  const b = geohashBounds(HERE);
  assert.ok(b.latMin <= 10.497 && 10.497 <= b.latMax && b.lonMin <= -66.853 && -66.853 <= b.lonMax);
});

test('radio de búsqueda = clamp(accuracy + 2 m/s × t, 300 m, 5 km)', () => {
  const inc = { lat: 1049700, lon: -6685300, accuracy_m: 12, loc_timestamp: 1000, updated_at: 1000 };
  assert.equal(searchCircle(inc, 1000).radius, 300);
  assert.equal(searchCircle(inc, 1100).radius, 300, '12 + 200 = 212 sube al mínimo');
  assert.equal(searchCircle(inc, 1000 + 600).radius, 12 + 1200);
  assert.equal(searchCircle(inc, 1000 + 100000).radius, 5000);
  assert.equal(searchCircle({ ...inc, lat: null }, 1000), null);
});

async function setupWithIncident() {
  const app = await startApp();
  const phone = makePhone(app);
  await phone.register();
  await phone.egress(phone.packet({ ...sosFields, plaintext: sosPlaintext({ mask: 1, channels: 1 }) }), { egressId: 'egress-uploader' });
  await app.ctx.idle();
  return { app, phone };
}

const presence = (app, id, cell) => app.call('POST', '/v1/egress/presence', { egress_id: id, cell, valid_s: 90 });

test('presencia: valida celda y vigencia; 204 si es correcta', async () => {
  const { app } = await setupWithIncident();
  try {
    assert.equal((await presence(app, 'z1', HERE)).status, 204);
    assert.equal((await presence(app, 'z1', 'aaaaaaa')).status, 400);
    assert.equal((await presence(app, 'z1', 'ailoo!')).status, 400);
    assert.equal((await app.call('POST', '/v1/egress/presence', { egress_id: 'z1', cell: HERE, valid_s: 9999 })).status, 400);
    assert.equal((await app.call('POST', '/v1/egress/presence', { cell: HERE, valid_s: 90 })).status, 400);
  } finally { app.close(); }
});

test('selección: el que subió el SOS (si sigue conectado) + los 5 más cercanos dentro del radio; los lejanos no', async () => {
  const { app, phone } = await setupWithIncident();
  try {
    await presence(app, 'egress-uploader', FAR); // subió el SOS pero ahora está lejos; sigue conectado
    await presence(app, 'near-a', HERE);
    await presence(app, 'near-b', NEXT);
    for (let i = 0; i < 6; i += 1) await presence(app, `crowd-${i}`, HERE);
    await presence(app, 'far-away', FAR);
    const inc = app.store.getIncident(phone.senderId, phone.incidentId);
    const chosen = selectEgress(app.ctx, inc);
    assert.ok(chosen.includes('egress-uploader'));
    assert.ok(!chosen.includes('far-away'));
    assert.equal(chosen.filter((c) => c !== 'egress-uploader').length, 5);
    app.clock.t += 91;
    assert.deepEqual(selectEgress(app.ctx, inc), [], 'la presencia expira a los valid_s');
  } finally { app.close(); }
});

test('R5: la respuesta tardía llega por el inbox de un egress distinto del que subió el SOS', async () => {
  const { app, phone } = await setupWithIncident();
  try {
    await presence(app, 'egress-z', HERE);
    const link = app.channels.sent[0].text.match(/\/r\/([\w.-]+)/)[1];
    await app.call('POST', '/v1/replies', { token: link, text: 'Voy para alla' });

    const inbox = await app.call('GET', '/v1/egress/inbox?egress_id=egress-z&wait=0');
    assert.equal(inbox.status, 200);
    const types = inbox.json.messages.map((m) => m.msg_type);
    assert.deepEqual(types, [MSG.MSG_IN], 'los ACK ya estaban en el buzón antes de que hubiera un egress cercano');
    assert.ok(inbox.json.messages.every((m) => m.incident_id === phone.incidentId));
    const again = await app.call('GET', '/v1/egress/inbox?egress_id=egress-z&wait=0');
    assert.deepEqual(again.json.messages, [], 'lo entregado sale de la cola');

    // Un egress sin presencia no recibe nada.
    const none = await app.call('GET', '/v1/egress/inbox?egress_id=nadie&wait=0');
    assert.deepEqual(none.json.messages, []);
  } finally { app.close(); }
});

test('R5: el long-poll despierta cuando llega un mensaje para ese egress', async () => {
  const { app } = await setupWithIncident();
  try {
    await presence(app, 'egress-z', HERE);
    await app.call('GET', '/v1/egress/inbox?egress_id=egress-z&wait=0'); // vacía lo pendiente
    const link = app.channels.sent[0].text.match(/\/r\/([\w.-]+)/)[1];
    const waiting = app.call('GET', '/v1/egress/inbox?egress_id=egress-z&wait=5');
    setTimeout(() => app.call('POST', '/v1/replies', { token: link, text: 'hola' }), 100);
    const t0 = Date.now();
    const r = await waiting;
    assert.equal(r.json.messages.length, 1);
    assert.equal(r.json.messages[0].msg_type, MSG.MSG_IN);
    assert.ok(Date.now() - t0 < 3000);
  } finally { app.close(); }
});

test('R5: el servidor repite el envío cada tick hasta que el rx_cursor del origen lo cubre', async () => {
  const { app, phone } = await setupWithIncident();
  try {
    const link = app.channels.sent[0].text.match(/\/r\/([\w.-]+)/)[1];
    await app.call('POST', '/v1/replies', { token: link, text: 'uno' }); // srv_seq 1, sin egress cercano todavía
    await presence(app, 'egress-z', HERE);
    assert.equal(radioTick(app.ctx), 1, 'al aparecer un egress cercano, el tick lo empuja');
    const first = await app.call('GET', '/v1/egress/inbox?egress_id=egress-z&wait=0');
    assert.equal(first.json.messages.filter((m) => m.msg_type === MSG.MSG_IN).length, 1);

    assert.equal(radioTick(app.ctx), 1, 'sin recibo, se repite');
    // La baliza trae rx_cursor = 1: recibo del origen.
    await phone.egress(phone.packet({ msgType: MSG.UPDATE, seq: 2, ...sosFields, plaintext: sosPlaintext({ rxCursor: 1, note: 'ok' }) }));
    assert.equal(radioTick(app.ctx), 0, 'cubierto por rx_cursor: se detiene');
    const after = await app.call('GET', '/v1/egress/inbox?egress_id=egress-z&wait=0');
    assert.deepEqual(after.json.messages.filter((m) => m.msg_type === MSG.MSG_IN), [], 'ni siquiera lo ya encolado se entrega');

    await app.call('POST', '/v1/replies', { token: link, text: 'dos' }); // srv_seq 2: aún sin recibo
    assert.equal(radioTick(app.ctx), 1);
  } finally { app.close(); }
});

test('R5: un mensaje pasado el 24 h de retención deja de empujarse', async () => {
  const { app } = await setupWithIncident();
  try {
    const link = app.channels.sent[0].text.match(/\/r\/([\w.-]+)/)[1];
    await app.call('POST', '/v1/replies', { token: link, text: 'uno' });
    app.clock.t += 24 * 3600 + 5;
    await presence(app, 'egress-z', HERE);
    assert.equal(radioTick(app.ctx), 0);
  } finally { app.close(); }
});

test('los paquetes del inbox son los mismos firmados que ve el buzón', async () => {
  const { app, phone } = await setupWithIncident();
  try {
    await presence(app, 'egress-z', HERE);
    const link = app.channels.sent[0].text.match(/\/r\/([\w.-]+)/)[1];
    await app.call('POST', '/v1/replies', { token: link, text: 'hola' });
    const inbox = (await app.call('GET', '/v1/egress/inbox?egress_id=egress-z&wait=0')).json.messages;
    const box = (await app.call('POST', '/v1/mailbox/poll', { queries: [{ sender_id: phone.senderId, incident_ids: [phone.incidentId] }] })).json.messages;
    const a = inbox.find((m) => m.msg_type === MSG.MSG_IN);
    const b = box.find((m) => m.msg_type === MSG.MSG_IN);
    assert.equal(a.packet_b64, b.packet_b64);
    assert.equal(decodePacket(Buffer.from(a.packet_b64, 'base64')).senderId, app.keys.senderId);
  } finally { app.close(); }
});
