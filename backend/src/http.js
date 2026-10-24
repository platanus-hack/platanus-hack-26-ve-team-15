// Mini servidor HTTP sin dependencias: enrutado, lectura del cuerpo crudo, CORS y errores JSON.
import { createServer } from 'node:http';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_BODY = 64 * 1024;

export function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        // Se descarta el resto sin cortar la conexión, para poder responder 413.
        req.removeAllListeners('data');
        req.resume();
        reject(new HttpError(413, 'body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** routes: [{ method, pattern: '/v1/users/:id/contacts', handler(req, res, ctx) }] */
export function createHttpServer(routes, { corsOrigin = '*', log = console.log } = {}) {
  const compiled = routes.map((r) => {
    const keys = [];
    const re = new RegExp(`^${r.pattern.replace(/:([a-z_]+)/g, (_, k) => (keys.push(k), '([^/]+)'))}/?$`);
    return { ...r, re, keys };
  });

  const cors = {
    'access-control-allow-origin': corsOrigin,
    'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-baliza-pubkey,x-baliza-signature',
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, headers = {}) => {
      if (res.headersSent) return;
      const isJson = typeof body === 'object';
      res.writeHead(status, { ...cors, 'content-type': isJson ? 'application/json' : 'text/plain; charset=utf-8', ...headers });
      res.end(body === undefined ? undefined : isJson ? JSON.stringify(body) : body);
    };
    try {
      if (req.method === 'OPTIONS') return send(204, undefined);
      for (const r of compiled) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        return await r.handler({ req, res, url, params, send, cors });
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      log(`[http] ${req.method} ${url.pathname}: ${e.stack || e}`);
      return send(500, { error: 'internal error' });
    }
  });
}
