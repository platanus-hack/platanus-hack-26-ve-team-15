// POST /v1/mailbox/poll (contrato §5): lo pendiente (tipos 3, 5 y 7) para pares (sender_id, incident_id).
import { HttpError } from './http.js';

const HEX16 = /^[0-9a-f]{16}$/;
const MAX_QUERIES = 50;
const MAX_IDS = 50;
const MAX_LIMIT = 200;

function mailboxId(n) {
  return `m_${String(n).padStart(4, '0')}`;
}

function cursorOf(n) {
  return `c_${String(n).padStart(4, '0')}`;
}

function parseCursor(c) {
  if (c === null || c === undefined) return 0;
  const m = /^c_(\d+)$/.exec(String(c));
  if (!m) throw new HttpError(400, 'invalid cursor');
  return Number(m[1]);
}

function parseLimit(v) {
  const wanted = Number.isInteger(v) ? v : 50;
  return Math.min(Math.max(wanted, 1), MAX_LIMIT);
}

function isHex16(v) {
  return HEX16.test(v ?? '');
}

function isValidQuery(q) {
  return Boolean(q) && isHex16(q.sender_id) && Array.isArray(q.incident_ids)
    && q.incident_ids.length <= MAX_IDS && q.incident_ids.every(isHex16);
}

function checkBody(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.queries)) throw new HttpError(400, 'queries[] required');
  if (body.queries.length > MAX_QUERIES) throw new HttpError(400, `at most ${MAX_QUERIES} queries`);
}

/** Filas pendientes de todas las consultas, ordenadas por id global del buzón. */
function collectRows(ctx, queries, window) {
  const rows = [];
  for (const q of queries) {
    if (!isValidQuery(q)) throw new HttpError(400, 'each query needs a 16-hex sender_id and incident_ids[]');
    rows.push(...ctx.store.pollMailbox({ senderId: q.sender_id, incidentIds: q.incident_ids, ...window }));
  }
  return rows.sort((a, b) => a.id - b.id);
}

function toMessage(m) {
  return { id: mailboxId(m.id), msg_type: m.msg_type, incident_id: m.incident_id, created_at: m.created_at, packet_b64: m.packet_b64 };
}

export function pollMailbox(ctx, body) {
  checkBody(body);
  const afterId = parseCursor(body.cursor);
  const limit = parseLimit(body.limit);
  const minCreatedAt = ctx.now() - ctx.config.mailboxRetentionS;
  const page = collectRows(ctx, body.queries, { afterId, minCreatedAt, limit }).slice(0, limit);
  const last = page.length ? page[page.length - 1].id : afterId;
  return { messages: page.map(toMessage), next_cursor: cursorOf(last) };
}
