import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChannels, templateParams } from '../src/channels.js';
import { loadConfig } from '../src/config.js';
import { buildClient, createMessageWriter } from '../src/llm.js';
import { Store } from '../src/store.js';

const KAPSO_ENV = { KAPSO_API_KEY: 'kapso-key-SECRET', KAPSO_PHONE_NUMBER_ID: '123456789', KAPSO_TEMPLATE_ALERT: 'baliza_alerta', KAPSO_TEMPLATE_MESSAGE: 'baliza_mensaje' };
const NOW = 1_800_000_000;

function fakeFetch(responder) {
  const calls = [];
  const impl = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(call);
    const r = responder(call, calls.length);
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.json ?? {}, text: async () => r.text ?? '' };
  };
  return { impl, calls };
}

const kapso = (env, responder) => {
  const f = fakeFetch(responder);
  const store = new Store(':memory:');
  const ch = buildChannels(loadConfig({ ...KAPSO_ENV, ...env }), { fetchImpl: f.impl, log: () => {}, store, now: () => NOW });
  return { ch, store, calls: f.calls };
};
const msg = { to: '+58 000-0000001', text: 'texto libre', kind: 'alert', lang: 'es', contactName: 'Contacto',
  fields: { userName: 'Usuario Demo', category: 'médica', severity: 3, map: 'https://maps.example/?q=1,2', reply: 'https://x/r/abc', text: undefined } };

test('Kapso: fuera de la ventana de 24 h envía la plantilla primero, con la URL, la cabecera y los parámetros correctos', async () => {
  const { ch, calls } = kapso({}, () => ({ json: { messages: [{ id: 'wamid.AAA' }] } }));
  const r = await ch.sms.send(msg);
  assert.deepEqual(r, { state: 'sent', detail: 'kapso-whatsapp:template:wamid:wamid.AAA' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.kapso.ai/meta/whatsapp/v24.0/123456789/messages');
  assert.equal(calls[0].headers['x-api-key'], 'kapso-key-SECRET');
  const body = JSON.parse(calls[0].body);
  assert.equal(body.messaging_product, 'whatsapp');
  assert.equal(body.to, '580000000001');
  assert.equal(body.type, 'template');
  assert.equal(body.template.name, 'baliza_alerta');
  assert.deepEqual(body.template.language, { code: 'es' });
  assert.deepEqual(body.template.components[0].parameters.map((p) => p.text),
    ['Usuario Demo', 'médica', '3/3', 'https://maps.example/?q=1,2', 'https://x/r/abc']);
});

test('Kapso: un número local de la agenda (0414…) se envía con el código de país y abre la ventana de quien escribió', async () => {
  const { ch, store, calls } = kapso({}, () => ({ json: { messages: [{ id: 'wamid.LOC' }] } }));
  store.touchWaInbound('584148539491', NOW - 60); // WhatsApp nos da el remitente con código de país
  const r = await ch.sms.send({ ...msg, to: '04148539491' });
  const body = JSON.parse(calls[0].body);
  assert.equal(body.to, '584148539491', 'Kapso solo acepta el número con código de país');
  assert.equal(body.type, 'text', 'la ventana abierta por 584148539491 vale para el contacto guardado como 0414…');
  assert.equal(r.state, 'sent');
});

test('Kapso: dentro de la ventana (el contacto nos escribió hace < 24 h) envía texto libre', async () => {
  const { ch, store, calls } = kapso({}, () => ({ json: { messages: [{ id: 'wamid.BBB' }] } }));
  store.touchWaInbound('580000000001', NOW - 3600);
  const r = await ch.sms.send(msg);
  assert.equal(r.detail, 'kapso-whatsapp:text:wamid:wamid.BBB');
  const body = JSON.parse(calls[0].body);
  assert.equal(body.type, 'text');
  assert.equal(body.text.body, 'texto libre');
  store.touchWaInbound('580000000009', NOW - 25 * 3600);
  await ch.sms.send({ ...msg, to: '580000000009' });
  assert.equal(JSON.parse(calls[1].body).type, 'template', 'a las 25 h la ventana ya cerró');
});

test('Kapso: si la plantilla falla cae a texto; si todo falla devuelve failed sin filtrar la API key', async () => {
  const a = kapso({}, (_c, n) => (n === 1 ? { ok: false, status: 400, text: 'template not approved' } : { json: { messages: [{ id: 'w1' }] } }));
  assert.equal((await a.ch.sms.send(msg)).detail, 'kapso-whatsapp:text:wamid:w1');
  assert.deepEqual(a.calls.map((c) => JSON.parse(c.body).type), ['template', 'text']);

  const b = kapso({}, () => ({ ok: false, status: 500, text: 'boom '.repeat(100) }));
  const r = await b.ch.sms.send(msg);
  assert.equal(r.state, 'failed');
  assert.ok(r.detail.length <= 160);
  assert.ok(!r.detail.includes('SECRET'));
});

test('Kapso: sin plantillas configuradas solo intenta texto; mensajes del usuario usan la plantilla de mensaje', async () => {
  const a = kapso({ KAPSO_TEMPLATE_ALERT: '', KAPSO_TEMPLATE_MESSAGE: '' }, () => ({}));
  await a.ch.sms.send(msg);
  assert.deepEqual(a.calls.map((c) => JSON.parse(c.body).type), ['text']);

  const b = kapso({}, () => ({}));
  await b.ch.sms.send({ ...msg, kind: 'message', fields: { userName: 'Usuario Demo', text: 'Estoy\nbien', reply: 'https://x/r/abc' } });
  const t = JSON.parse(b.calls[0].body).template;
  assert.equal(t.name, 'baliza_mensaje');
  assert.deepEqual(t.components[0].parameters.map((p) => p.text), ['Usuario Demo', 'Estoy bien', 'https://x/r/abc']);
});

test('plantillas: sin saltos de línea ni valores vacíos (WhatsApp los rechaza)', () => {
  const p = templateParams('alert', { userName: 'A\n\tB', category: '', severity: 2, map: null, reply: 'r' });
  assert.deepEqual(p.map((x) => x.text), ['A B', '-', '2/3', 'sin ubicación', 'r']);
});

test('selección de proveedor de texto: Kapso > Twilio > consola; SMS_PROVIDER=twilio fuerza Twilio', async () => {
  const twilio = { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+15550000000' };
  const urlUsed = async (env) => {
    const f = fakeFetch(() => ({}));
    const ch = buildChannels(loadConfig(env), { fetchImpl: f.impl, log: () => {}, store: new Store(':memory:') });
    await ch.sms.send(msg);
    return f.calls[0]?.url ?? 'consola';
  };
  assert.equal(await urlUsed({}), 'consola');
  assert.match(await urlUsed(twilio), /api\.twilio\.com/);
  assert.match(await urlUsed({ ...KAPSO_ENV, ...twilio }), /api\.kapso\.ai/);
  assert.match(await urlUsed({ ...KAPSO_ENV, ...twilio, SMS_PROVIDER: 'twilio' }), /api\.twilio\.com/);
});

test('Twilio, Resend y ElevenLabs: forma de las peticiones y manejo de errores', async () => {
  const env = { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+15550000000', RESEND_API_KEY: 'rk', EMAIL_FROM: 'a@b.c',
    ELEVENLABS_API_KEY: 'ek', ELEVENLABS_AGENT_ID: 'ag', ELEVENLABS_PHONE_NUMBER_ID: 'ph' };
  const f = fakeFetch(() => ({}));
  const ch = buildChannels(loadConfig(env), { fetchImpl: f.impl, log: () => {}, store: new Store(':memory:') });
  assert.equal((await ch.sms.send(msg)).state, 'sent');
  assert.equal((await ch.email.send({ ...msg, to: 'x@example.com', subject: 'Asunto' })).state, 'sent');
  assert.equal((await ch.voice.send({ ...msg, incident: { incident_id: 'abcd' } })).state, 'sent');

  const [sms, mail, voice] = f.calls;
  assert.equal(sms.url, 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json');
  assert.equal(sms.headers.authorization, `Basic ${Buffer.from('AC1:tok').toString('base64')}`);
  assert.equal(new URLSearchParams(sms.body).get('To'), '+580000000001');
  assert.equal(mail.url, 'https://api.resend.com/emails');
  assert.deepEqual(JSON.parse(mail.body), { from: 'a@b.c', to: ['x@example.com'], subject: 'Asunto', text: 'texto libre' });
  assert.equal(voice.url, 'https://api.elevenlabs.io/v1/convai/twilio/outbound-call');
  const vb = JSON.parse(voice.body);
  assert.deepEqual([vb.agent_id, vb.agent_phone_number_id, vb.to_number], ['ag', 'ph', '+580000000001']);
  assert.equal(vb.conversation_initiation_client_data.dynamic_variables.contact_name, 'Contacto');

  const bad = fakeFetch(() => ({ ok: false, status: 401, text: 'nope' }));
  const chBad = buildChannels(loadConfig(env), { fetchImpl: bad.impl, log: () => {}, store: new Store(':memory:') });
  assert.equal((await chBad.sms.send(msg)).state, 'failed');
  assert.equal((await chBad.email.send(msg)).state, 'failed');
  assert.equal((await chBad.voice.send({ ...msg, incident: { incident_id: 'abcd' } })).state, 'failed');
});

test('canales simulados: no llaman a la red y lo declaran', async () => {
  const f = fakeFetch(() => { throw new Error('no debe llamar a la red'); });
  const logs = [];
  const ch = buildChannels(loadConfig({}), { fetchImpl: f.impl, log: (l) => logs.push(l), store: new Store(':memory:') });
  for (const c of [ch.sms, ch.email, ch.voice]) assert.equal((await c.send(msg)).state, 'simulated');
  assert.equal(f.calls.length, 0);
  assert.equal(logs.length, 3);
});

// --- redactor con Claude --------------------------------------------------------------------

const writerCfg = (extra = {}) => loadConfig({ ANTHROPIC_API_KEY: 'k', LLM_TIMEOUT_MS: '1000', ...extra });
const fakeClient = (impl) => ({ messages: { create: impl } });

test('LLM: pide al modelo configurado, sin herramientas, con esfuerzo bajo, y usa su texto', async () => {
  let req;
  const client = fakeClient(async (r) => { req = r; return { content: [{ type: 'text', text: 'Aviso redactado por el modelo.' }] }; });
  const write = createMessageWriter(writerCfg(), { client });
  assert.equal(await write('<prompt/>', 'plantilla'), 'Aviso redactado por el modelo.');
  assert.equal(req.model, 'claude-opus-5-5');
  assert.deepEqual(req.output_config, { effort: 'low' });
  assert.equal(req.tools, undefined, 'el modelo no recibe herramientas');
  assert.equal(req.messages[0].content, '<prompt/>');
  assert.match(req.system, /dato no confiable/);
});

test('LLM: respuestas vacías, demasiado largas o errores caen a la plantilla; sin API key ni se llama', async () => {
  const run = (impl) => createMessageWriter(writerCfg(), { client: fakeClient(impl) })('p', 'plantilla');
  assert.equal(await run(async () => ({ content: [{ type: 'text', text: 'corto' }] })), 'plantilla');
  assert.equal(await run(async () => ({ content: [{ type: 'text', text: 'x'.repeat(601) }] })), 'plantilla');
  assert.equal(await run(async () => ({ content: [{ type: 'thinking', thinking: 'hm' }] })), 'plantilla');
  assert.equal(await run(async () => { throw new Error('429'); }), 'plantilla');
  assert.equal(await createMessageWriter(loadConfig({}))('p', 'plantilla'), 'plantilla');
});

// --- pruebas dirigidas por mutación -------------------------------------------------------------

test('flag live: la consola es simulada; los proveedores configurados son reales', () => {
  const store = new Store(':memory:');
  const build = (env, withStore = true) => buildChannels(loadConfig(env), { fetchImpl: async () => ({}), log: () => {}, ...(withStore ? { store } : {}) });
  const sim = build({});
  assert.deepEqual([sim.sms.live, sim.email.live, sim.voice.live], [false, false, false]);
  const twilio = build({ TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+1' });
  assert.equal(twilio.sms.live, true);
  assert.equal(build(KAPSO_ENV).sms.live, true);
  const real = build({ RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.c', ELEVENLABS_API_KEY: 'k', ELEVENLABS_AGENT_ID: 'a', ELEVENLABS_PHONE_NUMBER_ID: 'p' });
  assert.deepEqual([real.email.live, real.voice.live], [true, true]);
});

test('un proveedor a medio configurar no cuenta: hacen falta todas sus credenciales', async () => {
  const providerUsed = async (env, withStore = true) => {
    const f = fakeFetch(() => ({}));
    const ch = buildChannels(loadConfig(env), { fetchImpl: f.impl, log: () => {}, ...(withStore ? { store: new Store(':memory:') } : {}) });
    await ch.sms.send(msg);
    const url = f.calls[0]?.url ?? '';
    return /kapso/.test(url) ? 'kapso' : /twilio/.test(url) ? 'twilio' : 'consola';
  };
  const twilio = { TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+1' };
  assert.equal(await providerUsed({ KAPSO_API_KEY: 'k', ...twilio }), 'twilio', 'Kapso sin phone_number_id');
  assert.equal(await providerUsed({ KAPSO_PHONE_NUMBER_ID: '1', ...twilio }), 'twilio', 'Kapso sin API key');
  assert.equal(await providerUsed({ KAPSO_API_KEY: 'k', KAPSO_PHONE_NUMBER_ID: '1' }, false), 'consola', 'Kapso necesita el almacén de la ventana de 24 h');
  assert.equal(await providerUsed({ TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+1' }), 'consola', 'Twilio sin SID');
  assert.equal(await providerUsed({ TWILIO_ACCOUNT_SID: 'AC', TWILIO_FROM: '+1' }), 'consola', 'Twilio sin token');
  assert.equal(await providerUsed({ TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't' }), 'consola', 'Twilio sin número');
  assert.equal(await providerUsed({ ...KAPSO_ENV, ...twilio }), 'kapso');
});

test('Kapso: el texto no pide vista previa de enlaces; el idioma de la plantilla sigue al contacto', async () => {
  const run = async (env, lang) => {
    const { ch, calls } = kapso(env, () => ({}));
    await ch.sms.send({ ...msg, lang });
    return JSON.parse(calls[0].body).template.language.code;
  };
  assert.equal(await run({ KAPSO_TEMPLATE_LANG_EN: 'en_US' }, 'en'), 'en_US');
  assert.equal(await run({ KAPSO_TEMPLATE_LANG_EN: 'en_US' }, 'es'), 'es');
  assert.equal(await run({}, 'en'), 'es', 'sin plantilla en inglés se usa la de por defecto');
  assert.equal(await run({ KAPSO_TEMPLATE_LANG: 'es_VE' }, 'es'), 'es_VE');

  const { ch, store, calls } = kapso({}, () => ({}));
  store.touchWaInbound('580000000001', NOW - 60);
  await ch.sms.send(msg);
  assert.equal(JSON.parse(calls[0].body).text.preview_url, false);
});

test('cliente de Anthropic: sin clave no hay cliente; ANTHROPIC_BASE_URL apunta a un proxy', () => {
  assert.equal(buildClient(loadConfig({}).llm), null);
  const direct = buildClient(loadConfig({ ANTHROPIC_API_KEY: 'k' }).llm);
  assert.equal(direct.baseURL, 'https://api.anthropic.com');
  const proxied = buildClient(loadConfig({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://proxy.example/v1' }).llm);
  assert.equal(proxied.baseURL, 'https://proxy.example/v1');
  assert.equal(loadConfig({ ANTHROPIC_BASE_URL: '' }).llm.baseUrl, null);
});
