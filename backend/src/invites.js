// Códigos de invitación por relación (usuario, contacto). El usuario se los manda a su contacto en un enlace de
// WhatsApp; el contacto responde «ACEPTO <código>» y solo esa relación queda verificada (consent.js).
// No se guardan: son un HMAC de la fila (usuario, índice, teléfono), así que cambian si cambia el teléfono.
import { createHmac } from 'node:crypto';

// Crockford base32: sin I, L, O ni U, para que no se confundan al leerlos.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const INVITE_CODE_LENGTH = 8; // 40 bits
const CODE_RE = new RegExp(`^[${ALPHABET}]{${INVITE_CODE_LENGTH}}$`);

const digitsOf = (phone) => String(phone ?? '').replace(/\D/g, '');

/** El código de la relación, o null si el contacto no tiene teléfono (no puede escribir por WhatsApp). */
export function inviteCode(ctx, senderId, idx, phone) {
  const digits = digitsOf(phone);
  if (!digits) return null;
  const mac = createHmac('sha256', ctx.keys.replySecret).update(`invite:${senderId}:${idx}:${digits}`).digest();
  let bits = mac.readUIntBE(0, 5);
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    code = ALPHABET[bits % 32] + code;
    bits = Math.floor(bits / 32);
  }
  return code;
}

export const isInviteCode = (text) => CODE_RE.test(text);
