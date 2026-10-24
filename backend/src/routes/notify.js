// Envío directo de un texto a un número por el canal de texto configurado (WhatsApp por Kapso, o Twilio).
// Es una ruta de administración: exige ADMIN_TOKEN y no existe (404) si no está configurado, porque de lo
// contrario cualquiera podría hacer que el servidor escriba a números ajenos.
import { HttpError } from '../http.js';
import { jsonBody, requireAdmin, route } from './helpers.js';

const MAX_MESSAGE_CHARS = 1000;
const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15; // E.164
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function parsePhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) throw new HttpError(400, 'phone must have 8 to 15 digits');
  return digits;
}

function parseMessage(message) {
  const text = typeof message === 'string' ? message.replace(CONTROL_CHARS, '').trim() : '';
  if (!text) throw new HttpError(400, 'message required');
  if ([...text].length > MAX_MESSAGE_CHARS) throw new HttpError(400, `message longer than ${MAX_MESSAGE_CHARS} characters`);
  return text;
}

/** `sender_id` e `incident_id` son opcionales y van juntos: asocian el envío a un incidente existente. */
function parseIncident(ctx, json) {
  if (json.sender_id === undefined && json.incident_id === undefined) return null;
  if (typeof json.sender_id !== 'string' || typeof json.incident_id !== 'string') throw new HttpError(400, 'sender_id and incident_id go together');
  const incident = ctx.store.getIncident(json.sender_id, json.incident_id);
  if (!incident) throw new HttpError(404, 'unknown incident');
  return incident;
}

function outgoing({ digits, text, incident }) {
  return {
    to: digits, text, kind: 'message', lang: 'es', contactName: digits,
    fields: { userName: 'Baliza Vital', text, reply: '-' }, incident: incident ?? { incident_id: null },
  };
}

function notifyHandler({ ctx, config, limiter }) {
  return async (c) => {
    requireAdmin(config, c);
    const { json } = await jsonBody(c.req);
    const digits = parsePhone(json.phone);
    const text = parseMessage(json.message);
    const incident = parseIncident(ctx, json);
    if (!limiter.hit(`notify:${digits}`, config.rate.senderPerMin, 60)) throw new HttpError(429, 'rate limit (notify)');
    const { state, detail } = await ctx.channels.sms.send(outgoing({ digits, text, incident }));
    if (incident) ctx.emit('direct_message', { senderId: incident.sender_id, incidentId: incident.incident_id, data: { state } });
    c.send(state === 'failed' ? 502 : 200, { ok: state !== 'failed', state, detail, to: `+${digits}`, incident_id: incident?.incident_id ?? null });
  };
}

export function notifyRoutes(app) {
  return [route('POST', '/v1/notify', notifyHandler(app))];
}
