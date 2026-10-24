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

const intIn = (v, lo, hi, field) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new HttpError(400, `${field} must be an integer ${lo}..${hi}`);
  return v;
};
const strMax = (v, max, field) => {
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, `${field} must be a string up to ${max} chars`);
  return v;
};

// --- registrar_incidente ------------------------------------------------------------------

/**
 * Crea o actualiza el incidente. `args` sigue el esquema del contrato §7; `meta` trae datos del
 * transporte (saltos, egress) que el modelo nunca controla.
 */
export function registrarIncidente(ctx, args, meta = {}) {
  const senderId = strMax(args.sender_id, 16, 'sender_id');
  const incidentId = strMax(args.incident_id, 16, 'incident_id');
  if (!HEX16.test(senderId) || !HEX16.test(incidentId)) throw new HttpError(400, 'ids must be 16 hex chars');
  const fields = {
    category: intIn(args.category, 0, 7, 'category'),
    severity: intIn(args.severity, 0, 3, 'severity'),
    accuracyM: intIn(args.accuracy_m ?? 0, 0, 65535, 'accuracy_m'),
    locationAge: intIn(args.location_age_s ?? 0, 0, 65535, 'location_age_s'),
    publicText: strMax(args.public_text ?? '', 120, 'public_text'),
  };
  const hasLoc = Number.isInteger(args.lat) && Number.isInteger(args.lon);
  const now = ctx.now();
  const existing = ctx.store.getIncident(senderId, incidentId);
  const note = args.nota === undefined ? undefined : strMax(args.nota, 400, 'nota');

  if (!existing) {
    ctx.store.createIncident({
      senderId, incidentId, ...fields, lat: hasLoc ? args.lat : null, lon: hasLoc ? args.lon : null,
      locTimestamp: hasLoc ? (meta.timestamp ?? now) - fields.locationAge : null, note: note ?? null,
      status: fields.severity === 0 ? 'closed' : 'open', hops: meta.hops ?? null, egressId: meta.egressId ?? null,
      blobReadable: meta.blobReadable ?? false, seq: meta.seq ?? 0, now,
    });
    ctx.emit('incident_created', { senderId, incidentId, data: { category: fields.category, severity: fields.severity } });
    return { incidente_ref: `INC-${incidentId}`, creado: true };
  }

  const patch = { category: fields.category, severity: fields.severity, publicText: fields.publicText, updatedAt: now,
    lastSeq: Math.max(existing.last_seq, meta.seq ?? 0) };
  if (hasLoc) Object.assign(patch, { lat: args.lat, lon: args.lon, accuracyM: fields.accuracyM,
    locationAge: fields.locationAge, locTimestamp: (meta.timestamp ?? now) - fields.locationAge });
  if (note !== undefined) patch.note = note;
  if (meta.hops !== undefined && meta.hops !== null) patch.hops = meta.hops;
  if (fields.severity === 0) patch.status = 'closed';
  else if (existing.status === 'closed') patch.status = 'open';
  ctx.store.updateIncident(senderId, incidentId, patch);
  ctx.emit('incident_updated', { senderId, incidentId, data: { severity: fields.severity, status: patch.status ?? existing.status } });
  return { incidente_ref: `INC-${incidentId}`, creado: false };
}

// --- consultar_alertas ---------------------------------------------------------------------

const rad = (d) => (d * Math.PI) / 180;
export function distanceM(lat1, lon1, lat2, lon2) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

export function consultarAlertas(ctx, { lat, lon, radio_m: radioM, desde }) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new HttpError(400, 'lat/lon must be valid degrees');
  }
  const radius = Math.min(Math.max(Number(radioM) || 1000, 100), 50_000);
  const since = Number.isFinite(desde) ? desde : ctx.now() - 6 * 3600;
  const alertas = ctx.store.listIncidents({ status: 'open' })
    .filter((i) => i.lat !== null && i.updated_at >= since)
    .map((i) => ({ id: `INC-${i.incident_id}`, tipo: CATEGORY_LABELS[i.category] ?? 'otra', texto: i.public_text ?? '',
      distancia_m: Math.round(distanceM(lat, lon, i.lat / 1e5, i.lon / 1e5)) }))
    .filter((a) => a.distancia_m <= radius)
    .sort((a, b) => a.distancia_m - b.distancia_m)
    .slice(0, 10);
  return { alertas };
}

// --- avisar_contactos ----------------------------------------------------------------------

const mapUrl = (i) => (i.lat === null ? null : `https://maps.google.com/?q=${(i.lat / 1e5).toFixed(5)},${(i.lon / 1e5).toFixed(5)}`);

function templateText({ user, incident, contact, note, map, reply, lang }) {
  const cat = CATEGORY_LABELS[incident.category] ?? 'otra';
  if (lang === 'en') {
    return `Baliza Vital ALERT: ${user.display_name} asked for help (${cat}, severity ${incident.severity}/3).`
      + `${note ? ` Note: ${note}.` : ''}${map ? ` Location: ${map}.` : ''} Reply here: ${reply}`;
  }
  return `ALERTA Baliza Vital: ${user.display_name} pidió ayuda (${cat}, gravedad ${incident.severity}/3).`
    + `${note ? ` Nota: ${note}.` : ''}${map ? ` Ubicación: ${map}.` : ''} Responde aquí: ${reply}`;
}

const withTimeout = (promise, ms, fallback) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(fallback), ms);
  promise.then((v) => resolve(v), () => resolve(fallback)).finally(() => clearTimeout(timer));
});

/** Texto del aviso para un contacto: el LLM redacta, pero la plantilla manda si tarda o falla. */
function draftAlert(ctx, { user, incident, contact, note }) {
  const lang = contact.lang === 'en' ? 'en' : 'es';
  const map = mapUrl(incident);
  const reply = replyUrl(ctx, makeReplyToken(ctx, user.sender_id, incident.incident_id, contact.idx));
  const fallback = templateText({ user, incident, contact, note, map, reply, lang });
  const prompt = buildPrompt({ incident: { ...incident, categoryLabel: CATEGORY_LABELS[incident.category] ?? 'otra' },
    contact, mapUrl: map, replyUrl: reply, note, lang });
  return withTimeout(Promise.resolve().then(() => ctx.writer(prompt, fallback)), ctx.config.llm.timeoutMs, fallback)
    .then((text) => (text.includes(reply) ? text : `${text} ${reply}`));
}

/**
 * `avisar_contactos`. `senderId` viene de la sesión del agente (no de argumentos del modelo).
 * `mensaje` opcional: si falta, se redacta con la plantilla o el LLM.
 */
export async function avisarContactos(ctx, senderId, { incident_id: incidentId, canal, contactos, mensaje, note, drafts = new Map() }) {
  if (!CHANNEL_BITS[canal]) throw new HttpError(400, 'canal must be sms|email|llamada_voz');
  const incident = ctx.store.getIncident(senderId, incidentId) ?? { incident_id: incidentId, lat: null, lon: null, category: 0, severity: 0, public_text: '' };
  const user = ctx.store.getUser(senderId);
  if (!user) throw new HttpError(404, 'sender not registered');
  const all = ctx.store.getContacts(senderId);
  const wanted = contactos === 'todos' ? all : all.filter((c) => Array.isArray(contactos) && contactos.includes(c.idx));
  const channel = ctx.channels[CHANNEL_NAME[canal]];
  const enviados = [];
  const now = ctx.now();

  for (const c of wanted) {
    const addr = { sms: c.sms, email: c.email, voice: c.voice }[CHANNEL_NAME[canal]];
    let state;
    let detail = null;
    if (!addr) {
      state = 'no_address';
    } else if (channel.live && c.status !== 'verified' && !ctx.config.allowUnverifiedContacts) {
      state = 'skipped_unverified';
    } else {
      const lang = c.lang === 'en' ? 'en' : 'es';
      let text;
      const reply = replyUrl(ctx, makeReplyToken(ctx, senderId, incidentId, c.idx));
      if (mensaje) {
        text = `${user.display_name}: ${mensaje} ${reply}`;
      } else {
        // Un solo borrador por contacto, reutilizado en todos los canales.
        if (!drafts.has(c.idx)) drafts.set(c.idx, draftAlert(ctx, { user, incident, contact: c, note }));
        text = await drafts.get(c.idx);
      }
      try {
        const fields = { userName: user.display_name, category: CATEGORY_LABELS[incident.category] ?? 'otra',
          severity: incident.severity, map: mapUrl(incident), reply, text: mensaje };
        const r = await channel.send({ to: addr, subject: `Baliza Vital: ${user.display_name} necesita ayuda`, text,
          kind: mensaje ? 'message' : 'alert', fields, lang, contactName: c.name, incident });
        state = r.state;
        detail = r.detail;
      } catch (e) {
        state = 'failed';
        detail = e.message;
      }
    }
    ctx.store.addNotification({ senderId, incidentId, contactIdx: c.idx, channel: CHANNEL_NAME[canal], state, detail, at: now });
    enviados.push({ indice: c.idx, canal, estado: state });
  }
  ctx.emit('contacts_notified', { senderId, incidentId, data: { canal, enviados } });
  return { enviados };
}

/**
 * Plan del agente para un SOS: avisa por cada canal pedido y, si llegó a alguien, deja un ACK
 * "contactos avisados" (código 1) en el buzón. Si todo fue simulado, el ACK lo dice.
 */
export async function runSosAgent(ctx, { senderId, incidentId, seq, contactMask, channels, note }) {
  const indices = contactIndicesOf(contactMask);
  const canales = Object.entries(CHANNEL_BITS).filter(([, bit]) => channels & bit).map(([name]) => name);
  const reached = new Set();
  let simulated = true;
  // Los borradores de todos los contactos arrancan a la vez; ningún envío espera más de LLM_TIMEOUT_MS.
  const drafts = new Map();
  const user = ctx.store.getUser(senderId);
  const incident = ctx.store.getIncident(senderId, incidentId);
  if (user && incident) {
    for (const c of ctx.store.getContacts(senderId).filter((x) => indices.includes(x.idx))) {
      drafts.set(c.idx, draftAlert(ctx, { user, incident, contact: c, note }));
    }
  }
  for (const canal of canales) {
    const { enviados } = await avisarContactos(ctx, senderId, { incident_id: incidentId, canal, contactos: indices, note, drafts });
    for (const e of enviados) {
      if (e.estado === 'sent' || e.estado === 'simulated') {
        reached.add(e.indice);
        if (e.estado === 'sent') simulated = false;
      }
    }
  }
  ctx.store.updateIncident(senderId, incidentId, { notifiedCount: reached.size, updatedAt: ctx.now() });
  if (reached.size > 0) {
    const word = reached.size === 1 ? 'contacto avisado' : 'contactos avisados';
    queueAck(ctx, { senderId, incidentId, seq, code: 1, text: `${simulated ? '[SIMULADO] ' : ''}${reached.size} ${word}` });
  }
  return { avisados: [...reached] };
}
