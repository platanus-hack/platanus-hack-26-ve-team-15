// Generates the synthetic example packets of docs/contrato.md (golden vectors).
// Run:  node docs/examples/generate-examples.mjs > docs/examples/examples.json
// Ed25519 signatures are real (Node crypto) over fixed synthetic seeds.
// sealed_blob bytes are SYNTHETIC FILLER of the correct length (48 B overhead + plaintext):
// they are NOT a real libsodium sealed box. Replace with crypto_box_seal in the real code.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SEALED_BOX_OVERHEAD = 48;
const MAX_INNER_BYTES = 418; // 512 - (14 header + 8 sender + 8 recipient + 64 bitchat signature)
const NO_LOCATION = -2147483648;
const DOMAIN = Buffer.from('BALIZA-V1');

const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();

function keypair(label) {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, sha256(label)]), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(priv).export({ type: 'spki', format: 'der' }).subarray(-32);
  return { priv, pub, senderId: sha256(pub).subarray(0, 8) };
}

const user = keypair('baliza-synthetic-user-1');
const server = keypair('baliza-synthetic-server');

// Deterministic stand-in for crypto_box_seal output: 48 B "overhead" + masked plaintext.
function fakeSeal(plaintext, label) {
  const stream = Buffer.concat([...Array(Math.ceil(plaintext.length / 32) + 2).keys()].map((i) => sha256(label, String(i))));
  const masked = Buffer.from(plaintext).map((b, i) => b ^ stream[SEALED_BOX_OVERHEAD + i]);
  return Buffer.concat([stream.subarray(0, SEALED_BOX_OVERHEAD), masked]);
}

const TYPES = { SOS: 1, UPDATE: 2, ACK: 3, MSG_OUT: 4, MSG_IN: 5, CMD: 6, CMD_RESULT: 7 };

function pack({ msgType, ttl, incidentId, seq, category = 0, severity = 0, lat = NO_LOCATION, lon = NO_LOCATION,
  accuracyM = 0, locationAge = 0, timestamp, signer, publicText = '', blob = Buffer.alloc(0) }) {
  const text = Buffer.from(publicText, 'utf8');
  if (text.length > 60) throw new Error('public_text > 60 B');
  const head = Buffer.alloc(39);
  head.writeUInt8(1, 0);
  head.writeUInt8(msgType, 1);
  head.writeUInt8(ttl, 2);
  incidentId.copy(head, 3);
  head.writeUInt16BE(seq, 11);
  head.writeUInt8(category, 13);
  head.writeUInt8(severity, 14);
  head.writeInt32BE(lat, 15);
  head.writeInt32BE(lon, 19);
  head.writeUInt16BE(accuracyM, 23);
  head.writeUInt16BE(locationAge, 25);
  head.writeUInt32BE(timestamp, 27);
  signer.senderId.copy(head, 31);
  const tail = Buffer.concat([Buffer.from([text.length]), text, Buffer.from([blob.length >> 8, blob.length & 0xff]), blob]);
  const unsigned = Buffer.concat([head, tail]);
  // Signature covers everything except ttl (offset 2) and the signature itself.
  const preimage = Buffer.concat([DOMAIN, unsigned.subarray(0, 2), unsigned.subarray(3)]);
  const signature = sign(null, preimage, signer.priv);
  if (!verify(null, preimage, createPublicKey(signer.priv), signature)) throw new Error('self-verify failed');
  const packet = Buffer.concat([unsigned, signature]);
  if (packet.length > MAX_INNER_BYTES) throw new Error(`packet ${packet.length} B > ${MAX_INNER_BYTES} B budget`);
  return packet;
}

const incidentId = sha256('baliza-synthetic-incident-1').subarray(0, 8);
const T0 = 1798200000; // synthetic instant, 2026-12-25T12:00:00Z
const LAT = 1049700; // 10.49700 (synthetic point)
const LON = -6685300; // -66.85300
const contactMask = Buffer.alloc(4); contactMask.writeUInt32BE(0b11); // contacts 0 and 1
const channels = 0b0011; // sms + email

const cases = [
  ['SOS', { msgType: TYPES.SOS, ttl: 7, seq: 1, category: 1, severity: 3, lat: LAT, lon: LON, accuracyM: 12, locationAge: 4,
    timestamp: T0, signer: user, publicText: 'SOS medico, necesito ayuda',
    plaintext: Buffer.concat([contactMask, Buffer.from([channels]), Buffer.from([0, 0]) /* rx_cursor */, Buffer.from('Persona inconsciente en la plaza. Tel de prueba +58 000-0000000', 'utf8')]) }],
  ['UPDATE', { msgType: TYPES.UPDATE, ttl: 7, seq: 2, category: 1, severity: 3, lat: LAT + 20, lon: LON - 15, accuracyM: 8, locationAge: 1,
    timestamp: T0 + 90, signer: user, publicText: 'Sigo aqui, ya respira',
    plaintext: Buffer.concat([contactMask, Buffer.from([channels]), Buffer.from([0, 0]) /* rx_cursor */, Buffer.from('Respira pero sigue sin hablar', 'utf8')]) }],
  ['ACK', { msgType: TYPES.ACK, ttl: 7, seq: 1, category: 1, timestamp: T0 + 40, signer: server, publicText: 'Recibido. 2 contactos avisados' }],
  ['MSG_OUT', { msgType: TYPES.MSG_OUT, ttl: 7, seq: 3, timestamp: T0 + 120, signer: user,
    plaintext: Buffer.concat([Buffer.from([0x00, channels]), Buffer.from('Estoy bien, la ambulancia ya llego', 'utf8')]) }],
  ['MSG_IN', { msgType: TYPES.MSG_IN, ttl: 7, seq: 1, timestamp: T0 + 150, signer: server,
    plaintext: Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from('Voy para alla, aguanta', 'utf8')]) }],
  ['CMD', { msgType: TYPES.CMD, ttl: 7, seq: 4, timestamp: T0 + 200, signer: user,
    plaintext: Buffer.from(JSON.stringify({ cmd: 'pedir_ride', ref: 7, args: { destino: 'Clinica Demo', modo: 'urgente' } }), 'utf8') }],
  ['CMD_RESULT', { msgType: TYPES.CMD_RESULT, ttl: 7, seq: 2, timestamp: T0 + 215, signer: server,
    plaintext: Buffer.concat([Buffer.from([0x00, 0x07, 0x00]), Buffer.from('[MOCK] Ride simulado, llega en 6 min', 'utf8')]) }],
];

const out = {
  note: 'Synthetic data. sealed_blob is filler of correct length, not a real sealed box. Signatures are real Ed25519.',
  budget: { max_inner_bytes: MAX_INNER_BYTES },
  keys: {
    user: { sign_pk_hex: user.pub.toString('hex'), sender_id: user.senderId.toString('hex') },
    server: { sign_pk_hex: server.pub.toString('hex'), sender_id: server.senderId.toString('hex') },
  },
  incident_id: incidentId.toString('hex'),
  packets: {},
};
for (const [name, c] of cases) {
  const blob = c.plaintext ? fakeSeal(c.plaintext, name) : Buffer.alloc(0);
  const packet = pack({ ...c, incidentId, blob });
  out.packets[name] = {
    msg_type: c.msgType,
    bytes: packet.length,
    envelope_bytes_est: packet.length + 86,
    plaintext_hex: c.plaintext ? c.plaintext.toString('hex') : null,
    plaintext_bytes: c.plaintext ? c.plaintext.length : 0,
    hex: packet.toString('hex'),
    base64: packet.toString('base64'),
  };
}

// Worst case for the budget: SOS with 60 B text and the largest allowed blob.
const worst = pack({ msgType: TYPES.SOS, ttl: 7, incidentId, seq: 65535, category: 7, severity: 3, lat: LAT, lon: LON, accuracyM: 65535,
  locationAge: 65535, timestamp: T0, signer: user, publicText: 'x'.repeat(60), blob: Buffer.alloc(252, 0xa5) });
out.worst_case_sos = { bytes: worst.length, envelope_bytes_est: worst.length + 86, max_plaintext_bytes: 252 - SEALED_BOX_OVERHEAD };

console.log(JSON.stringify(out, null, 2));
