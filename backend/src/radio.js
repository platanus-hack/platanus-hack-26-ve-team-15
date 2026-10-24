// Envío por radio (contrato §5.1, R5): presencia de egress, selección por cercanía e inbox con long-poll.
import { MSG } from './codec.js';
import { HttpError } from './http.js';

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const CELL_RE = /^[0-9bcdefghjkmnpqrstuvwxyz]{6}$/;
const MAX_EGRESS_TARGETS = 5;
const MIN_RADIUS_M = 300;
const MAX_RADIUS_M = 5000;
const WALK_SPEED_MS = 2;

export function geohashBounds(hash) {
  let lat = [-90, 90];
  let lon = [-180, 180];
  let even = true;
  for (const ch of hash) {
    const bits = BASE32.indexOf(ch);
    for (let mask = 16; mask; mask >>= 1) {
      const range = even ? lon : lat;
      const mid = (range[0] + range[1]) / 2;
      if (bits & mask) range[0] = mid;
      else range[1] = mid;
      even = !even;
    }
  }
  return { latMin: lat[0], latMax: lat[1], lonMin: lon[0], lonMax: lon[1] };
}

export function geohashEncode(latDeg, lonDeg, precision = 6) {
  let lat = [-90, 90];
  let lon = [-180, 180];
  let even = true;
  let bit = 0;
  let ch = 0;
  let out = '';
  while (out.length < precision) {
    const range = even ? lon : lat;
    const v = even ? lonDeg : latDeg;
    const mid = (range[0] + range[1]) / 2;
    ch <<= 1;
    if (v >= mid) { ch |= 1; range[0] = mid; } else range[1] = mid;
    even = !even;
    if (++bit === 5) { out += BASE32[ch]; bit = 0; ch = 0; }
  }
  return out;
}

const rad = (d) => (d * Math.PI) / 180;
function haversineM(lat1, lon1, lat2, lon2) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

/** Distancia del punto a la celda (0 si está dentro): se acota al punto más cercano del rectángulo. */
function distanceToCellM(lat, lon, cell) {
  const b = geohashBounds(cell);
  return haversineM(lat, lon, Math.min(Math.max(lat, b.latMin), b.latMax), Math.min(Math.max(lon, b.lonMin), b.lonMax));
}

/** `radio = clamp(accuracy_m + 2 m/s × (ahora − t_fix), 300 m, 5 km)`; null si el incidente no tiene ubicación. */
export function searchCircle(incident, now) {
  if (incident.lat === null || incident.lat === undefined) return null;
  const elapsed = Math.max(0, now - (incident.loc_timestamp ?? incident.updated_at));
  const radius = Math.min(Math.max(incident.accuracy_m + WALK_SPEED_MS * elapsed, MIN_RADIUS_M), MAX_RADIUS_M);
  return { lat: incident.lat / 1e5, lon: incident.lon / 1e5, radius };
}

/** Egress objetivo: el que subió el paquete (si sigue con presencia) y los 5 más cercanos cuya celda toque el círculo. */
export function selectEgress(ctx, incident, now = ctx.now()) {
  const presence = ctx.store.listPresence(now);
  const targets = new Set();
  if (incident.egress_id && presence.some((p) => p.egress_id === incident.egress_id)) targets.add(incident.egress_id);
  const circle = searchCircle(incident, now);
  if (circle) {
    presence
      .map((p) => ({ id: p.egress_id, d: distanceToCellM(circle.lat, circle.lon, p.cell) }))
      .filter((p) => p.d <= circle.radius)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_EGRESS_TARGETS)
      .forEach((p) => targets.add(p.id));
  }
  return [...targets];
}

function pushEntry(ctx, entry) {
  const incident = ctx.store.getIncident(entry.sender_id, entry.incident_id);
  if (!incident) return 0;
  const targets = selectEgress(ctx, incident);
  for (const egressId of targets) ctx.store.enqueueRadio(egressId, entry.id);
  if (targets.length) ctx.bus.emit('radio', targets);
  return targets.length;
}

/** Gancho de `ctx.onMailbox`: empuja a egress cercanos los tipos 3, 5 y 7 recién encolados. */
export function pushToRadio(ctx, { id, msgType }) {
  if (![MSG.ACK, MSG.MSG_IN, MSG.CMD_RESULT].includes(msgType)) return;
  const entry = ctx.store.getMailboxEntry(id);
  if (entry) pushEntry(ctx, entry);
}

/** Repite cada 60 s (con el radio actualizado) los mensajes 5/7 que el rx_cursor del origen aún no cubre. */
export function radioTick(ctx) {
  const since = ctx.now() - ctx.config.mailboxRetentionS;
  ctx.store.purgeMailbox(since);
  let pushed = 0;
  for (const entry of ctx.store.listUnreceivedServerMessages(since)) pushed += pushEntry(ctx, entry);
  return pushed;
}

/** El recibo del origen (rx_cursor) detiene el envío de lo ya cubierto. */
export function applyRxCursor(ctx, senderId, incidentId, cursor) {
  ctx.store.dropRadioCovered(senderId, incidentId, cursor);
}

export function startRadioTimer(ctx, everyMs = 60_000) {
  const t = setInterval(() => { try { radioTick(ctx); } catch (e) { ctx.log(`[radio] ${e.stack || e}`); } }, everyMs);
  t.unref();
  return t;
}

// --- HTTP ----------------------------------------------------------------------------------

function isEgressId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 64;
}

function isCell(cell) {
  return typeof cell === 'string' && CELL_RE.test(cell);
}

function isValidity(v) {
  return Number.isInteger(v) && v >= 1 && v <= 300;
}

function parsePresence(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'body must be a JSON object');
  const { egress_id: egressId, cell, valid_s: validS } = body;
  if (!isEgressId(egressId)) throw new HttpError(400, 'egress_id required');
  if (!isCell(cell)) throw new HttpError(400, 'cell must be a 6-char geohash');
  if (!isValidity(validS)) throw new HttpError(400, 'valid_s must be 1..300');
  return { egressId, cell, validS };
}

function hitEgressLimit(ctx, limiter, key) {
  if (!limiter.hit(key, ctx.config.rate.egressPerMin, 60)) throw new HttpError(429, 'rate limit (egress)');
}

export function recordPresence(ctx, body, limiter) {
  const { egressId, cell, validS } = parsePresence(body);
  hitEgressLimit(ctx, limiter, `egress:${egressId}`);
  ctx.store.upsertPresence({ egressId, cell, validUntil: ctx.now() + validS });
}

function toMessage(m) {
  return { id: `m_${String(m.id).padStart(4, '0')}`, msg_type: m.msg_type, incident_id: m.incident_id, packet_b64: m.packet_b64 };
}

/** Saca de la cola lo pendiente para este egress y lo marca como entregado. */
function takeQueued(ctx, egressId) {
  const rows = ctx.store.drainRadio(egressId, ctx.now() - ctx.config.mailboxRetentionS);
  if (rows.length) ctx.store.ackRadio(rows.map((r) => r.qid));
  return rows;
}

/** Espera hasta `ms` o a que llegue algo para este egress. */
function waitForRadio(ctx, egressId, ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); ctx.bus.off('radio', onRadio); resolve(); };
    const onRadio = (targets) => { if (targets.includes(egressId)) done(); };
    const timer = setTimeout(done, ms);
    ctx.bus.on('radio', onRadio);
  });
}

/** Long-poll de hasta `wait` s (máx. 25): devuelve lo que haya en cola para este egress. */
export async function readInbox(ctx, egressId, waitS, limiter) {
  if (!egressId || egressId.length > 64) throw new HttpError(400, 'egress_id required');
  hitEgressLimit(ctx, limiter, `inbox:${egressId}`);
  let rows = takeQueued(ctx, egressId);
  const deadline = Date.now() + Math.min(Math.max(waitS, 0), 25) * 1000;
  while (!rows.length && Date.now() < deadline) {
    await waitForRadio(ctx, egressId, Math.min(deadline - Date.now(), 1000));
    rows = takeQueued(ctx, egressId);
  }
  return { messages: rows.map(toMessage) };
}
