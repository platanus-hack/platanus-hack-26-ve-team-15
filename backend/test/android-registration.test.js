// Interoperabilidad con apps/android/.../registration/RegistrationClient.kt: mismo cuerpo (JSON compacto de Gson,
// sin escapar HTML), firma Ed25519 sobre el SHA-256 de los bytes UTF-8 exactos y base64 estándar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, sign } from 'node:crypto';
import { senderIdOf } from '../src/codec.js';
import { startApp, makePhone } from './helpers.js';

const b64 = (buf) => Buffer.from(buf).toString('base64');

function androidRequest(phone, displayName, contacts) {
  // Misma forma que buildBody(): relation y lang siempre presentes (relation puede ser ""), canales vacíos omitidos.
  const body = JSON.stringify({
    display_name: displayName,
    sign_pk_b64: b64(phone.signPk),
    seal_pk_b64: b64(phone.sealKp.publicKey),
    contacts: contacts.map((c) => ({ index: c.index, name: c.name, relation: c.relation ?? '', lang: c.lang ?? 'es', channels: c.channels })),
  });
  const bytes = Buffer.from(body, 'utf8');
  const signature = b64(sign(null, createHash('sha256').update(bytes).digest(), phone.privateKey));
  return { bytes, headers: { 'content-type': 'application/json; charset=utf-8', 'x-baliza-pubkey': b64(phone.signPk), 'x-baliza-signature': signature } };
}

test('registro como lo envía la app Android: acentos, emoji, relation vacía; la respuesta cumple lo que valida el cliente', async () => {
  const app = await startApp();
  try {
    const phone = makePhone(app, 'android-phone');
    const contacts = [
      { index: 0, name: 'José Ñandú 🚑', relation: '', lang: 'es', channels: { sms: '+58 412-0000001' } },
      { index: 31, name: 'María <b>&</b>', relation: 'amiga', lang: 'es', channels: { email: 'maria@example.com', voice: '+58 412-0000002' } },
    ];
    const { bytes, headers } = androidRequest(phone, 'Ana Pérez ✨', contacts);
    const res = await fetch(`${app.base}/v1/users`, { method: 'POST', headers, body: bytes });
    assert.equal(res.status, 201, await res.clone().text());
    const json = await res.json();

    // Lo que RegistrationClient.parse() exige:
    assert.equal(json.sender_id, senderIdOf(phone.signPk), 'sender_id = SHA-256(sign_pk)[0..8] en hex');
    assert.match(json.sender_id, /^[0-9a-f]{16}$/);
    assert.equal(typeof json.server.key_id, 'string');
    assert.equal(Buffer.from(json.server.sign_pk_b64, 'base64').length, 32);
    assert.equal(Buffer.from(json.server.seal_pk_b64, 'base64').length, 32);
    assert.deepEqual(json.contacts, [{ index: 0, status: 'pending_verification' }, { index: 31, status: 'pending_verification' }]);

    const stored = app.store.getContact(phone.senderId, 0);
    assert.equal(stored.name, 'José Ñandú 🚑');
    assert.equal(stored.relation, null, 'relation vacía se guarda como ausente');
    assert.equal(app.store.getUser(phone.senderId).display_name, 'Ana Pérez ✨');

    // Registrarse de nuevo (p. ej. tras editar contactos) devuelve las MISMAS llaves del servidor:
    // el cliente las fija en el primer registro y rechaza un cambio (ServerKeyChanged).
    const again = androidRequest(phone, 'Ana Pérez', contacts.slice(0, 1));
    const second = await (await fetch(`${app.base}/v1/users`, { method: 'POST', headers: again.headers, body: again.bytes })).json();
    assert.deepEqual(second.server, json.server);
  } finally { app.close(); }
});

test('el servidor hashea los bytes recibidos: reserializar el JSON o cambiar un byte invalida la firma', async () => {
  const app = await startApp();
  try {
    const phone = makePhone(app, 'android-phone-2');
    const { bytes, headers } = androidRequest(phone, 'Ana', [{ index: 0, name: 'A', channels: { sms: '1' } }]);
    const pretty = Buffer.from(JSON.stringify(JSON.parse(bytes.toString('utf8')), null, 2), 'utf8');
    const reserialized = await fetch(`${app.base}/v1/users`, { method: 'POST', headers, body: pretty });
    assert.equal(reserialized.status, 401, 'la firma cubre los bytes exactos, no el JSON lógico');
    const ok = await fetch(`${app.base}/v1/users`, { method: 'POST', headers, body: bytes });
    assert.equal(ok.status, 201);
  } finally { app.close(); }
});
