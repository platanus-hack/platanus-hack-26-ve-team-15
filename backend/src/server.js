// Punto de entrada: `node src/server.js` (o `npm start`).
import { createApp, startRadioTimer } from './api.js';
import { providerOf } from './channels.js';

const { ctx, server, close } = createApp();
const radioTimer = startRadioTimer(ctx);

// Evita conexiones colgadas (long-poll del inbox dura ≤ 25 s) y respuestas que nunca terminan.
server.requestTimeout = 60_000;
server.headersTimeout = 20_000;
server.keepAliveTimeout = 65_000; // mayor que el de los balanceadores (Render: 60 s)

server.listen(ctx.config.port, '0.0.0.0', () => {
  const { config, keys, log } = ctx;
  log(`Baliza Vital backend en :${config.port}  (server sender_id ${keys.senderId})`);
  log(`  sign_pk_b64=${keys.signPk.toString('base64')}`);
  log(`  FEATURE_PAYMENTS=${config.featurePayments} FEATURE_RIDES=${config.featureRides}`);
  log(`  texto: ${providerOf(ctx.channels.sms)}, correo: ${providerOf(ctx.channels.email)}, voz: ${providerOf(ctx.channels.voice)}`);
  if (!config.llm.apiKey) log('  (sin ANTHROPIC_API_KEY: avisos con plantilla)');
  if (!config.dashboardToken) log('  (sin DASHBOARD_TOKEN: /v1/incidents y /v1/stream abiertos; solo datos sintéticos)');
  if (config.kapso.apiKey && !config.kapso.webhookSecret) log('  (sin KAPSO_WEBHOOK_SECRET: no se reciben respuestas por WhatsApp)');
});

// Render envía SIGTERM al redesplegar: se terminan los envíos en curso antes de cerrar la base.
let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  ctx.log(`${signal}: cerrando…`);
  clearInterval(radioTimer);
  server.close();
  server.closeIdleConnections?.();
  await Promise.race([ctx.idle(), new Promise((r) => setTimeout(r, 10_000))]);
  close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => ctx.log(`[unhandledRejection] ${e?.stack || e}`));
