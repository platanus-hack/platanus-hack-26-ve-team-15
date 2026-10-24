// Registro previo (contrato §6): POST /v1/users y PUT /v1/users/{sender_id}/contacts.
import { createHash } from 'node:crypto';
import { senderIdOf, verifyDetached } from './codec.js';
import { HttpError } from './http.js';

const MAX_CONTACTS = 32;
const CHANNEL_KEYS = ['sms', 'email', 'voice'];

const b64 = (v, bytes, field) => {
  const buf = typeof v === 'string' ? Buffer.from(v, 'base64') : Buffer.alloc(0);
  if (buf.length !== bytes) throw new HttpError(400, `${field} must be ${bytes} bytes (base64)`);
  return buf;
};

/** Prueba de posesión: `Ed25519(sk, SHA-256(cuerpo))` sobre los bytes crudos del cuerpo. */
function checkProofOfPossession(rawBody, pubkeyB64, signatureB64) {
  if (!pubkeyB64 || !signatureB64) throw new HttpError(401, 'missing X-Baliza-Pubkey / X-Baliza-Signature');
  const pk = Buffer.from(pubkeyB64, 'base64');
  const sig = Buffer.from(signatureB64, 'base64');
  if (!verifyDetached(createHash('sha256').update(rawBody).digest(), sig, pk)) throw new HttpError(401, 'invalid proof of possession');
  return pk;
}

function parseJson(rawBody) {
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

function cleanString(v, field, max, { required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, `${field} must be a string up to ${max} chars`);
  return v.trim();
}

export function validateContacts(list) {
  if (!Array.isArray(list) || list.length > MAX_CONTACTS) throw new HttpError(400, `contacts must be an array up to ${MAX_CONTACTS}`);
  const seen = new Set();
  return list.map((c) => {
    if (!c || typeof c !== 'object') throw new HttpError(400, 'invalid contact');
    if (!Number.isInteger(c.index) || c.index < 0 || c.index >= MAX_CONTACTS) throw new HttpError(400, 'contact.index must be 0..31');
    if (seen.has(c.index)) throw new HttpError(400, `duplicate contact index ${c.index}`);
    seen.add(c.index);
    const channels = {};
    for (const k of CHANNEL_KEYS) {
      const v = cleanString(c.channels?.[k], `contact.channels.${k}`, 120);
      if (v) channels[k] = v;
    }
    if (!Object.keys(channels).length) throw new HttpError(400, `contact ${c.index} needs at least one channel`);
    const lang = cleanString(c.lang, 'contact.lang', 8) ?? 'es';
    return { index: c.index, name: cleanString(c.name, 'contact.name', 80, { required: true }),
      relation: cleanString(c.relation, 'contact.relation', 40), lang, channels };
  });
}

const contactsView = (ctx, senderId) => ctx.store.getContacts(senderId).map((c) => ({ index: c.idx, status: c.status }));

export function registerUser(ctx, { rawBody, pubkeyB64, signatureB64 }) {
  const pk = checkProofOfPossession(rawBody, pubkeyB64, signatureB64);
  const body = parseJson(rawBody);
  if (!body || typeof body !== 'object') throw new HttpError(400, 'body must be an object');
  const signPk = b64(body.sign_pk_b64, 32, 'sign_pk_b64');
  if (!signPk.equals(pk)) throw new HttpError(400, 'sign_pk_b64 does not match X-Baliza-Pubkey');
  const sealPk = b64(body.seal_pk_b64, 32, 'seal_pk_b64');
  const displayName = cleanString(body.display_name, 'display_name', 80, { required: true });
  const contacts = validateContacts(body.contacts ?? []);
  const senderId = senderIdOf(signPk);
  const existing = ctx.store.getUser(senderId);
  ctx.store.upsertUser({ senderId, displayName, signPk, sealPk, now: ctx.now() });
  ctx.store.replaceContacts(senderId, contacts);
  ctx.emit(existing ? 'user_updated' : 'user_registered', { senderId, data: { display_name: displayName } });
  const { keys } = ctx;
  return {
    status: 201,
    body: {
      sender_id: senderId,
      server: { key_id: keys.keyId, sign_pk_b64: keys.signPk.toString('base64'), seal_pk_b64: keys.sealPk.toString('base64') },
      contacts: contactsView(ctx, senderId),
    },
  };
}

export function updateContacts(ctx, senderId, { rawBody, pubkeyB64, signatureB64 }) {
  const pk = checkProofOfPossession(rawBody, pubkeyB64, signatureB64);
  const user = ctx.store.getUser(senderId);
  if (!user) throw new HttpError(404, 'sender not registered');
  if (!Buffer.from(user.sign_pk).equals(pk)) throw new HttpError(401, 'key does not match registered user');
  const body = parseJson(rawBody);
  const contacts = validateContacts(Array.isArray(body) ? body : body?.contacts);
  ctx.store.replaceContacts(senderId, contacts);
  ctx.emit('contacts_updated', { senderId, data: { count: contacts.length } });
  return { status: 200, body: { sender_id: senderId, contacts: contactsView(ctx, senderId) } };
}
