// Utilidades compartidas por los módulos de rutas: cuerpos, comparación segura y guardas de acceso.
import { timingSafeEqual } from 'node:crypto';
import { HttpError, readBody } from '../http.js';

export function route(method, pattern, handler) {
  return { method, pattern, handler };
}

export async function jsonBody(req) {
  const raw = await readBody(req);
  try {
    return { raw, json: raw.length ? JSON.parse(raw.toString('utf8')) : {} };
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

/** Cuerpo JSON o formulario (x-www-form-urlencoded) como objeto plano. */
export async function flexBody(req) {
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
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Token de `Authorization: Bearer …` o, para SSE desde el navegador, de `?token=`. */
export function bearer(req, url) {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
}

/** IP del cliente; detrás de un proxy de confianza (Render) viene en X-Forwarded-For. */
export function clientIp(config, req) {
  const forwarded = config.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
  return forwarded || req.socket.remoteAddress;
}

/** Entero de un parámetro de la URL; 0 si falta o no es numérico. */
export function intParam(url, name) {
  return Number(url.searchParams.get(name) ?? 0) || 0;
}

export function requireDashboard(config, { req, url }) {
  if (config.dashboardToken && !safeEqual(bearer(req, url) ?? '', config.dashboardToken)) throw new HttpError(401, 'dashboard token required');
}

export function requireAdmin(config, { req, url }) {
  if (!config.adminToken) throw new HttpError(404, 'not found');
  if (!safeEqual(bearer(req, url) ?? '', config.adminToken)) throw new HttpError(401, 'admin token required');
}

/** Webhook de SMS: el secreto va en `?secret=` y es el ADMIN_TOKEN; sin él configurado la ruta no existe. */
export function requireAdminSecret(config, url) {
  if (!config.adminToken) throw new HttpError(404, 'not found');
  if (!safeEqual(url.searchParams.get('secret') ?? '', config.adminToken)) throw new HttpError(401, 'secret required');
}
