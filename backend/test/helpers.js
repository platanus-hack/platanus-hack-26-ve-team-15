// Utilidades de prueba: app en memoria, reloj fijo, canales falsos y un "teléfono" sintético.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { once } from 'node:events';
import { MSG, encodePacket, senderIdOf } from '../src/codec.js';
import { createApp } from '../src/api.js';
import { generateSealKeypair, loadServerKeys, seal } from '../src/crypto.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
export const T0 = 1798200000;

export function ed25519FromLabel(label) {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, createHash('sha256').update(label).digest()]), format: 'der', type: 'pkcs8' });
  const signPk = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32);
  return { privateKey, signPk: Buffer.from(signPk), senderId: senderIdOf(signPk) };
}

/** Canales que registran los envíos en memoria; nunca contactan a nadie. */
export function fakeChannels() {
  const sent = [];
  const mk = (name) => ({ name, live: false, async send(m) { sent.push({ channel: name, ...m }); return { state: 'simulated', detail: 'test' }; } });
  return { sent, sms: mk('sms'), email: mk('email'), voice: mk('voice') };
}

export async function startApp({ env = {}, now = T0 + 30, channels = fakeChannels(), writer } = {}) {
  const clock = { t: now };
  const config = loadConfig({ ADMIN_TOKEN: 'admin-secret', ...env });
  const store = new Store(':memory:');
  const keys = loadServerKeys({ env: {} });
  const app = createApp({ config, store, keys, channels, writer: writer ?? (async (_p, fallback) => fallback), now: () => clock.t, log: () => {} });
  app.server.listen(0);
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html o vacío */ }
    return { status: res.status, json, text };
  };
  return { ...app, base, call, clock, channels, store, keys, close: () => { app.server.closeAllConnections?.(); app.close(); } };
}

/** Teléfono sintético: llaves Ed25519 y X25519 propias, registra y emite paquetes firmados. */
export function makePhone(app, label = 'baliza-synthetic-user-1') {
  const id = ed25519FromLabel(label);
  const sealKp = generateSealKeypair();
  const phone = {
    ...id, sealKp, incidentId: createHash('sha256').update(`incident-${label}`).digest().subarray(0, 8).toString('hex'),
    async register(contacts = defaultContacts(), displayName = 'Usuario Demo') {
      const body = JSON.stringify({ display_name: displayName, sign_pk_b64: id.signPk.toString('base64'),
        seal_pk_b64: sealKp.publicKey.toString('base64'), contacts });
      const sig = sign(null, createHash('sha256').update(body).digest(), id.privateKey).toString('base64');
      return app.call('POST', '/v1/users', body, { 'content-type': 'application/json', 'x-baliza-pubkey': id.signPk.toString('base64'), 'x-baliza-signature': sig });
    },
    packet({ msgType = MSG.SOS, seq = 1, plaintext, ts = app.clock.t, ttl = 7, ...rest }) {
      return encodePacket({
        msgType, ttl, incidentId: phone.incidentId, seq, timestamp: ts, signer: id,
        blob: plaintext ? seal(plaintext, app.keys.sealPk) : Buffer.alloc(0), ...rest,
      });
    },
    egress(packet, { envelopeTtl = 5, egressId = 'egress-test-01' } = {}) {
      return app.call('POST', '/v1/egress', { packet_b64: packet.toString('base64'), rx: { envelope_ttl: envelopeTtl, egress_id: egressId, rx_at: app.clock.t } });
    },
  };
  return phone;
}

export const defaultContacts = () => [
  { index: 0, name: 'Contacto Demo Uno', relation: 'familiar', lang: 'es', channels: { sms: '+58 000-0000001', email: 'contacto1@example.com', voice: '+58 000-0000001' } },
  { index: 1, name: 'Contacto Demo Dos', relation: 'amigo', lang: 'es', channels: { sms: '+58 000-0000002', voice: '+58 000-0000002' } },
];

export const sosPlaintext = ({ mask = 0b11, channels = 3, rxCursor = 0, note = 'Persona inconsciente en la plaza' } = {}) => {
  const head = Buffer.alloc(7);
  head.writeUInt32BE(mask, 0);
  head[4] = channels;
  head.writeUInt16BE(rxCursor, 5);
  return Buffer.concat([head, Buffer.from(note, 'utf8')]);
};

export const sosFields = { category: 1, severity: 3, lat: 1049700, lon: -6685300, accuracyM: 12, locationAge: 4, publicText: 'SOS medico, necesito ayuda' };

/** Petición firmada por el teléfono (prueba de posesión) con un cuerpo arbitrario. */
export function signedCall(app, phone, method, path, payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const sig = sign(null, createHash('sha256').update(body).digest(), phone.privateKey).toString('base64');
  return app.call(method, path, body, { 'content-type': 'application/json', 'x-baliza-pubkey': phone.signPk.toString('base64'), 'x-baliza-signature': sig });
}

export const registerBody = (phone, over = {}) => ({
  display_name: 'Usuario Demo', sign_pk_b64: phone.signPk.toString('base64'), seal_pk_b64: phone.sealKp.publicKey.toString('base64'), contacts: [], ...over,
});
