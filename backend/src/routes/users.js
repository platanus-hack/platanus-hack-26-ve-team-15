// Registro previo (contrato §6).
import { HttpError, readBody } from '../http.js';
import { registerUser, updateContacts } from '../users.js';
import { clientIp, route } from './helpers.js';

function signatureHeaders(req) {
  return { pubkeyB64: req.headers['x-baliza-pubkey'], signatureB64: req.headers['x-baliza-signature'] };
}

function registerHandler({ ctx, config, limiter }) {
  return async ({ req, send }) => {
    if (!limiter.hit(`register:${clientIp(config, req)}`, config.rate.registerPerMin, 60)) throw new HttpError(429, 'rate limit');
    const r = registerUser(ctx, { rawBody: await readBody(req), ...signatureHeaders(req) });
    send(r.status, r.body);
  };
}

function updateContactsHandler({ ctx }) {
  return async ({ req, params, send }) => {
    const r = updateContacts(ctx, params.id, { rawBody: await readBody(req), ...signatureHeaders(req) });
    send(r.status, r.body);
  };
}

export function usersRoutes(app) {
  return [
    route('POST', '/v1/users', registerHandler(app)),
    route('PUT', '/v1/users/:id/contacts', updateContactsHandler(app)),
  ];
}
