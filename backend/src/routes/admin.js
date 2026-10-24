// Administración y demo (requieren ADMIN_TOKEN).
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

export function adminRoutes(app) {
  return [
    route('POST', '/v1/admin/contacts/verify', verifyContactHandler(app)),
    route('POST', '/v1/dev/simulate-reply', simulateReplyHandler(app)),
  ];
}
