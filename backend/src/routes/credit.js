// Estado del microcrédito simulado de un usuario, para el panel (cupo, usado y plan de cuotas de cada adelanto).
import { creditView } from '../credit.js';
import { HttpError } from '../http.js';
import { requireDashboard, route } from './helpers.js';

function creditHandler({ ctx, config }) {
  return (c) => {
    requireDashboard(config, c);
    if (!ctx.store.getUser(c.params.sender_id)) throw new HttpError(404, 'user not found');
    c.send(200, { enabled: config.featurePayments, ...creditView(ctx, c.params.sender_id) });
  };
}

export function creditRoutes(app) {
  return [route('GET', '/v1/credit/:sender_id', creditHandler(app))];
}
