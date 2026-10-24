// Administración y demo (requieren ADMIN_TOKEN si está configurado).
import { executeCommand } from '../commands.js';
import { HttpError } from '../http.js';
import { ingestReply } from '../replies.js';
import { jsonBody, requireAdmin, route } from './helpers.js';

function verifyContactHandler({ ctx, config }) {
  return async (c) => {
    requireAdmin(config, c);
    const { json } = await jsonBody(c.req);
    if (!ctx.store.getContact(json.sender_id, json.index)) throw new HttpError(404, 'contact not found');
    ctx.store.setContactStatus(json.sender_id, json.index, 'verified');
    c.send(200, { ok: true });
  };
}

function simulateReplyHandler({ ctx, config }) {
  return async (c) => {
    requireAdmin(config, c);
    const { json } = await jsonBody(c.req);
    const r = ingestReply(ctx, { senderId: json.sender_id, incidentId: json.incident_id, contactIdx: json.contact_idx,
      channel: json.channel ?? 'sms', text: json.text });
    c.send(201, r);
  };
}

function dispatchRideHandler({ ctx, config }) {
  return async (c) => {
    if (config.adminToken) requireAdmin(config, c);
    const { json } = await jsonBody(c.req);
    const user = ctx.store.getUser(json.sender_id);
    if (!user) throw new HttpError(404, 'user not found');
    const ref = (Date.now() % 65535) || 1;
    const r = executeCommand(ctx, user, {
      cmd: 'pedir_ride',
      ref,
      incidentId: json.incident_id,
      args: { destino: json.destino || 'Centro de Asistencia Médica Chacao', modo: 'urgente' },
    });
    c.send(200, { ok: true, result: r });
  };
}

function clearDemoHandler({ ctx, config }) {
  return async (c) => {
    if (config.adminToken) requireAdmin(config, c);
    ctx.store.clearDemoData?.();
    c.send(200, { ok: true, cleared: true });
  };
}

/** Lanza un proceso que simula un SOS en movimiento: siempre exige ADMIN_TOKEN (404 si no está configurado). */
function runSimulationHandler({ ctx, config }) {
  return async (c) => {
    requireAdmin(config, c);
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const script = fileURLToPath(new URL('../../scripts/simulate-movement.mjs', import.meta.url));
    const child = spawn(process.execPath, [script, '--url', `http://localhost:${ctx.config.port}`, '--interval', '2000'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    c.send(200, { ok: true, started: true });
  };
}

export function adminRoutes(app) {
  return [
    route('POST', '/v1/admin/contacts/verify', verifyContactHandler(app)),
    route('POST', '/v1/dev/simulate-reply', simulateReplyHandler(app)),
    route('POST', '/v1/dev/dispatch-ride', dispatchRideHandler(app)),
    route('POST', '/v1/admin/clear-demo', clearDemoHandler(app)),
    route('POST', '/v1/dev/run-simulation', runSimulationHandler(app)),
  ];
}
