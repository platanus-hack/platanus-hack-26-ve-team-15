// Todas las rutas de la API, agrupadas por tema.
import { providerOf } from '../channels.js';
import { adminRoutes } from './admin.js';
import { dashboardRoutes } from './dashboard.js';
import { route } from './helpers.js';
import { meshRoutes } from './mesh.js';
import { notifyRoutes } from './notify.js';
import { repliesRoutes } from './replies.js';
import { usersRoutes } from './users.js';

/** Qué proveedor atiende cada canal (solo nombres: sirve para comprobar la configuración sin ver secretos). */
function channelsView({ channels }, config) {
  return {
    sms: providerOf(channels.sms), email: providerOf(channels.email), voice: providerOf(channels.voice),
    whatsapp_webhook: Boolean(config.kapso.webhookSecret),
  };
}

function healthHandler({ ctx, config }) {
  return ({ send }) => send(200, {
    ok: true, server_sender_id: ctx.keys.senderId, features: { payments: config.featurePayments, rides: config.featureRides, ask_ai: config.ask.enabled },
    channels: channelsView(ctx, config),
  });
}

export function allRoutes(app) {
  return [
    route('GET', '/health', healthHandler(app)),
    ...usersRoutes(app),
    ...meshRoutes(app),
    ...repliesRoutes(app),
    ...adminRoutes(app),
    ...notifyRoutes(app),
    ...dashboardRoutes(app),
  ];
}
