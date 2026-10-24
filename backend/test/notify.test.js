// POST /v1/notify: envío directo de un texto a un número, solo con ADMIN_TOKEN.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MSG } from '../src/codec.js';
import { makePhone, sosFields, sosPlaintext, startApp } from './helpers.js';

const admin = { authorization: 'Bearer admin-secret' };
const notify = (app, body, headers = admin) => app.call('POST', '/v1/notify', body, headers);

test('sin ADMIN_TOKEN configurado la ruta no existe, y sin el token correcto responde 401', async () => {
  const open = await startApp({ env: { ADMIN_TOKEN: '' } });
  const app = await startApp();
  try {
    assert.equal((await notify(open, { phone: '+58 412-0000001', message: 'hola' })).status, 404);
    assert.equal((await notify(app, { phone: '+58 412-0000001', message: 'hola' }, {})).status, 401);
    assert.equal((await notify(app, { phone: '+58 412-0000001', message: 'hola' }, { authorization: 'Bearer otro' })).status, 401);
    assert.equal(app.channels.sent.length, 0);
  } finally {
    open.close();
    app.close();
  }
});

test('envía el texto por el canal de texto con el número normalizado', async () => {
  const app = await startApp();
  try {
    const r = await notify(app, { phone: '+58 412-000-0001', message: '  Hola desde Baliza  ' });
    assert.equal(r.status, 200);
    assert.deepEqual({ ok: r.json.ok, state: r.json.state, to: r.json.to, incident_id: r.json.incident_id }, { ok: true, state: 'simulated', to: '+584120000001', incident_id: null });
    assert.equal(app.channels.sent.length, 1);
    assert.equal(app.channels.sent[0].channel, 'sms');
    assert.equal(app.channels.sent[0].to, '584120000001');
    assert.equal(app.channels.sent[0].text, 'Hola desde Baliza');
  } finally {
    app.close();
  }
});

test('rechaza teléfono o mensaje inválidos con 400 y no envía nada', async () => {
  const app = await startApp();
  try {
    for (const body of [
      {}, { phone: '123', message: 'hola' }, { phone: '1234567890123456', message: 'hola' }, { phone: '+58 412-0000001' },
      { phone: '+58 412-0000001', message: '   ' }, { phone: '+58 412-0000001', message: 42 }, { phone: '+58 412-0000001', message: 'x'.repeat(1001) },
      { phone: '+58 412-0000001', message: 'hola', sender_id: 'abc' },
    ]) {
      assert.equal((await notify(app, body)).status, 400, JSON.stringify(body).slice(0, 60));
    }
    assert.equal((await app.call('POST', '/v1/notify', '{no es json', admin)).status, 400);
    assert.equal(app.channels.sent.length, 0);
  } finally {
    app.close();
  }
});

test('si el canal falla responde 502 con el motivo', async () => {
  const channels = { sent: [], sms: { name: 'sms', live: true, async send() { return { state: 'failed', detail: 'text: HTTP 422 fuera de ventana' }; } } };
  const app = await startApp({ channels });
  try {
    const r = await notify(app, { phone: '+58 412-0000001', message: 'hola' });
    assert.equal(r.status, 502);
    assert.deepEqual({ ok: r.json.ok, state: r.json.state, detail: r.json.detail }, { ok: false, state: 'failed', detail: 'text: HTTP 422 fuera de ventana' });
  } finally {
    app.close();
  }
});

test('asociado a un incidente: lo valida y deja un evento; con un incidente desconocido da 404', async () => {
  const app = await startApp();
  try {
    const phone = makePhone(app);
    assert.equal((await phone.register()).status, 201);
    await phone.egress(phone.packet({ msgType: MSG.SOS, plaintext: sosPlaintext({ channels: 0 }), ...sosFields }));
    await app.ctx.idle();
    const ok = await notify(app, { phone: '+58 412-0000001', message: 'aviso', sender_id: phone.senderId, incident_id: phone.incidentId });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.incident_id, phone.incidentId);
    const detail = await app.call('GET', `/v1/incidents/${phone.senderId}/${phone.incidentId}`);
    assert.ok(detail.json.events.some((e) => e.kind === 'direct_message' && e.data.state === 'simulated'));
    const unknown = await notify(app, { phone: '+58 412-0000001', message: 'aviso', sender_id: phone.senderId, incident_id: '0000000000000000' });
    assert.equal(unknown.status, 404);
  } finally {
    app.close();
  }
});

test('limita los envíos por minuto a un mismo número', async () => {
  const app = await startApp({ env: { RATE_SENDER_PER_MIN: '2' } });
  try {
    const send = () => notify(app, { phone: '+58 412-0000001', message: 'hola' });
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 429);
    assert.equal((await notify(app, { phone: '+58 412-0000002', message: 'hola' })).status, 200);
  } finally {
    app.close();
  }
});
