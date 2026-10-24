// Rutas HTTP de Baliza Vital y ensamblado de la aplicación.
import { timingSafeEqual } from 'node:crypto';
import { CATEGORY_LABELS } from './agent.js';
import { buildChannels } from './channels.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { loadServerKeys } from './crypto.js';
import { handleEgress } from './egress.js';
import { HttpError, createHttpServer, readBody } from './http.js';
import { createMessageWriter } from './llm.js';
import { createRateLimiter } from './limits.js';
import { pollMailbox } from './mailbox.js';
import { readInbox, pushToRadio, recordPresence, startRadioTimer } from './radio.js';
import {
  createWebhookDeduper, handleKapsoEvent, ingestReply, isValidKapsoSignature, replyByPhone, replyByToken, replyPage,
} from './replies.js';
import { Store } from './store.js';
import { registerUser, updateContacts } from './users.js';

const jsonBody = async (req) => {
  const raw = await readBody(req);
  try {
    return { raw, json: raw.length ? JSON.parse(raw.toString('utf8')) : {} };
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
};

/** Cuerpo JSON o formulario (x-www-form-urlencoded) como objeto plano. */
const flexBody = async (req) => {
  const raw = await readBody(req);
  const text = raw.toString('utf8');
  if ((req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
};

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function bearer(req, url) {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
}

export function incidentView(ctx, i) {
  return {
    sender_id: i.sender_id, incident_id: i.incident_id, display_name: i.display_name ?? null,
    category: i.category, category_label: CATEGORY_LABELS[i.category] ?? 'otra', severity: i.severity, status: i.status,
    lat: i.lat === null ? null : i.lat / 1e5, lon: i.lon === null ? null : i.lon / 1e5,
    accuracy_m: i.accuracy_m, location_age_s: i.location_age, public_text: i.public_text, note: i.note,
    hops: i.hops, egress_id: i.egress_id, notified_count: i.notified_count, rx_cursor: i.rx_cursor,
    created_at: i.created_at, updated_at: i.updated_at,
  };
}

export function createApp({ env = process.env, config = loadConfig(env), store, keys, channels, writer, now, log = console.log } = {}) {
  const theStore = store ?? new Store(config.dbPath);
  const theKeys = keys ?? loadServerKeys({ env, keyFile: config.keyFile });
  // BALIZA_NOW fija el reloj (epoch s): permite probar los vectores congelados de docs/examples.
  const clock = now ?? (env.BALIZA_NOW ? () => Number(env.BALIZA_NOW) : undefined);
  const ctx = createContext({
    config, store: theStore, keys: theKeys, now: clock, log,
    channels: channels ?? buildChannels(config, { log, store: theStore, now: clock }),
    writer: writer ?? createMessageWriter(config),
  });
  ctx.onMailbox = (m) => pushToRadio(ctx, m);
  const limiter = createRateLimiter(ctx.now);
  const alreadySeen = createWebhookDeduper();
  const clientIp = (req) => (config.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') || req.socket.remoteAddress;

  const requireDashboard = ({ req, url }) => {
    if (config.dashboardToken && !safeEqual(bearer(req, url) ?? '', config.dashboardToken)) throw new HttpError(401, 'dashboard token required');
  };
  const requireAdmin = ({ req, url }) => {
    if (!config.adminToken) throw new HttpError(404, 'not found');
    if (!safeEqual(bearer(req, url) ?? '', config.adminToken)) throw new HttpError(401, 'admin token required');
  };

  const routes = [
    { method: 'GET', pattern: '/health', handler: ({ send }) => send(200, { ok: true, server_sender_id: theKeys.senderId,
      features: { payments: config.featurePayments, rides: config.featureRides } }) },

    { method: 'POST', pattern: '/v1/users', async handler({ req, send }) {
      if (!limiter.hit(`register:${clientIp(req)}`, config.rate.registerPerMin, 60)) throw new HttpError(429, 'rate limit');
      const raw = await readBody(req);
      const r = registerUser(ctx, { rawBody: raw, pubkeyB64: req.headers['x-baliza-pubkey'], signatureB64: req.headers['x-baliza-signature'] });
      send(r.status, r.body);
    } },
    { method: 'PUT', pattern: '/v1/users/:id/contacts', async handler({ req, params, send }) {
      const raw = await readBody(req);
      const r = updateContacts(ctx, params.id, { rawBody: raw, pubkeyB64: req.headers['x-baliza-pubkey'], signatureB64: req.headers['x-baliza-signature'] });
      send(r.status, r.body);
    } },

    { method: 'POST', pattern: '/v1/egress', async handler({ req, send }) {
      const { json } = await jsonBody(req);
      const r = handleEgress(ctx, json, limiter);
      send(r.status, r.body);
    } },
    { method: 'POST', pattern: '/v1/mailbox/poll', async handler({ req, send }) {
      const { json } = await jsonBody(req);
      send(200, pollMailbox(ctx, json));
    } },
    { method: 'POST', pattern: '/v1/egress/presence', async handler({ req, send }) {
      const { json } = await jsonBody(req);
      recordPresence(ctx, json, limiter);
      send(204, undefined);
    } },
    { method: 'GET', pattern: '/v1/egress/inbox', async handler({ url, send }) {
      send(200, await readInbox(ctx, url.searchParams.get('egress_id'), Number(url.searchParams.get('wait') ?? 0) || 0, limiter));
    } },

    // --- respuestas de contactos ---
    { method: 'GET', pattern: '/r/:token', handler: ({ params, send }) => send(200, replyPage(ctx, params.token), { 'content-type': 'text/html; charset=utf-8' }) },
    { method: 'POST', pattern: '/r/:token', async handler({ req, params, send }) {
      const body = await flexBody(req);
      replyByToken(ctx, params.token, body.text, 'sms', limiter);
      send(200, replyPage(ctx, params.token, { sent: true }), { 'content-type': 'text/html; charset=utf-8' });
    } },
    { method: 'POST', pattern: '/v1/replies', async handler({ req, send }) {
      const body = await flexBody(req);
      const r = replyByToken(ctx, body.token, body.text, body.channel === 'email' ? 'email' : 'sms', limiter);
      send(201, { mailbox_id: r.mailbox_id, seq: r.seq });
    } },
    { method: 'POST', pattern: '/v1/webhooks/sms', async handler({ req, url, send }) {
      if (config.adminToken && !safeEqual(url.searchParams.get('secret') ?? '', config.adminToken)) throw new HttpError(401, 'secret required');
      if (!config.adminToken) throw new HttpError(404, 'not found');
      const body = await flexBody(req);
      const r = replyByPhone(ctx, body.From ?? body.from, body.Body ?? body.body, limiter);
      send(200, { mailbox_id: r.mailbox_id });
    } },

    { method: 'POST', pattern: '/v1/webhooks/whatsapp', async handler({ req, send }) {
      const secret = config.kapso.webhookSecret;
      if (!secret) throw new HttpError(404, 'not found');
      const raw = await readBody(req);
      if (!isValidKapsoSignature(raw, req.headers['x-webhook-signature'], secret)) throw new HttpError(401, 'invalid signature');
      if (alreadySeen(req.headers['x-idempotency-key'])) return send(200, { ok: true, duplicate: true });
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'body is not valid JSON'); }
      send(200, { ok: true, ...handleKapsoEvent(ctx, String(req.headers['x-webhook-event'] ?? ''), payload, limiter) });
    } },

    // --- administración y demo ---
    { method: 'POST', pattern: '/v1/admin/contacts/verify', async handler(c) {
      requireAdmin(c);
      const { json } = await jsonBody(c.req);
      if (!ctx.store.getContact(json.sender_id, json.index)) throw new HttpError(404, 'contact not found');
      ctx.store.setContactStatus(json.sender_id, json.index, 'verified');
      c.send(200, { ok: true });
    } },
    { method: 'POST', pattern: '/v1/dev/simulate-reply', async handler(c) {
      requireAdmin(c);
      const { json } = await jsonBody(c.req);
      const r = ingestReply(ctx, { senderId: json.sender_id, incidentId: json.incident_id, contactIdx: json.contact_idx,
        channel: json.channel ?? 'sms', text: json.text });
      c.send(201, r);
    } },

    // --- dashboard ---
    { method: 'GET', pattern: '/v1/incidents', handler(c) {
      requireDashboard(c);
      const status = c.url.searchParams.get('status') || undefined;
      c.send(200, { incidents: ctx.store.listIncidents({ status }).map((i) => incidentView(ctx, i)) });
    } },
    { method: 'GET', pattern: '/v1/incidents/:sender/:incident', handler(c) {
      requireDashboard(c);
      const i = ctx.store.getIncident(c.params.sender, c.params.incident);
      if (!i) throw new HttpError(404, 'incident not found');
      const user = ctx.store.getUser(i.sender_id);
      c.send(200, {
        incident: incidentView(ctx, { ...i, display_name: user?.display_name }),
        contacts: ctx.store.getContacts(i.sender_id).map((c) => ({ idx: c.idx, name: c.name, relation: c.relation, status: c.status })),
        notifications: ctx.store.listNotifications(i.sender_id, i.incident_id),
        events: ctx.store.listEvents({ incidentId: i.incident_id }),
      });
    } },
    { method: 'GET', pattern: '/v1/events', handler(c) {
      requireDashboard(c);
      c.send(200, { events: ctx.store.listEvents({ afterId: Number(c.url.searchParams.get('after') ?? 0) || 0 }) });
    } },
    { method: 'GET', pattern: '/v1/stream', handler(c) {
      requireDashboard(c);
      const { req, res, cors } = c;
      res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const write = (e) => res.write(`id: ${e.id}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
      const after = Number(req.headers['last-event-id'] ?? c.url.searchParams.get('after') ?? 0) || 0;
      res.write('retry: 3000\n\n');
      for (const e of ctx.store.listEvents({ afterId: after, limit: 500 })) write(e);
      const onEvent = (e) => write(e);
      ctx.bus.on('event', onEvent);
      const beat = setInterval(() => res.write(': hb\n\n'), 20_000);
      req.on('close', () => { clearInterval(beat); ctx.bus.off('event', onEvent); });
      return new Promise(() => {});
    } },
  ];

  const server = createHttpServer(routes, { corsOrigin: config.corsOrigin, log });
  return { ctx, server, close: () => { server.close(); theStore.close(); } };
}

export { startRadioTimer };
