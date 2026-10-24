// Paquete interno de Baliza Vital (contrato §3). Todo en big-endian.
import { createHash, createPublicKey, sign, verify } from 'node:crypto';

export const VERSION = 1;
export const MAX_INNER_BYTES = 418;
export const MAX_TEXT_BYTES = 60;
export const NO_LOCATION = -2147483648;
export const SIGNATURE_BYTES = 64;
export const SEAL_OVERHEAD = 48;

export const MSG = Object.freeze({ SOS: 1, UPDATE: 2, ACK: 3, MSG_OUT: 4, MSG_IN: 5, CMD: 6, CMD_RESULT: 7 });
export const ACK_CODE = Object.freeze({ RECEIVED: 0, CONTACTS_NOTIFIED: 1, IN_PROGRESS: 2, REJECTED: 3 });
export const CHANNEL = Object.freeze({ SMS: 1, EMAIL: 2, VOICE: 4 });

const DOMAIN = Buffer.from('BALIZA-V1');
const FIXED_HEAD = 39;
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class PacketError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PacketError';
  }
}

export function sha256(...parts) {
  return createHash('sha256').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
}

/** `sender_id = SHA-256(ed25519_pk)[0..8]` (§3.4), en hex. */
export function senderIdOf(signPk) {
  return sha256(signPk).subarray(0, 8).toString('hex');
}

export function ed25519PublicKey(raw) {
  if (raw.length !== 32) throw new PacketError('ed25519 pk must be 32 bytes');
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

function preimage(unsigned) {
  return Buffer.concat([DOMAIN, unsigned.subarray(0, 2), unsigned.subarray(3)]);
}

function checkSize(buf) {
  if (!Buffer.isBuffer(buf)) throw new PacketError('packet must be a Buffer');
  if (buf.length > MAX_INNER_BYTES) throw new PacketError(`packet ${buf.length} B > ${MAX_INNER_BYTES} B`);
  if (buf.length < FIXED_HEAD + 1 + 2 + SIGNATURE_BYTES) throw new PacketError('packet too short');
}

function checkFields(buf) {
  if (buf[0] !== VERSION) throw new PacketError(`unsupported version ${buf[0]}`);
  if (buf[1] < 1 || buf[1] > 7) throw new PacketError(`invalid msg_type ${buf[1]}`);
  if (buf[39] > MAX_TEXT_BYTES) throw new PacketError('text_len > 60');
  if (buf[14] > 3) throw new PacketError('invalid severity');
}

/** Dónde empieza el largo del blob y dónde la firma; valida que el largo total cuadre. */
function locateBlob(buf) {
  const blobLenAt = 40 + buf[39];
  if (blobLenAt + 2 > buf.length) throw new PacketError('truncated packet');
  const sigStart = blobLenAt + 2 + buf.readUInt16BE(blobLenAt);
  if (sigStart + SIGNATURE_BYTES !== buf.length) throw new PacketError('length mismatch');
  return { blobLenAt, sigStart };
}

function coordinate(v) {
  return v === NO_LOCATION ? null : v;
}

function readHeader(buf) {
  return {
    version: buf[0],
    msgType: buf[1],
    ttl: buf[2],
    incidentId: buf.subarray(3, 11).toString('hex'),
    seq: buf.readUInt16BE(11),
    category: buf[13],
    severity: buf[14],
    lat: coordinate(buf.readInt32BE(15)),
    lon: coordinate(buf.readInt32BE(19)),
    accuracyM: buf.readUInt16BE(23),
    locationAge: buf.readUInt16BE(25),
    timestamp: buf.readUInt32BE(27),
    senderId: buf.subarray(31, 39).toString('hex'),
  };
}

/**
 * Decodifica y valida la estructura. NO verifica la firma (necesita la llave del emisor).
 * Devuelve el paquete con `unsigned` (bytes firmados + ttl) para poder verificar después.
 */
export function decodePacket(buf) {
  checkSize(buf);
  checkFields(buf);
  const { blobLenAt, sigStart } = locateBlob(buf);
  return {
    ...readHeader(buf),
    publicText: buf.subarray(40, blobLenAt).toString('utf8'),
    sealedBlob: Buffer.from(buf.subarray(blobLenAt + 2, sigStart)),
    signature: Buffer.from(buf.subarray(sigStart)),
    unsigned: Buffer.from(buf.subarray(0, sigStart)),
    raw: Buffer.from(buf),
  };
}

/** Ed25519 detached: false (nunca lanza) ante llaves o firmas mal formadas. */
export function verifyDetached(message, signature, signPk) {
  try {
    return verify(null, message, ed25519PublicKey(signPk), signature);
  } catch {
    return false;
  }
}

export function verifyPacket(packet, signPk) {
  return verifyDetached(preimage(packet.unsigned), packet.signature, signPk);
}

function hexBuf(hex, bytes) {
  const b = Buffer.from(hex, 'hex');
  if (b.length !== bytes) throw new PacketError(`expected ${bytes} B hex id`);
  return b;
}

/** Construye y firma un paquete. `signer` = { privateKey (KeyObject), senderId (hex) }. */
export function encodePacket({
  msgType, ttl = 7, incidentId, seq, category = 0, severity = 0, lat = null, lon = null,
  accuracyM = 0, locationAge = 0, timestamp, publicText = '', blob = Buffer.alloc(0), signer,
}) {
  const text = Buffer.from(publicText, 'utf8');
  if (text.length > MAX_TEXT_BYTES) throw new PacketError('public_text > 60 B');
  const head = Buffer.alloc(FIXED_HEAD);
  head.writeUInt8(VERSION, 0);
  head.writeUInt8(msgType, 1);
  head.writeUInt8(ttl, 2);
  hexBuf(incidentId, 8).copy(head, 3);
  head.writeUInt16BE(seq, 11);
  head.writeUInt8(category, 13);
  head.writeUInt8(severity, 14);
  head.writeInt32BE(lat ?? NO_LOCATION, 15);
  head.writeInt32BE(lon ?? NO_LOCATION, 19);
  head.writeUInt16BE(Math.min(accuracyM, 65535), 23);
  head.writeUInt16BE(Math.min(locationAge, 65535), 25);
  head.writeUInt32BE(timestamp, 27);
  hexBuf(signer.senderId, 8).copy(head, 31);
  const blobLen = Buffer.alloc(2);
  blobLen.writeUInt16BE(blob.length);
  const unsigned = Buffer.concat([head, Buffer.from([text.length]), text, blobLen, blob]);
  const signature = sign(null, preimage(unsigned), signer.privateKey);
  const packet = Buffer.concat([unsigned, signature]);
  if (packet.length > MAX_INNER_BYTES) throw new PacketError(`packet ${packet.length} B > ${MAX_INNER_BYTES} B`);
  return packet;
}

// --- Plaintext de cada tipo (§3.3) -------------------------------------------------

/** SOS / UPDATE: contact_mask(4) · channels(1) · rx_cursor(2) · nota UTF-8. */
export function parseSosPlaintext(pt) {
  if (pt.length < 7) throw new PacketError('SOS plaintext too short');
  return {
    contactMask: pt.readUInt32BE(0),
    channels: pt[4],
    rxCursor: pt.readUInt16BE(5),
    note: pt.subarray(7).toString('utf8'),
  };
}

/** MSG_OUT: contact_idx(1, 0xFF = todos) · channels(1) · texto. */
export function parseMsgOutPlaintext(pt) {
  if (pt.length < 2) throw new PacketError('MSG_OUT plaintext too short');
  return { contactIdx: pt[0], channels: pt[1], text: pt.subarray(2).toString('utf8') };
}

/** MSG_IN: contact_idx(1) · channel(1) · texto. */
export function buildMsgInPlaintext(contactIdx, channel, text) {
  return Buffer.concat([Buffer.from([contactIdx, channel]), Buffer.from(text, 'utf8')]);
}

/** CMD_RESULT: ref(2) · status(1) · texto. */
export function buildCmdResultPlaintext(ref, status, text) {
  const head = Buffer.alloc(3);
  head.writeUInt16BE(ref & 0xffff, 0);
  head.writeUInt8(status, 2);
  return Buffer.concat([head, Buffer.from(text, 'utf8')]);
}

function parseJsonText(buf) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new PacketError('CMD is not valid JSON');
  }
}

function isCommand(obj) {
  return Boolean(obj) && typeof obj.cmd === 'string' && Number.isInteger(obj.ref);
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** CMD: JSON UTF-8 {"cmd","ref","args"}. */
export function parseCmdPlaintext(pt) {
  const obj = parseJsonText(pt);
  if (!isCommand(obj)) throw new PacketError('CMD needs cmd and integer ref');
  return { cmd: obj.cmd, ref: obj.ref, args: isPlainObject(obj.args) ? obj.args : {} };
}

/** Índices de contacto 0..31 contenidos en el bitmask. */
export function contactIndicesOf(mask) {
  return Array.from({ length: 32 }, (_, i) => i).filter((i) => (mask >>> i) & 1);
}

/** Trunca a n bytes UTF-8 sin partir un carácter. */
export function truncateUtf8(str, maxBytes) {
  let buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  buf = buf.subarray(0, maxBytes);
  let s = buf.toString('utf8');
  while (s.endsWith('�')) s = s.slice(0, -1);
  return s;
}
