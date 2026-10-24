// Enlaces de respuesta para contactos: token firmado con HMAC que identifica (usuario, incidente, contacto).
// Quien tiene el enlace puede responder a ese incidente, nada más.
import { createHmac, timingSafeEqual } from 'node:crypto';

const PAYLOAD_BYTES = 17; // sender_id (8) + incident_id (8) + índice de contacto (1)
const MAC_BYTES = 16;
const MAX_TOKEN_CHARS = 100;

function b64u(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function macOf(ctx, payload) {
  return createHmac('sha256', ctx.keys.replySecret).update(payload).digest().subarray(0, MAC_BYTES);
}

function macMatches(given, expected) {
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** `[payload, mac]` decodificados, o null si el texto no tiene la forma `payload.mac`. */
function splitToken(token) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_CHARS) return null;
  const [p, m] = token.split('.');
  if (!p || !m) return null;
  return [Buffer.from(p, 'base64url'), Buffer.from(m, 'base64url')];
}

export function makeReplyToken(ctx, senderId, incidentId, contactIdx) {
  const payload = Buffer.concat([Buffer.from(senderId, 'hex'), Buffer.from(incidentId, 'hex'), Buffer.from([contactIdx])]);
  return `${b64u(payload)}.${b64u(macOf(ctx, payload))}`;
}

/** Devuelve { senderId, incidentId, contactIdx } o null si el token no es válido. */
export function parseReplyToken(ctx, token) {
  const parts = splitToken(token);
  if (!parts) return null;
  const [payload, mac] = parts;
  if (payload.length !== PAYLOAD_BYTES || !macMatches(mac, macOf(ctx, payload))) return null;
  return {
    senderId: payload.subarray(0, 8).toString('hex'),
    incidentId: payload.subarray(8, 16).toString('hex'),
    contactIdx: payload[16],
  };
}

export function replyUrl(ctx, token) {
  return `${ctx.config.publicBaseUrl}/r/${token}`;
}
