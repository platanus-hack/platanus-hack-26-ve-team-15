// Respuestas de contactos (MSG_IN). El texto de un contacto es dato no confiable: se sella tal cual al
// usuario y se deja en el buzón. NO pasa por el agente ni por ninguna herramienta (contrato §7).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CHANNEL } from './codec.js';
import { handleConsent } from './consent.js';
import { queueMsgIn } from './context.js';
import { HttpError } from './http.js';
import { parseReplyToken } from './tokens.js';

const MAX_REPLY_CHARS = 240;
const CHANNEL_CODE = { sms: CHANNEL.SMS, email: CHANNEL.EMAIL, voice: CHANNEL.VOICE };

function cleanReply(text) {
  return String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, MAX_REPLY_CHARS);
}

function loadReplyTarget(ctx, { senderId, incidentId, contactIdx }) {
  const user = ctx.store.getUser(senderId);
  const incident = ctx.store.getIncident(senderId, incidentId);
  const contact = ctx.store.getContact(senderId, contactIdx);
  if (!user || !incident || !contact) throw new HttpError(404, 'unknown incident or contact');
  return { user, contact };
}

export function ingestReply(ctx, input) {
  const { senderId, incidentId, contactIdx, channel } = input;
  const { user, contact } = loadReplyTarget(ctx, input);
  const clean = cleanReply(input.text);
  if (!clean) throw new HttpError(400, 'empty reply');
  const { id, seq } = queueMsgIn(ctx, user, incidentId, { contactIdx, channel: CHANNEL_CODE[channel] ?? CHANNEL.SMS, text: clean });
  // Responder demuestra que el número/correo es del contacto: queda verificado.
  if (contact.status !== 'verified') ctx.store.setContactStatus(senderId, contactIdx, 'verified');
  ctx.emit('contact_reply', { senderId, incidentId, data: { contact_idx: contactIdx, channel, chars: clean.length, mailbox_id: id, seq } });
  return { mailbox_id: id, seq };
}

export function replyByToken(ctx, token, text, channel, limiter) {
  const t = parseReplyToken(ctx, token);
  if (!t) throw new HttpError(404, 'invalid reply link');
  if (!limiter.hit(`reply:${token}`, ctx.config.rate.replyPerHour, 3600)) throw new HttpError(429, 'rate limit (reply)');
  return ingestReply(ctx, { ...t, channel, text });
}

function digitsOnly(s) {
  return String(s ?? '').replace(/\D/g, '');
}

/** Webhook de SMS entrante (formato Twilio: From, Body): se asocia al último incidente avisado a ese número. */
export function replyByPhone(ctx, from, body, limiter) {
  const d = digitsOnly(from);
  if (d.length < 7) throw new HttpError(400, 'invalid sender number');
  if (!limiter.hit(`reply-phone:${d}`, ctx.config.rate.replyPerHour, 3600)) throw new HttpError(429, 'rate limit (reply)');
  const hit = ctx.store.findNotifiedIncidentByPhone(d.slice(-9));
  if (!hit) throw new HttpError(404, 'no incident for that number');
  return ingestReply(ctx, { senderId: hit.sender_id, incidentId: hit.incident_id, contactIdx: hit.contact_idx, channel: 'sms', text: body });
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

const PAGE = readFileSync(new URL('./reply-page.html', import.meta.url), 'utf8');
const SENT_HTML = '<p class="ok">Enviado. Gracias.</p>';

/** Página mínima para responder desde el enlace del aviso (sin cuentas ni JS). */
export function replyPage(ctx, token, { sent = false } = {}) {
  const t = parseReplyToken(ctx, token);
  if (!t) throw new HttpError(404, 'invalid reply link');
  const user = ctx.store.getUser(t.senderId);
  const contact = ctx.store.getContact(t.senderId, t.contactIdx);
  if (!user || !contact) throw new HttpError(404, 'unknown incident');
  const values = { contact: esc(contact.name), user: esc(user.display_name), sent: sent ? SENT_HTML : '', token: esc(token), max: MAX_REPLY_CHARS };
  return PAGE.replace(/\{\{(\w+)\}\}/g, (_, k) => values[k]);
}

// --- WhatsApp (Kapso) --------------------------------------------------------------------------

export function isValidKapsoSignature(rawBody, signatureHeader, secret) {
  if (typeof signatureHeader !== 'string' || !secret) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'utf8');
  const given = Buffer.from(signatureHeader, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const MAX_SEEN = 5000;

const STATUS_BY_EVENT = new Map([
  ['whatsapp.message.delivered', 'delivered'], ['whatsapp.message.read', 'read'], ['whatsapp.message.failed', 'failed'],
]);

// El ejemplo de Kapso no siempre trae `type`: sin él vale el texto; con otro tipo (imagen, audio…) se ignora
// aunque `kapso.content` describa el medio.
function inboundText(msg) {
  if (msg.type && msg.type !== 'text') return null;
  return msg.text?.body ?? msg.kapso?.content ?? null;
}

function replyIgnoringUnknown(ctx, from, body, limiter) {
  try {
    return { mailbox_id: replyByPhone(ctx, from, body, limiter).mailbox_id };
  } catch (e) {
    if (e instanceof HttpError) return { ignored: e.message };
    throw e;
  }
}

/** Mensaje entrante: abre la ventana de 24 h para texto libre y, si es texto, entra como respuesta (MSG_IN). */
function handleInbound(ctx, payload, limiter) {
  const msg = payload?.message ?? {};
  const from = digitsOnly(msg.from ?? payload?.conversation?.phone_number);
  if (from.length < 7) return { ignored: 'no sender' };
  ctx.store.touchWaInbound(from, ctx.now());
  const body = inboundText(msg);
  if (!body) return { ignored: 'not a text message' };
  return handleConsent(ctx, from, body, limiter) ?? replyIgnoringUnknown(ctx, from, body, limiter);
}

function handleStatus(ctx, status, msg) {
  const n = ctx.store.updateNotificationByWamid(msg.id, status);
  if (n) ctx.emit('notification_status', { data: { status, wamid: msg.id } });
  return { updated: n };
}

/**
 * Evento de webhook de Kapso ya autenticado. Devuelve siempre un resumen (el webhook responde 200 aunque
 * el mensaje no corresponda a ningún aviso, para que Kapso no reintente).
 *  - whatsapp.message.received: ver handleInbound.
 *  - whatsapp.message.delivered|read|failed: actualiza el estado del aviso.
 */
export function handleKapsoEvent(ctx, event, payload, limiter) {
  if (event === 'whatsapp.message.received') return handleInbound(ctx, payload, limiter);
  const status = STATUS_BY_EVENT.get(event);
  const msg = payload?.message ?? {};
  if (status && typeof msg.id === 'string') return handleStatus(ctx, status, msg);
  return { ignored: `event ${event}` };
}

export function createWebhookDeduper() {
  const seen = new Set();
  return (key) => {
    if (!key) return false;
    if (seen.has(key)) return true;
    seen.add(key);
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
    return false;
  };
}
