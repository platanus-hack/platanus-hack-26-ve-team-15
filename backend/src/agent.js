// Agente de emergencias (contrato §7). El plan es determinista y vive en código: un SOS ejecuta
// `registrar_incidente` y `avisar_contactos`. El LLM, si hay API key, solo redacta el texto del aviso
// (ver llm.js) y no tiene herramientas, así que nada escrito por usuarios o contactos las invoca.
import { CHANNEL, contactIndicesOf } from './codec.js';
import { HttpError } from './http.js';
import { queueAck } from './context.js';
import { buildPrompt } from './llm.js';
import { makeReplyToken, replyUrl } from './tokens.js';

export const CATEGORY_LABELS = ['sin categoría', 'médica', 'incendio', 'seguridad/violencia', 'accidente',
  'desastre natural', 'atrapado/perdido', 'otra'];

const HEX16 = /^[0-9a-f]{16}$/;
const CHANNEL_BITS = { sms: CHANNEL.SMS, email: CHANNEL.EMAIL, llamada_voz: CHANNEL.VOICE };
const CHANNEL_NAME = { sms: 'sms', email: 'email', llamada_voz: 'voice' };
const NO_LOCATION_ROW = { lat: null, lon: null, locTimestamp: null };

function labelOf(category) {
  return CATEGORY_LABELS[category] ?? 'otra';
}

function intIn(v, lo, hi, field) {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new HttpError(400, `${field} must be an integer ${lo}..${hi}`);
  return v;
}

function strMax(v, max, field) {
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, `${field} must be a string up to ${max} chars`);
  return v;
}

// --- registrar_incidente ------------------------------------------------------------------

function parseIds(args) {
  const senderId = strMax(args.sender_id, 16, 'sender_id');
  const incidentId = strMax(args.incident_id, 16, 'incident_id');
  if (!HEX16.test(senderId) || !HEX16.test(incidentId)) throw new HttpError(400, 'ids must be 16 hex chars');
  return { senderId, incidentId };
}

function parseFields(args) {
  return {
    category: intIn(args.category, 0, 7, 'category'),
    severity: intIn(args.severity, 0, 3, 'severity'),
    accuracyM: intIn(args.accuracy_m ?? 0, 0, 65535, 'accuracy_m'),
    locationAge: intIn(args.location_age_s ?? 0, 0, 65535, 'location_age_s'),
    publicText: strMax(args.public_text ?? '', 120, 'public_text'),
  };
}

function parseNote(args) {
  return args.nota === undefined ? undefined : strMax(args.nota, 400, 'nota');
}

function hasLocation(args) {
  return Number.isInteger(args.lat) && Number.isInteger(args.lon);
}

/** Ubicación y precisión a guardar; vacío si el paquete no trae ubicación (se conserva la anterior). */
function locationFields({ args, fields, meta, now }) {
  if (!hasLocation(args)) return {};
  return {
    lat: args.lat, lon: args.lon, accuracyM: fields.accuracyM, locationAge: fields.locationAge,
    locTimestamp: (meta.timestamp ?? now) - fields.locationAge,
  };
}

function metaDefaults(meta) {
  return { hops: meta.hops ?? null, egressId: meta.egressId ?? null, blobReadable: meta.blobReadable ?? false, seq: meta.seq ?? 0 };
}

function newIncidentRow(input) {
  const { senderId, incidentId, fields, note, meta, now } = input;
  const m = metaDefaults(meta);
  return {
    senderId, incidentId, ...fields, ...NO_LOCATION_ROW, ...locationFields(input), note: note ?? null,
    status: fields.severity === 0 ? 'closed' : 'open', hops: m.hops, egressId: m.egressId, blobReadable: m.blobReadable, seq: m.seq, now,
  };
}

function statusPatch(existing, severity) {
  if (severity === 0) return { status: 'closed' };
  if (existing.status === 'closed') return { status: 'open' };
  return {};
}

function hopsPatch(meta) {
  return meta.hops === undefined || meta.hops === null ? {} : { hops: meta.hops };
}

function notePatch(note) {
  return note === undefined ? {} : { note };
}

function updatePatch(existing, input) {
  const { fields, note, meta, now } = input;
  return {
    category: fields.category, severity: fields.severity, publicText: fields.publicText, updatedAt: now,
    lastSeq: Math.max(existing.last_seq, meta.seq ?? 0),
    ...locationFields(input), ...notePatch(note), ...hopsPatch(meta), ...statusPatch(existing, fields.severity),
  };
}

function createNew(ctx, input) {
  const { senderId, incidentId, fields } = input;
  ctx.store.createIncident(newIncidentRow(input));
  ctx.emit('incident_created', { senderId, incidentId, data: { category: fields.category, severity: fields.severity } });
  return { incidente_ref: `INC-${incidentId}`, creado: true };
}

function updateExisting(ctx, existing, input) {
  const { senderId, incidentId, fields } = input;
  const patch = updatePatch(existing, input);
  ctx.store.updateIncident(senderId, incidentId, patch);
  ctx.emit('incident_updated', { senderId, incidentId, data: { severity: fields.severity, status: patch.status ?? existing.status } });
  return { incidente_ref: `INC-${incidentId}`, creado: false };
}

/**
 * Crea o actualiza el incidente. `args` sigue el esquema del contrato §7; `meta` trae datos del
 * transporte (saltos, egress) que el modelo nunca controla.
 */
export function registrarIncidente(ctx, args, meta = {}) {
  const { senderId, incidentId } = parseIds(args);
  const fields = parseFields(args);
  const input = { senderId, incidentId, args, fields, note: parseNote(args), meta, now: ctx.now() };
  const existing = ctx.store.getIncident(senderId, incidentId);
  return existing ? updateExisting(ctx, existing, input) : createNew(ctx, input);
}

// --- consultar_alertas ---------------------------------------------------------------------

function rad(degrees) {
  return (degrees * Math.PI) / 180;
}

export function distanceM(lat1, lon1, lat2, lon2) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

function isDegrees(v, limit) {
  return typeof v === 'number' && v >= -limit && v <= limit;
}

function alertRadius(radioM) {
  return Math.min(Math.max(Number(radioM) || 1000, 100), 50_000);
}

function alertsSince(ctx, desde) {
  return Number.isFinite(desde) ? desde : ctx.now() - 6 * 3600;
}

function toAlert(i, lat, lon) {
  return {
    id: `INC-${i.incident_id}`, tipo: labelOf(i.category), texto: i.public_text ?? '',
    distancia_m: Math.round(distanceM(lat, lon, i.lat / 1e5, i.lon / 1e5)),
  };
}

export function consultarAlertas(ctx, { lat, lon, radio_m: radioM, desde }) {
  if (!isDegrees(lat, 90) || !isDegrees(lon, 180)) throw new HttpError(400, 'lat/lon must be valid degrees');
  const radius = alertRadius(radioM);
  const since = alertsSince(ctx, desde);
  const alertas = ctx.store.listIncidents({ status: 'open' })
    .filter((i) => i.lat !== null && i.updated_at >= since)
    .map((i) => toAlert(i, lat, lon))
    .filter((a) => a.distancia_m <= radius)
    .sort((a, b) => a.distancia_m - b.distancia_m)
    .slice(0, 10);
  return { alertas };
}

// --- avisar_contactos ----------------------------------------------------------------------

function mapUrl(i) {
  if (i.lat === null) return null;
  return `https://maps.google.com/?q=${(i.lat / 1e5).toFixed(5)},${(i.lon / 1e5).toFixed(5)}`;
}

function templateText({ user, incident, note, map, reply, lang }) {
  const cat = labelOf(incident.category);
  if (lang === 'en') {
    return `Meshy ALERT: ${user.display_name} asked for help (${cat}, severity ${incident.severity}/3).`
      + `${note ? ` Note: ${note}.` : ''}${map ? ` Location: ${map}.` : ''} Reply here: ${reply}`;
  }
  return `ALERTA Meshy: ${user.display_name} pidió ayuda (${cat}, gravedad ${incident.severity}/3).`
    + `${note ? ` Nota: ${note}.` : ''}${map ? ` Ubicación: ${map}.` : ''} Responde aquí: ${reply}`;
}

function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then((v) => resolve(v), () => resolve(fallback)).finally(() => clearTimeout(timer));
  });
}

function langOf(contact) {
  return contact.lang === 'en' ? 'en' : 'es';
}

/** Texto del aviso para un contacto: el LLM redacta, pero la plantilla manda si tarda o falla. */
function draftAlert(ctx, { user, incident, contact, note }) {
  const lang = langOf(contact);
  const map = mapUrl(incident);
  const reply = replyUrl(ctx, makeReplyToken(ctx, user.sender_id, incident.incident_id, contact.idx));
  const fallback = templateText({ user, incident, note, map, reply, lang });
  const prompt = buildPrompt({ incident: { ...incident, categoryLabel: labelOf(incident.category) }, contact, mapUrl: map, replyUrl: reply, note, lang });
  return withTimeout(Promise.resolve().then(() => ctx.writer(prompt, fallback)), ctx.config.llm.timeoutMs, fallback)
    .then((text) => (text.includes(reply) ? text : `${text} ${reply}`));
}

function fallbackIncident(incidentId) {
  return { incident_id: incidentId, lat: null, lon: null, category: 0, severity: 0, public_text: '' };
}

function wantedContacts(all, contactos) {
  if (contactos === 'todos') return all;
  return all.filter((c) => Array.isArray(contactos) && contactos.includes(c.idx));
}

function isBlocked(ctx, channel, contact) {
  return channel.live && contact.status !== 'verified' && !ctx.config.allowUnverifiedContacts;
}

/** Un solo borrador por contacto, reutilizado en todos los canales. */
function contactText(s, contact, reply) {
  if (s.mensaje) return `${s.user.display_name}: ${s.mensaje} ${reply}`;
  if (!s.drafts.has(contact.idx)) s.drafts.set(contact.idx, draftAlert(s.ctx, { user: s.user, incident: s.incident, contact, note: s.note }));
  return s.drafts.get(contact.idx);
}

function alertFields(s, reply) {
  const { user, incident } = s;
  return { userName: user.display_name, category: labelOf(incident.category), severity: incident.severity, map: mapUrl(incident), reply, text: s.mensaje };
}

async function deliver(s, contact, addr, reply) {
  try {
    const text = await contactText(s, contact, reply);
    const r = await s.channel.send({ to: addr, subject: `Meshy: ${s.user.display_name} necesita ayuda`, text,
      kind: s.mensaje ? 'message' : 'alert', fields: alertFields(s, reply), lang: langOf(contact), contactName: contact.name, incident: s.incident });
    return { state: r.state, detail: r.detail };
  } catch (e) {
    return { state: 'failed', detail: e.message };
  }
}

async function notifyContact(s, contact) {
  const addr = contact[CHANNEL_NAME[s.canal]];
  if (!addr) return { state: 'no_address', detail: null };
  if (isBlocked(s.ctx, s.channel, contact)) return { state: 'skipped_unverified', detail: null };
  return deliver(s, contact, addr, replyUrl(s.ctx, makeReplyToken(s.ctx, s.senderId, s.incidentId, contact.idx)));
}

/**
 * `avisar_contactos`. `senderId` viene de la sesión del agente (no de argumentos del modelo).
 * `mensaje` opcional: si falta, se redacta con la plantilla o el LLM.
 */
export async function avisarContactos(ctx, senderId, { incident_id: incidentId, canal, contactos, mensaje, note, drafts = new Map() }) {
  if (!CHANNEL_BITS[canal]) throw new HttpError(400, 'canal must be sms|email|llamada_voz');
  const user = ctx.store.getUser(senderId);
  if (!user) throw new HttpError(404, 'sender not registered');
  const incident = ctx.store.getIncident(senderId, incidentId) ?? fallbackIncident(incidentId);
  const s = { ctx, senderId, incidentId, canal, user, incident, channel: ctx.channels[CHANNEL_NAME[canal]], mensaje, note, drafts };
  const enviados = [];
  for (const contact of wantedContacts(ctx.store.getContacts(senderId), contactos)) {
    const { state, detail } = await notifyContact(s, contact);
    ctx.store.addNotification({ senderId, incidentId, contactIdx: contact.idx, channel: CHANNEL_NAME[canal], state, detail, at: ctx.now() });
    enviados.push({ indice: contact.idx, canal, estado: state });
  }
  ctx.emit('contacts_notified', { senderId, incidentId, data: { canal, enviados } });
  return { enviados };
}

// --- plan del agente para un SOS -----------------------------------------------------------

function channelNames(channels) {
  return Object.entries(CHANNEL_BITS).filter(([, bit]) => channels & bit).map(([name]) => name);
}

/** Los borradores de todos los contactos arrancan a la vez; ningún envío espera más de LLM_TIMEOUT_MS. */
function startDrafts(ctx, { senderId, incidentId, indices, note }) {
  const drafts = new Map();
  const user = ctx.store.getUser(senderId);
  const incident = ctx.store.getIncident(senderId, incidentId);
  if (!user || !incident) return drafts;
  for (const c of ctx.store.getContacts(senderId).filter((x) => indices.includes(x.idx))) {
    drafts.set(c.idx, draftAlert(ctx, { user, incident, contact: c, note }));
  }
  return drafts;
}

/** Anota a quién se llegó; devuelve true si algún envío fue real (no simulado). */
function tally(enviados, reached) {
  let real = false;
  for (const e of enviados) {
    if (e.estado !== 'sent' && e.estado !== 'simulated') continue;
    reached.add(e.indice);
    real = real || e.estado === 'sent';
  }
  return real;
}

function ackText(count, anyReal) {
  const word = count === 1 ? 'contacto avisado' : 'contactos avisados';
  return `${anyReal ? '' : '[SIMULADO] '}${count} ${word}`;
}

/**
 * Plan del agente para un SOS: avisa por cada canal pedido y, si llegó a alguien, deja un ACK
 * "contactos avisados" (código 1) en el buzón. Si todo fue simulado, el ACK lo dice.
 */
export async function runSosAgent(ctx, { senderId, incidentId, seq, contactMask, channels, note }) {
  const indices = contactIndicesOf(contactMask);
  const drafts = startDrafts(ctx, { senderId, incidentId, indices, note });
  const reached = new Set();
  let anyReal = false;
  for (const canal of channelNames(channels)) {
    const { enviados } = await avisarContactos(ctx, senderId, { incident_id: incidentId, canal, contactos: indices, note, drafts });
    anyReal = tally(enviados, reached) || anyReal;
  }
  ctx.store.updateIncident(senderId, incidentId, { notifiedCount: reached.size, updatedAt: ctx.now() });
  if (reached.size > 0) queueAck(ctx, { senderId, incidentId, seq, code: 1, text: ackText(reached.size, anyReal) });
  return { avisados: [...reached] };
}
