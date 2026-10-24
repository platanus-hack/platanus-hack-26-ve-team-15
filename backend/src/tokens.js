// Enlaces de respuesta para contactos: token firmado con HMAC que identifica (usuario, incidente, contacto).
// Quien tiene el enlace puede responder a ese incidente, nada más.
import { createHmac, timingSafeEqual } from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');

export function makeReplyToken(ctx, senderId, incidentId, contactIdx) {
  const payload = Buffer.concat([Buffer.from(senderId, 'hex'), Buffer.from(incidentId, 'hex'), Buffer.from([contactIdx])]);
  const mac = createHmac('sha256', ctx.keys.replySecret).update(payload).digest().subarray(0, 16);
  return `${b64u(payload)}.${b64u(mac)}`;
}

/** Devuelve { senderId, incidentId, contactIdx } o null si el token no es válido. */
export function parseReplyToken(ctx, token) {
  if (typeof token !== 'string' || token.length > 100) return null;
  const [p, m] = token.split('.');
  if (!p || !m) return null;
  const payload = Buffer.from(p, 'base64url');
  const mac = Buffer.from(m, 'base64url');
  if (payload.length !== 17) return null;
  const expected = createHmac('sha256', ctx.keys.replySecret).update(payload).digest().subarray(0, 16);
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  return {
    senderId: payload.subarray(0, 8).toString('hex'),
    incidentId: payload.subarray(8, 16).toString('hex'),
    contactIdx: payload[16],
  };
}

export const replyUrl = (ctx, token) => `${ctx.config.publicBaseUrl}/r/${token}`;
