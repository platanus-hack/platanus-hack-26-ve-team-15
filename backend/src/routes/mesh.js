// Camino de ida y vuelta del mesh: egress, buzón, presencia e inbox de egress (contrato §4 y §5).
import { handleEgress } from '../egress.js';
import { pollMailbox } from '../mailbox.js';
import { readInbox, recordPresence } from '../radio.js';
import { intParam, jsonBody, route } from './helpers.js';

function egressHandler({ ctx, limiter }) {
  return async ({ req, send }) => {
    const { json } = await jsonBody(req);
    const r = handleEgress(ctx, json, limiter);
    send(r.status, r.body);
  };
}

function mailboxHandler({ ctx }) {
  return async ({ req, send }) => {
    const { json } = await jsonBody(req);
    send(200, pollMailbox(ctx, json));
  };
}

function presenceHandler({ ctx, limiter }) {
  return async ({ req, send }) => {
    const { json } = await jsonBody(req);
    recordPresence(ctx, json, limiter);
    send(204, undefined);
  };
}

function inboxHandler({ ctx, limiter }) {
  return async ({ url, send }) => {
    send(200, await readInbox(ctx, url.searchParams.get('egress_id'), intParam(url, 'wait'), limiter));
  };
}

export function meshRoutes(app) {
  return [
    route('POST', '/v1/egress', egressHandler(app)),
    route('POST', '/v1/mailbox/poll', mailboxHandler(app)),
    route('POST', '/v1/egress/presence', presenceHandler(app)),
    route('GET', '/v1/egress/inbox', inboxHandler(app)),
  ];
}
