// Pruebas dirigidas por mutación: cada caso fija un comportamiento que un mutante sobreviviente cambiaba.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MSG, decodePacket, verifyDetached } from '../src/codec.js';
import { loadConfig } from '../src/config.js';
import { loadServerKeys, unseal } from '../src/crypto.js';
import { decideCommand } from '../src/commands.js';
import { createRateLimiter } from '../src/limits.js';
import { Store } from '../src/store.js';
import { makeReplyToken, parseReplyToken } from '../src/tokens.js';
import { startApp, makePhone, sosFields, sosPlaintext, signedCall, registerBody } from './helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'baliza-test-'));
const hex32 = (c) => c.repeat(64).slice(0, 64);

async function setup(opts, label) {
  const app = await startApp(opts);
  const phone = makePhone(app, label);
  assert.equal((await phone.register()).status, 201);
  return { app, phone };
}
const sos = async (app, phone, mask = 0b01) => {
  await phone.egress(phone.packet({ ...sosFields, plaintext: sosPlaintext({ mask, channels: 1 }) }));
  await app.ctx.idle();
};

// --- firma y registro ---------------------------------------------------------------------------

test('verifyDetached: false ante llave o firma mal formadas, true con la correcta', async () => {
  const app = await startApp();
  try {
    const phone = makePhone(app);
    const msg = Buffer.from('mensaje');
    const sig = (await import('node:crypto')).sign(null, msg, phone.privateKey);
    assert.equal(verifyDetached(msg, sig, phone.signPk), true);
    assert.equal(verifyDetached(msg, sig, Buffer.alloc(31)), false);
    assert.equal(verifyDetached(msg, Buffer.alloc(10), phone.signPk), false);
    assert.equal(verifyDetached(Buffer.from('otro'), sig, phone.signPk), false);
  } finally { app.close(); }
});

test('registro: faltar solo una de las dos cabeceras ya es 401 con su motivo', async () => {
  const app = await startApp();
  try {
    const phone = makePhone(app);
    const body = JSON.stringify(registerBody(phone));
    const pk = phone.signPk.toString('base64');
    for (const headers of [{ 'x-baliza-pubkey': pk }, { 'x-baliza-signature': 'AAAA' }]) {
      const r = await app.call('POST', '/v1/users', body, headers);
      assert.equal(r.status, 401);
      assert.match(r.json.error, /missing X-Baliza/);
    }
  } finally { app.close(); }
});

test('registro: campos opcionales vacíos o nulos se aceptan; obligatorios y largos se validan', async () => {
  const app = await startApp();
  try {
    const phone = makePhone(app);
    const call = (over) => signedCall(app, phone, 'POST', '/v1/users', registerBody(phone, over));
    const contact = { index: 0, name: 'A', relation: null, lang: '', channels: { sms: '+58 1', email: '', voice: null } };
    const ok = await call({ contacts: [contact] });
    assert.equal(ok.status, 201, ok.text);
    const stored = app.store.getContact(phone.senderId, 0);
    assert.deepEqual([stored.relation, stored.lang, stored.sms, stored.email, stored.voice], [null, 'es', '+58 1', null, null]);

    assert.equal((await call({ display_name: '' })).json.error, 'display_name is required');
    assert.equal((await call({ display_name: null })).json.error, 'display_name is required');
    assert.equal((await call({ display_name: undefined })).json.error, 'display_name is required');
    assert.match((await call({ display_name: 5 })).json.error, /display_name must be a string up to 80/);
    assert.match((await call({ display_name: 'x'.repeat(81) })).json.error, /display_name must be a string up to 80/);
    assert.equal((await call({ display_name: 'x'.repeat(80) })).status, 201);
    assert.equal((await call({ contacts: [{ index: 0, channels: { sms: '1' } }] })).json.error, 'contact.name is required');
    assert.match((await call({ contacts: [{ index: 0, name: 'A', channels: { sms: 5 } }] })).json.error, /contact\.channels\.sms must be a string/);
    assert.match((await call({ sign_pk_b64: Buffer.alloc(31).toString('base64') })).json.error, /sign_pk_b64 must be 32 bytes/);
    assert.match((await call({ seal_pk_b64: 5 })).json.error, /seal_pk_b64 must be 32 bytes/);
    assert.equal((await call({ contacts: 'x' })).status, 400);
    assert.equal((await call({ contacts: Array.from({ length: 33 }, (_, i) => ({ index: i % 32, name: 'A', channels: { sms: '1' } })) })).status, 400);
  } finally { app.close(); }
});

test('CMD: un monto NaN o infinito se rechaza', async () => {
  const { app, phone } = await setup({ env: { FEATURE_PAYMENTS: 'true' } });
  try {
    const run = (monto, ref) => decideCommand(app.ctx, { senderId: phone.senderId, incidentId: phone.incidentId, cmd: 'pagar', ref,
      args: { beneficiario: 'B', monto, moneda: 'USD', concepto: 'c' } });
    assert.match(run(Number.NaN, 1).text, /monto inválido/);
    assert.match(run(Number.POSITIVE_INFINITY, 2).text, /monto inválido/);
    assert.equal(run(1, 3).status, 0);
  } finally { app.close(); }
});

// --- respuestas de contactos ----------------------------------------------------------------------

test('respuesta de contacto: 404 si falta el usuario, el incidente o el contacto; verifica al contacto que responde', async () => {
  const { app, phone } = await setup();
  try {
    await sos(app, phone);
    const admin = { authorization: 'Bearer admin-secret' };
    const sim = (over) => app.call('POST', '/v1/dev/simulate-reply', { sender_id: phone.senderId, incident_id: phone.incidentId, contact_idx: 0, text: 'hola', ...over }, admin);
    assert.equal((await sim({ sender_id: 'ffffffffffffffff' })).status, 404);
    assert.equal((await sim({ incident_id: 'ffffffffffffffff' })).status, 404);
    assert.equal((await sim({ contact_idx: 9 })).status, 404);
    assert.equal((await sim({ text: '  ' })).status, 400);
    assert.equal(app.store.getContact(phone.senderId, 0).status, 'pending_verification');
    assert.equal((await sim({})).status, 201);
    assert.equal(app.store.getContact(phone.senderId, 0).status, 'verified');
    assert.equal(app.store.getContact(phone.senderId, 1).status, 'pending_verification', 'solo el que respondió');
    assert.equal((await sim({})).status, 201);
    assert.equal((await sim({ channel: 'email', text: 'por correo' })).status, 201);
    const msgs = (await app.call('POST', '/v1/mailbox/poll', { queries: [{ sender_id: phone.senderId, incident_ids: [phone.incidentId] }] })).json.messages
      .filter((m) => m.msg_type === MSG.MSG_IN).map((m) => {
        const p = decodePacket(Buffer.from(m.packet_b64, 'base64'));
        return unseal(p.sealedBlob, phone.sealKp.publicKey, phone.sealKp.privateKey)[1];
      });
    assert.deepEqual(msgs, [1, 1, 2], 'canal sms=1, email=2');
  } finally { app.close(); }
});

test('página de respuesta: escapa HTML del nombre del usuario y del contacto (XSS), no muestra "Enviado" al abrirla', async () => {
  const app = await startApp();
  try {
    const phone = makePhone(app);
    const evil = `<img src=x onerror=alert(1)>&"'`;
    const reg = await phone.register([{ index: 0, name: '<script>alert(2)</script>', channels: { sms: '+58 1' } }], evil);
    assert.equal(reg.status, 201);
    const token = makeReplyToken(app.ctx, phone.senderId, phone.incidentId, 0);
    const page = await app.call('GET', `/r/${token}`);
    assert.equal(page.status, 200);
    assert.ok(!page.text.includes('<img'), page.text);
    assert.ok(!page.text.includes('<script>'));
    assert.ok(page.text.includes('&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;'));
    assert.ok(page.text.includes('&lt;script&gt;alert(2)&lt;/script&gt;'));
    assert.ok(!page.text.includes('Enviado'));
    assert.ok(!page.text.includes('{{'), 'todas las plantillas se rellenaron');
    assert.match(page.text, /maxlength="240"/);

    await sos(app, phone);
    const sent = await app.call('POST', `/r/${token}`, 'text=hola', { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(sent.status, 200);
    assert.ok(sent.text.includes('Enviado. Gracias.'));
  } finally { app.close(); }
});

test('página de respuesta: 404 si el contacto o el usuario del token no existen', async () => {
  const { app, phone } = await setup();
  try {
    assert.equal((await app.call('GET', `/r/${makeReplyToken(app.ctx, phone.senderId, phone.incidentId, 9)}`)).status, 404);
    assert.equal((await app.call('GET', `/r/${makeReplyToken(app.ctx, 'ffffffffffffffff', phone.incidentId, 0)}`)).status, 404);
    assert.equal((await app.call('GET', `/r/${makeReplyToken(app.ctx, phone.senderId, phone.incidentId, 0)}`)).status, 200);
  } finally { app.close(); }
});

test('tokens de respuesta: solo cadenas válidas y cortas; ida y vuelta', async () => {
  const { app, phone } = await setup();
  try {
    const t = makeReplyToken(app.ctx, phone.senderId, phone.incidentId, 3);
    assert.deepEqual(parseReplyToken(app.ctx, t), { senderId: phone.senderId, incidentId: phone.incidentId, contactIdx: 3 });
    for (const bad of [123, null, undefined, {}, '', 'a', 'a.', '.b', `${t}${'x'.repeat(100)}`, t.replace('.', '')]) assert.equal(parseReplyToken(app.ctx, bad), null);
  } finally { app.close(); }
});

// --- API --------------------------------------------------------------------------------------------

test('/health expone las banderas de las fases 4 y 5; el detalle trae los contactos', async () => {
  const { app, phone } = await setup({ env: { FEATURE_RIDES: 'true' } });
  try {
    assert.deepEqual((await app.call('GET', '/health')).json.features, { payments: false, rides: true });
    await sos(app, phone);
    const d = (await app.call('GET', `/v1/incidents/${phone.senderId}/${phone.incidentId}`)).json;
    assert.deepEqual(d.contacts.map((c) => [c.idx, c.name, c.status]), [[0, 'Contacto Demo Uno', 'pending_verification'], [1, 'Contacto Demo Dos', 'pending_verification']]);
    assert.equal((await app.call('GET', `/v1/incidents/${phone.senderId}/ffffffffffffffff`)).status, 404);
  } finally { app.close(); }
});

test('GET /v1/incidents?status= filtra abiertos y cerrados', async () => {
  const { app, phone } = await setup();
  try {
    const other = makePhone(app, 'otro-usuario');
    await other.register([]);
    await sos(app, phone, 0);
    await other.egress(other.packet({ ...sosFields, plaintext: sosPlaintext({ mask: 0, channels: 0 }) }));
    await other.egress(other.packet({ msgType: MSG.UPDATE, seq: 2, ...sosFields, severity: 0, plaintext: sosPlaintext({ mask: 0, channels: 0 }) }));
    const list = async (q) => (await app.call('GET', `/v1/incidents${q}`)).json.incidents.map((i) => [i.sender_id === phone.senderId ? 'a' : 'b', i.status]);
    assert.deepEqual(await list('?status=closed'), [['b', 'closed']]);
    assert.deepEqual(await list('?status=open'), [['a', 'open']]);
    assert.equal((await list('')).length, 2);
    assert.equal((await list('?status=')).length, 2);
  } finally { app.close(); }
});

test('GET /v1/events?after= devuelve solo lo posterior; un valor no numérico equivale a 0', async () => {
  const { app, phone } = await setup();
  try {
    await sos(app, phone);
    const all = (await app.call('GET', '/v1/events')).json.events;
    assert.ok(all.length >= 3);
    const last = all[all.length - 1].id;
    assert.deepEqual((await app.call('GET', `/v1/events?after=${last}`)).json.events, []);
    assert.equal((await app.call('GET', `/v1/events?after=${all[0].id}`)).json.events.length, all.length - 1);
    assert.equal((await app.call('GET', '/v1/events?after=abc')).json.events.length, all.length);
  } finally { app.close(); }
});

test('SSE: ?after= y Last-Event-ID evitan reproducir eventos viejos', async () => {
  const { app, phone } = await setup();
  try {
    await sos(app, phone);
    const last = (await app.call('GET', '/v1/events')).json.events.at(-1).id;
    const peek = async (url, headers = {}) => {
      const ctrl = new AbortController();
      const res = await fetch(`${app.base}${url}`, { headers, signal: ctrl.signal });
      const reader = res.body.getReader();
      let text = '';
      const stop = setTimeout(() => ctrl.abort(), 400);
      try {
        for (;;) { const { value, done } = await reader.read(); if (done) break; text += Buffer.from(value).toString('utf8'); }
      } catch { /* abortado a propósito */ }
      clearTimeout(stop);
      return text;
    };
    assert.match(await peek('/v1/stream'), /event: incident_created/);
    assert.doesNotMatch(await peek(`/v1/stream?after=${last}`), /event: incident_created/);
    assert.doesNotMatch(await peek('/v1/stream', { 'last-event-id': String(last) }), /event: incident_created/);
    assert.match(await peek('/v1/stream?after=zzz'), /event: incident_created/, 'basura equivale a 0');
  } finally { app.close(); }
});

test('respuestas por API y por enlace: canal email, confirmaciones y banderas ok', async () => {
  const { app, phone } = await setup({ env: { KAPSO_WEBHOOK_SECRET: 's' } });
  try {
    await sos(app, phone);
    const token = makeReplyToken(app.ctx, phone.senderId, phone.incidentId, 0);
    assert.equal((await app.call('POST', '/v1/replies', { token, text: 'por correo', channel: 'email' })).status, 201);
    assert.equal((await app.call('POST', '/v1/replies', { token, text: 'por sms' })).status, 201);
    const chans = (await app.call('POST', '/v1/mailbox/poll', { queries: [{ sender_id: phone.senderId, incident_ids: [phone.incidentId] }] })).json.messages
      .filter((m) => m.msg_type === MSG.MSG_IN)
      .map((m) => unseal(decodePacket(Buffer.from(m.packet_b64, 'base64')).sealedBlob, phone.sealKp.publicKey, phone.sealKp.privateKey)[1]);
    assert.deepEqual(chans, [2, 1]);

    const { createHmac } = await import('node:crypto');
    const body = JSON.stringify({ message: { id: 'x', type: 'text', from: '15555550100', text: { body: 'hola' } } });
    const headers = { 'content-type': 'application/json', 'x-webhook-signature': createHmac('sha256', 's').update(body).digest('hex'), 'x-webhook-event': 'whatsapp.message.received', 'x-idempotency-key': 'k' };
    const first = await app.call('POST', '/v1/webhooks/whatsapp', body, headers);
    assert.equal(first.json.ok, true);
    assert.equal(first.json.duplicate, undefined);
    const dup = await app.call('POST', '/v1/webhooks/whatsapp', body, headers);
    assert.deepEqual(dup.json, { ok: true, duplicate: true });

    const verify = await app.call('POST', '/v1/admin/contacts/verify', { sender_id: phone.senderId, index: 1 }, { authorization: 'Bearer admin-secret' });
    assert.deepEqual(verify.json, { ok: true });
    assert.equal(app.store.getContact(phone.senderId, 1).status, 'verified');
    assert.equal((await app.call('POST', '/v1/admin/contacts/verify', { sender_id: phone.senderId, index: 9 }, { authorization: 'Bearer admin-secret' })).status, 404);
  } finally { app.close(); }
});

// --- límites, llaves, configuración y almacén -----------------------------------------------------

test('limits: la ventana se reinicia y la memoria se purga al superar 50 000 claves', () => {
  const clock = { t: 0 };
  const lim = createRateLimiter(() => clock.t);
  assert.deepEqual([1, 2, 3, 4].map(() => lim.hit('a', 3, 60)), [true, true, true, false]);
  clock.t = 59;
  assert.equal(lim.hit('a', 3, 60), false);
  clock.t = 60;
  assert.equal(lim.hit('a', 3, 60), true, 'a los 60 s empieza otra ventana');
  for (let i = 0; i < 50_001; i += 1) lim.hit(`k${i}`, 5, 60);
  assert.ok(lim.size() > 50_000);
  clock.t = 200;
  lim.hit('nuevo', 5, 60);
  assert.ok(lim.size() < 10, `se purgaron las ventanas vencidas (quedan ${lim.size()})`);
});

test('llaves del servidor: del entorno, persistidas en archivo (modo 600, directorios creados) o efímeras', () => {
  const dir = tmp();
  const env = { BALIZA_SIGN_SEED_HEX: hex32('a'), BALIZA_SEAL_SK_HEX: hex32('b') };
  const fromEnv = loadServerKeys({ env, keyFile: join(dir, 'no-debe-existir.json') });
  assert.equal(loadServerKeys({ env }).senderId, fromEnv.senderId);
  assert.ok(!existsSync(join(dir, 'no-debe-existir.json')), 'con ambas variables no se toca el disco');
  assert.equal(fromEnv.keyId, 'k1');
  assert.equal(loadServerKeys({ env: { ...env, BALIZA_KEY_ID: 'k7' } }).keyId, 'k7');

  const file = join(dir, 'a', 'b', 'keys.json');
  const first = loadServerKeys({ env: {}, keyFile: file });
  assert.ok(existsSync(file));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const again = loadServerKeys({ env: {}, keyFile: file });
  assert.equal(again.senderId, first.senderId);
  assert.ok(again.sealPk.equals(first.sealPk));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort(), ['seal_sk_hex', 'sign_seed_hex']);

  const a = loadServerKeys({ env: {} });
  const b = loadServerKeys({ env: {} });
  assert.notEqual(a.senderId, b.senderId, 'sin archivo ni entorno son efímeras');
});

test('llaves del servidor: cada variable de entorno manda sobre su campo del archivo', () => {
  const dir = tmp();
  const file = join(dir, 'keys.json');
  loadServerKeys({ env: {}, keyFile: file });
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  const seedOnly = loadServerKeys({ env: { BALIZA_SIGN_SEED_HEX: hex32('c') }, keyFile: file });
  const both = loadServerKeys({ env: { BALIZA_SIGN_SEED_HEX: hex32('c'), BALIZA_SEAL_SK_HEX: stored.seal_sk_hex } });
  assert.equal(seedOnly.senderId, both.senderId, 'firma del entorno');
  assert.ok(seedOnly.sealPk.equals(both.sealPk), 'sellado del archivo');
  const sealOnly = loadServerKeys({ env: { BALIZA_SEAL_SK_HEX: hex32('d') }, keyFile: file });
  assert.equal(sealOnly.senderId, loadServerKeys({ env: { BALIZA_SIGN_SEED_HEX: stored.sign_seed_hex, BALIZA_SEAL_SK_HEX: hex32('d') } }).senderId);
});

test('config: banderas y enteros tolerantes', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) assert.equal(loadConfig({ FEATURE_PAYMENTS: v }).featurePayments, true, v);
  for (const v of ['0', 'false', 'no', 'off', '', 'quizá', undefined]) assert.equal(loadConfig({ FEATURE_PAYMENTS: v }).featurePayments, false, String(v));
  assert.equal(loadConfig({}).port, 8080);
  assert.equal(loadConfig({ PORT: '' }).port, 8080);
  assert.equal(loadConfig({ PORT: 'abc' }).port, 8080);
  assert.equal(loadConfig({ PORT: '9090' }).port, 9090);
  assert.equal(loadConfig({ PORT: '0' }).port, 0);
  assert.equal(loadConfig({ RATE_EGRESS_PER_MIN: '7' }).rate.egressPerMin, 7);
  assert.equal(loadConfig({ RENDER_EXTERNAL_URL: 'https://x.onrender.com/' }).publicBaseUrl, 'https://x.onrender.com');
  assert.equal(loadConfig({ RENDER_EXTERNAL_URL: 'https://x.onrender.com', PUBLIC_BASE_URL: 'https://y/' }).publicBaseUrl, 'https://y');
  assert.equal(loadConfig({ KAPSO_BASE_URL: 'https://k/v1/' }).kapso.baseUrl, 'https://k/v1');
});

test('Store en disco: crea los directorios y persiste; la cola de radio descarta lo cubierto por rx_cursor', () => {
  const file = join(tmp(), 'uno', 'dos', 'x.db');
  const store = new Store(file);
  assert.ok(existsSync(file));
  store.upsertUser({ senderId: 'a'.repeat(16), displayName: 'U', signPk: Buffer.alloc(32), sealPk: Buffer.alloc(32), now: 1 });
  store.close();
  const reopened = new Store(file);
  assert.equal(reopened.getUser('a'.repeat(16)).display_name, 'U');

  const s = 'a'.repeat(16);
  const inc = 'b'.repeat(16);
  const ids = [1, 2, 3].map((srvSeq) => reopened.addMailbox({ senderId: s, incidentId: inc, msgType: 5, srvSeq, createdAt: 10, packetB64: 'x' }));
  for (const id of ids) reopened.enqueueRadio('egress-1', id);
  reopened.dropRadioCovered(s, inc, 2);
  const left = reopened.db.prepare('SELECT mailbox_id FROM radio_queue').all().map((r) => r.mailbox_id);
  assert.deepEqual(left, [ids[2]], 'quedan solo los de srv_seq > rx_cursor');
  reopened.close();
});

// --- segunda ronda de mutantes ------------------------------------------------------------------------

test('registro: un contacto que no es objeto se rechaza como «invalid contact»', async () => {
  const app = await startApp();
  try {
    const phone = makePhone(app);
    for (const bad of [null, 'x', 5]) {
      const r = await signedCall(app, phone, 'POST', '/v1/users', registerBody(phone, { contacts: [bad] }));
      assert.equal(r.status, 400);
      assert.equal(r.json.error, 'invalid contact');
    }
  } finally { app.close(); }
});

test('firma de Kapso: cabecera ausente o no textual y secreto vacío nunca validan', async () => {
  const { createHmac } = await import('node:crypto');
  const { isValidKapsoSignature } = await import('../src/replies.js');
  const body = Buffer.from('{"a":1}');
  const good = createHmac('sha256', 's3cret').update(body).digest('hex');
  assert.equal(isValidKapsoSignature(body, good, 's3cret'), true);
  assert.equal(isValidKapsoSignature(body, undefined, 's3cret'), false);
  assert.equal(isValidKapsoSignature(body, 123, 's3cret'), false);
  assert.equal(isValidKapsoSignature(body, good, 'otro'), false);
  assert.equal(isValidKapsoSignature(body, good.slice(0, -1), 's3cret'), false, 'largo distinto');
  const emptyKeySig = createHmac('sha256', '').update(body).digest('hex');
  assert.equal(isValidKapsoSignature(body, emptyKeySig, ''), false, 'sin secreto configurado no hay firma válida');
  assert.equal(isValidKapsoSignature(body, emptyKeySig, undefined), false);
});

test('estados de entrega: un evento desconocido o un id no textual no tocan los avisos', async () => {
  const channels = {
    sent: [], email: { live: false, async send() { return { state: 'simulated' }; } }, voice: { live: false, async send() { return { state: 'simulated' }; } },
    sms: { live: true, async send() { return { state: 'sent', detail: 'kapso-whatsapp:text:wamid:wamid.1' }; } },
  };
  const { app, phone } = await setup({ env: { KAPSO_WEBHOOK_SECRET: 's', ALLOW_UNVERIFIED_CONTACTS: 'true' }, channels });
  try {
    await sos(app, phone, 0b01);
    const { createHmac } = await import('node:crypto');
    const hook = (event, payload) => {
      const body = JSON.stringify(payload);
      return app.call('POST', '/v1/webhooks/whatsapp', body, { 'content-type': 'application/json', 'x-webhook-event': event,
        'x-webhook-signature': createHmac('sha256', 's').update(body).digest('hex') });
    };
    const states = () => app.store.listNotifications(phone.senderId, phone.incidentId).map((n) => n.state);
    assert.deepEqual(states(), ['sent']);
    const unknown = await hook('whatsapp.conversation.created', { message: { id: 'wamid.1' } });
    assert.equal(unknown.json.ignored, 'event whatsapp.conversation.created');
    assert.deepEqual(states(), ['sent'], 'un evento ajeno nunca pone el estado en NULL');
    assert.equal((await hook('whatsapp.message.delivered', { message: { id: 12345 } })).json.ignored, 'event whatsapp.message.delivered');
    assert.equal((await hook('whatsapp.message.delivered', {})).json.ignored, 'event whatsapp.message.delivered');
    assert.deepEqual(states(), ['sent']);
    assert.equal((await hook('whatsapp.message.delivered', { message: { id: 'wamid.1' } })).json.updated, 1);
    assert.deepEqual(states(), ['delivered']);
  } finally { app.close(); }
});

test('llaves del servidor: un archivo incompleto se regenera entero en vez de fallar', () => {
  const dir = tmp();
  const file = join(dir, 'keys.json');
  const reference = loadServerKeys({ env: {}, keyFile: file });
  const full = JSON.parse(readFileSync(file, 'utf8'));
  for (const partial of [{ sign_seed_hex: full.sign_seed_hex }, { seal_sk_hex: full.seal_sk_hex }, {}]) {
    writeJson(file, partial);
    const keys = loadServerKeys({ env: {}, keyFile: file });
    assert.equal(keys.signPk.length, 32);
    assert.equal(keys.sealPk.length, 32);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort(), ['seal_sk_hex', 'sign_seed_hex'], 'se reescribió completo');
  }
  assert.ok(reference.senderId);
});

function writeJson(file, obj) {
  writeFileSync(file, JSON.stringify(obj));
}

test('config: cada variable de entorno tiene prioridad sobre su valor por defecto', () => {
  const d = loadConfig({});
  assert.ok(d.dbPath.endsWith(join('backend', 'data', 'baliza.db')), d.dbPath);
  assert.ok(d.keyFile.endsWith(join('backend', 'data', 'server-keys.json')), d.keyFile);
  assert.equal(d.corsOrigin, '*');
  assert.equal(d.llm.apiKey, null);
  const c = loadConfig({ DATABASE_PATH: '/x/y.db', BALIZA_KEY_FILE: '/x/k.json', CORS_ORIGIN: 'https://panel.example', ANTHROPIC_API_KEY: 'sk-test' });
  assert.deepEqual([c.dbPath, c.keyFile, c.corsOrigin, c.llm.apiKey], ['/x/y.db', '/x/k.json', 'https://panel.example', 'sk-test']);
});

test('registro: el índice de contacto debe ser entero entre 0 y 31', async () => {
  const app = await startApp();
  try {
    const phone = makePhone(app);
    const withIndex = (index) => signedCall(app, phone, 'POST', '/v1/users', registerBody(phone, { contacts: [{ index, name: 'A', channels: { sms: '1' } }] }));
    for (const bad of [-1, 32, 1.5, '1', null]) {
      const r = await withIndex(bad);
      assert.equal(r.status, 400, `índice ${JSON.stringify(bad)}`);
      assert.equal(r.json.error, 'contact.index must be 0..31');
    }
    assert.equal((await withIndex(0)).status, 201);
    assert.equal((await withIndex(31)).status, 201);
  } finally { app.close(); }
});
