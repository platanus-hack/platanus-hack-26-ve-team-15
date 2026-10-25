// Consentimiento del contacto por WhatsApp, por relación. «ACEPTO <código>» (el código viene en la invitación que
// le mandó el usuario, ver invites.js) prueba que el número es suyo y que acepta los avisos de ESE usuario: solo esa
// relación queda 'verified', aunque el número sea contacto de otros. «BAJA» lo revierte en todas sus relaciones;
// «BAJA <código>», solo en esa. El texto del contacto solo se compara con esas palabras: no pasa por el agente.
import { inviteCode, isInviteCode } from './invites.js';

const KEYWORDS = { ACEPTO: 'verified', BAJA: 'pending_verification' };
const MAX_NAMES = 3;
const MAX_NAME_CHARS = 40;

const TEXT = {
  needsCode: 'Para aceptar, toca el enlace de invitación que te envió la persona que te agregó en Baliza Vital: el mensaje ya lleva tu código. Si no lo tienes, pídele que te invite de nuevo.',
  wrongCode: 'Ese código no corresponde a ninguna invitación para este número. Usa el enlace que te enviaron o pide una invitación nueva.',
};

/**
 * «¡Aceptó!» → { word: 'ACEPTO', code: null }; «acepto k7m2qx9p gracias» → { word: 'ACEPTO', code: 'K7M2QX9P' }.
 * Si tras la palabra viene algo que no es un código («Acepto, voy para allá»), no es consentimiento: es una
 * respuesta al aviso.
 */
function parseConsent(text) {
  const tokens = String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim().split(/\s+/);
  const word = tokens[0].replace(/[^A-Z]/g, '');
  if (!Object.hasOwn(KEYWORDS, word)) return null;
  if (tokens.length === 1) return { word, code: null };
  const code = tokens[1].replace(/[^A-Z0-9]/g, '');
  return isInviteCode(code) ? { word, code } : null;
}

/** ACEPTO solo vale con el código de una relación. BAJA sin código deja todas (la dirección segura). */
function targetsOf(ctx, { word, code }, contacts) {
  if (!code) return word === 'BAJA' ? contacts : [];
  return contacts.filter((c) => inviteCode(ctx, c.sender_id, c.idx, c.sms) === code);
}

function namesOf(contacts) {
  const names = [...new Set(contacts.map((c) => c.display_name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS)))];
  const shown = names.slice(0, MAX_NAMES).join(', ');
  return names.length > MAX_NAMES ? `${shown} y ${names.length - MAX_NAMES} más` : shown;
}

function confirmation(word, names) {
  return word === 'ACEPTO'
    ? `Listo: quedaste como contacto de emergencia de ${names} en Baliza Vital. Si necesita ayuda te avisaremos por aquí. Escribe BAJA para dejar de recibir sus avisos.`
    : `Ya no recibirás avisos de Baliza Vital de ${names}. Para volver a recibirlos, usa el enlace de invitación.`;
}

function confirm(ctx, to, text) {
  ctx.defer(() => ctx.channels.sms.send({
    to, text, kind: 'message', lang: 'es', contactName: to,
    fields: { userName: 'Baliza Vital', text, reply: '-' }, incident: { incident_id: null },
  }));
}

function apply(ctx, word, targets) {
  for (const c of targets) {
    ctx.store.setContactStatus(c.sender_id, c.idx, KEYWORDS[word]);
    ctx.emit('contact_consent', { senderId: c.sender_id, data: { contact_idx: c.idx, accepted: word === 'ACEPTO' } });
  }
}

/**
 * Mensaje entrante de WhatsApp: si es ACEPTO/BAJA de un número que es contacto de alguien, cambia el estado de las
 * relaciones que correspondan y le contesta (en segundo plano, para responder al webhook enseguida). Un ACEPTO sin
 * código o con uno que no es suyo no cambia nada y nunca llega al usuario como respuesta. Null si no aplica.
 */
export function handleConsent(ctx, from, text, limiter) {
  const parsed = parseConsent(text);
  if (!parsed) return null;
  const contacts = ctx.store.findContactsByPhone(from.slice(-9));
  if (!contacts.length) return null;
  if (!limiter.hit(`consent:${from}`, ctx.config.rate.replyPerHour, 3600)) return { ignored: 'rate limit (consent)' };
  const targets = targetsOf(ctx, parsed, contacts);
  return targets.length ? settle(ctx, from, parsed.word, targets) : refuse(ctx, from, parsed);
}

/** Nada que cambiar: explica cómo aceptar (sin código) o que ese código no es de este número. */
function refuse(ctx, from, { code }) {
  confirm(ctx, from, code ? TEXT.wrongCode : TEXT.needsCode);
  return { consent: code ? 'invalid_code' : 'needs_code' };
}

function settle(ctx, from, word, targets) {
  apply(ctx, word, targets);
  confirm(ctx, from, confirmation(word, namesOf(targets)));
  return { consent: word === 'ACEPTO' ? 'accepted' : 'revoked', contacts: targets.length };
}
