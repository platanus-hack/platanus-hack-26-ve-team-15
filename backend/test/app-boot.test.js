// Arranque real de la app, sin inyectar dependencias: todo sale de las variables de entorno.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, startRadioTimer } from '../src/api.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'baliza-boot-'));

async function boot(env) {
  const app = createApp({ env, log: () => {} });
  app.server.listen(0);
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, stop: () => { app.server.closeAllConnections?.(); app.close(); } };
}

test('createApp arranca solo con variables de entorno: crea la base y las llaves en las rutas indicadas', async () => {
  const dir = tmp();
  const { app, base, stop } = await boot({
    DATABASE_PATH: join(dir, 'db', 'baliza.db'), BALIZA_KEY_FILE: join(dir, 'keys', 'server-keys.json'), FEATURE_RIDES: 'true',
  });
  try {
    assert.ok(existsSync(join(dir, 'db', 'baliza.db')), 'SQLite creada');
    assert.ok(existsSync(join(dir, 'keys', 'server-keys.json')), 'llaves generadas y guardadas');
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.server_sender_id, app.ctx.keys.senderId);
    assert.deepEqual(health.features, { payments: false, rides: true });
    assert.equal(app.ctx.channels.sms.live, false, 'sin credenciales los canales son simulados');
  } finally { stop(); }
});

test('un segundo arranque con el mismo archivo de llaves conserva la identidad del servidor', async () => {
  const dir = tmp();
  const env = { DATABASE_PATH: join(dir, 'baliza.db'), BALIZA_KEY_FILE: join(dir, 'server-keys.json') };
  const first = await boot(env);
  const senderId = first.app.ctx.keys.senderId;
  first.stop();
  const second = await boot(env);
  try {
    assert.equal(second.app.ctx.keys.senderId, senderId);
  } finally { second.stop(); }
});

test('BALIZA_NOW fija el reloj del servidor; sin él se usa la hora real', async () => {
  const dir = tmp();
  const pinned = await boot({ DATABASE_PATH: join(dir, 'a.db'), BALIZA_KEY_FILE: join(dir, 'a.json'), BALIZA_NOW: '1798200010' });
  try {
    assert.equal(pinned.app.ctx.now(), 1798200010);
  } finally { pinned.stop(); }
  const real = await boot({ DATABASE_PATH: join(dir, 'b.db'), BALIZA_KEY_FILE: join(dir, 'b.json') });
  try {
    assert.ok(Math.abs(real.app.ctx.now() - Date.now() / 1000) < 5);
  } finally { real.stop(); }
});

test('el temporizador de radio se arranca y se puede detener', async () => {
  const dir = tmp();
  const { app, stop } = await boot({ DATABASE_PATH: join(dir, 'c.db'), BALIZA_KEY_FILE: join(dir, 'c.json') });
  try {
    const timer = startRadioTimer(app.ctx, 10_000);
    assert.equal(typeof timer.unref, 'function');
    clearInterval(timer);
  } finally { stop(); }
});
