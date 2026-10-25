// Consentimiento del contacto por WhatsApp. Escribir «ACEPTO» desde su número prueba que el número es suyo y
// que acepta recibir avisos: queda 'verified' en todos los usuarios que lo agregaron. «BAJA» lo revierte.
// El texto del contacto solo se compara con esas dos palabras: no pasa por el agente ni por ninguna herramienta.

const KEYWORDS = { ACEPTO: 'verified', BAJA: 'pending_verification' };
const MAX_NAMES = 3;
const MAX_NAME_CHARS = 40;

/** «¡Aceptó!», « acepto. » → 'ACEPTO'. Cualquier otro texto no es una palabra clave. */
function keywordOf(text) {
  const word = String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '');
  return Object.hasOwn(KEYWORDS, word) ? word : null;
}

function namesOf(contacts) {
  const names = [...new Set(contacts.map((c) => c.display_name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS)))];
  const shown = names.slice(0, MAX_NAMES).join(', ');
  return names.length > MAX_NAMES ? `${shown} y ${names.length - MAX_NAMES} más` : shown;
}

function confirmation(word, names) {
  return word === 'ACEPTO'
    ? `Listo: quedaste como contacto de emergencia de ${names} en Baliza Vital. Si necesita ayuda te avisaremos por aquí. Escribe BAJA para dejar de recibir sus avisos.`
    : `Ya no recibirás avisos de Baliza Vital de ${names}. Escribe ACEPTO si quieres volver a recibirlos.`;
}

function confirm(ctx, to, text) {
  ctx.defer(() => ctx.channels.sms.send({
    to, text, kind: 'message', lang: 'es', contactName: to,
    fields: { userName: 'Baliza Vital', text, reply: '-' }, incident: { incident_id: null },
  }));
}

/**
 * Mensaje entrante de WhatsApp: si es ACEPTO/BAJA de un número que es contacto de alguien, cambia su estado y
 * le confirma (en segundo plano, para responder al webhook enseguida). Devuelve null si no aplica.
 */
export function handleConsent(ctx, from, text, limiter) {
  const word = keywordOf(text);
  if (!word) return null;
  const contacts = ctx.store.findContactsByPhone(from.slice(-9));
  if (!contacts.length) return null;
  if (!limiter.hit(`consent:${from}`, ctx.config.rate.replyPerHour, 3600)) return { ignored: 'rate limit (consent)' };
  for (const c of contacts) {
    ctx.store.setContactStatus(c.sender_id, c.idx, KEYWORDS[word]);
    ctx.emit('contact_consent', { senderId: c.sender_id, data: { contact_idx: c.idx, accepted: word === 'ACEPTO' } });
  }
  confirm(ctx, from, confirmation(word, namesOf(contacts)));
  return { consent: word === 'ACEPTO' ? 'accepted' : 'revoked', contacts: contacts.length };
}
