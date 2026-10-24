// Ensamblado de la aplicación: contexto (config, store, llaves, canales) + rutas HTTP.
import { createAsker, recoverPendingAsks } from './ai.js';
import { buildChannels } from './channels.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { loadServerKeys } from './crypto.js';
import { createHttpServer } from './http.js';
import { createMessageWriter } from './llm.js';
import { createRateLimiter } from './limits.js';
import { pushToRadio, startRadioTimer } from './radio.js';
import { createWebhookDeduper } from './replies.js';
import { allRoutes } from './routes/index.js';
import { Store } from './store.js';

/** BALIZA_NOW fija el reloj (epoch s): permite probar los vectores congelados de docs/examples. */
function resolveClock(env, now) {
  if (now) return now;
  return env.BALIZA_NOW ? () => Number(env.BALIZA_NOW) : undefined;
}

function buildContext({ env, config, store, keys, channels, writer, asker, now, log }) {
  const theStore = store ?? new Store(config.dbPath);
  const clock = resolveClock(env, now);
  return createContext({
    config, store: theStore, now: clock, log,
    keys: keys ?? loadServerKeys({ env, keyFile: config.keyFile }),
    channels: channels ?? buildChannels(config, { log, store: theStore, now: clock }),
    writer: writer ?? createMessageWriter(config),
    asker: asker ?? createAsker(config),
  });
}

export function createApp({ env = process.env, config = loadConfig(env), log = console.log, ...deps } = {}) {
  const ctx = buildContext({ env, config, log, ...deps });
  ctx.onMailbox = (m) => pushToRadio(ctx, m);
  recoverPendingAsks(ctx);
  const app = { ctx, config, limiter: createRateLimiter(ctx.now), alreadySeen: createWebhookDeduper() };
  const server = createHttpServer(allRoutes(app), { corsOrigin: config.corsOrigin, log });
  return { ctx, server, close: () => { server.close(); ctx.store.close(); } };
}

export { startRadioTimer };
