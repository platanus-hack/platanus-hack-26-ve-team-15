// Todas las rutas de la API, agrupadas por tema.
import { adminRoutes } from './admin.js';
import { dashboardRoutes } from './dashboard.js';
import { route } from './helpers.js';
import { meshRoutes } from './mesh.js';
import { repliesRoutes } from './replies.js';
import { usersRoutes } from './users.js';

function healthHandler({ ctx, config }) {
  return ({ send }) => send(200, {
    ok: true, server_sender_id: ctx.keys.senderId, features: { payments: config.featurePayments, rides: config.featureRides, ask_ai: config.ask.enabled },
  });
}

export function allRoutes(app) {
  return [
    route('GET', '/health', healthHandler(app)),
    ...usersRoutes(app),
    ...meshRoutes(app),
    ...repliesRoutes(app),
    ...adminRoutes(app),
    ...dashboardRoutes(app),
  ];
}
