// Datos para el panel: lista y detalle de incidentes, eventos y el flujo SSE en vivo.
import { CATEGORY_LABELS } from '../agent.js';
import { HttpError } from '../http.js';
import { intParam, requireDashboard, route } from './helpers.js';

function degrees(v) {
  return v === null ? null : v / 1e5;
}

export function incidentView(i) {
  return {
    sender_id: i.sender_id, incident_id: i.incident_id, display_name: i.display_name ?? null,
    category: i.category, category_label: CATEGORY_LABELS[i.category] ?? 'otra', severity: i.severity, status: i.status,
    lat: degrees(i.lat), lon: degrees(i.lon),
    accuracy_m: i.accuracy_m, location_age_s: i.location_age, public_text: i.public_text, note: i.note,
    hops: i.hops, egress_id: i.egress_id, notified_count: i.notified_count, rx_cursor: i.rx_cursor,
    created_at: i.created_at, updated_at: i.updated_at,
  };
}

function contactView(c) {
  return { idx: c.idx, name: c.name, relation: c.relation, status: c.status };
}

function listHandler({ ctx, config }) {
  return (c) => {
    requireDashboard(config, c);
    const status = c.url.searchParams.get('status') || undefined;
    c.send(200, { incidents: ctx.store.listIncidents({ status }).map(incidentView) });
  };
}

function detailHandler({ ctx, config }) {
  return (c) => {
    requireDashboard(config, c);
    const i = ctx.store.getIncident(c.params.sender, c.params.incident);
    if (!i) throw new HttpError(404, 'incident not found');
    c.send(200, {
      incident: incidentView({ ...i, display_name: ctx.store.getUser(i.sender_id)?.display_name }),
      contacts: ctx.store.getContacts(i.sender_id).map(contactView),
      notifications: ctx.store.listNotifications(i.sender_id, i.incident_id),
      events: ctx.store.listEvents({ incidentId: i.incident_id }),
    });
  };
}

function eventsHandler({ ctx, config }) {
  return (c) => {
    requireDashboard(config, c);
    c.send(200, { events: ctx.store.listEvents({ afterId: intParam(c.url, 'after') }) });
  };
}

/** Desde qué evento reproducir: cabecera Last-Event-ID (reconexión automática) o `?after=`. */
function lastEventId(req, url) {
  return Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0) || 0;
}

function sseEvent(e) {
  return `id: ${e.id}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`;
}

function streamHandler({ ctx, config }) {
  return (c) => {
    requireDashboard(config, c);
    const { req, res, url, cors } = c;
    res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    for (const e of ctx.store.listEvents({ afterId: lastEventId(req, url), limit: 500 })) res.write(sseEvent(e));
    const onEvent = (e) => res.write(sseEvent(e));
    ctx.bus.on('event', onEvent);
    const beat = setInterval(() => res.write(': hb\n\n'), 20_000);
    req.on('close', () => { clearInterval(beat); ctx.bus.off('event', onEvent); });
    return new Promise(() => {});
  };
}

export function dashboardRoutes(app) {
  return [
    route('GET', '/v1/incidents', listHandler(app)),
    route('GET', '/v1/incidents/:sender/:incident', detailHandler(app)),
    route('GET', '/v1/events', eventsHandler(app)),
    route('GET', '/v1/stream', streamHandler(app)),
  ];
}
