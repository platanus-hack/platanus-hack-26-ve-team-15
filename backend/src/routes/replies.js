// Respuestas de contactos: página con enlace, API, SMS entrante y webhook de WhatsApp (Kapso).
import { HttpError, readBody } from '../http.js';
import { handleKapsoEvent, isValidKapsoSignature, replyByPhone, replyByToken, replyPage } from '../replies.js';
import { flexBody, requireAdminSecret, route } from './helpers.js';

const HTML = { 'content-type': 'text/html; charset=utf-8' };

function pageHandler({ ctx }) {
  return ({ params, send }) => send(200, replyPage(ctx, params.token), HTML);
}

function pageSubmitHandler({ ctx, limiter }) {
  return async ({ req, params, send }) => {
    const body = await flexBody(req);
    replyByToken(ctx, params.token, body.text, 'sms', limiter);
    send(200, replyPage(ctx, params.token, { sent: true }), HTML);
  };
}

function apiHandler({ ctx, limiter }) {
  return async ({ req, send }) => {
    const body = await flexBody(req);
    const r = replyByToken(ctx, body.token, body.text, body.channel === 'email' ? 'email' : 'sms', limiter);
    send(201, { mailbox_id: r.mailbox_id, seq: r.seq });
  };
}

function smsWebhookHandler({ ctx, config, limiter }) {
  return async ({ req, url, send }) => {
    requireAdminSecret(config, url);
    const body = await flexBody(req);
    const r = replyByPhone(ctx, body.From ?? body.from, body.Body ?? body.body, limiter);
    send(200, { mailbox_id: r.mailbox_id });
  };
}

function parsePayload(raw) {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

function whatsappHandler({ ctx, config, limiter, alreadySeen }) {
  return async ({ req, send }) => {
    const secret = config.kapso.webhookSecret;
    if (!secret) throw new HttpError(404, 'not found');
    const raw = await readBody(req);
    if (!isValidKapsoSignature(raw, req.headers['x-webhook-signature'], secret)) throw new HttpError(401, 'invalid signature');
    if (alreadySeen(req.headers['x-idempotency-key'])) return send(200, { ok: true, duplicate: true });
    const event = String(req.headers['x-webhook-event'] ?? '');
    return send(200, { ok: true, ...handleKapsoEvent(ctx, event, parsePayload(raw), limiter) });
  };
}

export function repliesRoutes(app) {
  return [
    route('GET', '/r/:token', pageHandler(app)),
    route('POST', '/r/:token', pageSubmitHandler(app)),
    route('POST', '/v1/replies', apiHandler(app)),
    route('POST', '/v1/webhooks/sms', smsWebhookHandler(app)),
    route('POST', '/v1/webhooks/whatsapp', whatsappHandler(app)),
  ];
}
