// POST /v1/mailbox/poll (contrato §5): lo pendiente (tipos 3, 5 y 7) para pares (sender_id, incident_id).
import { HttpError } from './http.js';

const HEX16 = /^[0-9a-f]{16}$/;
const MAX_QUERIES = 50;
const MAX_IDS = 50;
const MAX_LIMIT = 200;

const idOf = (n) => `m_${String(n).padStart(4, '0')}`;
function parseCursor(c) {
  if (c === null || c === undefined) return 0;
  const m = /^c_(\d+)$/.exec(String(c));
  if (!m) throw new HttpError(400, 'invalid cursor');
  return Number(m[1]);
}

export function pollMailbox(ctx, body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.queries)) throw new HttpError(400, 'queries[] required');
  if (body.queries.length > MAX_QUERIES) throw new HttpError(400, `at most ${MAX_QUERIES} queries`);
  const afterId = parseCursor(body.cursor);
  const limit = Math.min(Math.max(Number.isInteger(body.limit) ? body.limit : 50, 1), MAX_LIMIT);
  const minCreatedAt = ctx.now() - ctx.config.mailboxRetentionS;

  const rows = [];
  for (const q of body.queries) {
    if (!q || !HEX16.test(q.sender_id ?? '') || !Array.isArray(q.incident_ids) || q.incident_ids.length > MAX_IDS
      || !q.incident_ids.every((i) => HEX16.test(i))) {
      throw new HttpError(400, 'each query needs a 16-hex sender_id and incident_ids[]');
    }
    rows.push(...ctx.store.pollMailbox({ senderId: q.sender_id, incidentIds: q.incident_ids, afterId, minCreatedAt, limit }));
  }
  rows.sort((a, b) => a.id - b.id);
  const page = rows.slice(0, limit);
  const last = page.length ? page[page.length - 1].id : afterId;
  return {
    messages: page.map((m) => ({ id: idOf(m.id), msg_type: m.msg_type, incident_id: m.incident_id, created_at: m.created_at, packet_b64: m.packet_b64 })),
    next_cursor: `c_${String(last).padStart(4, '0')}`,
  };
}
