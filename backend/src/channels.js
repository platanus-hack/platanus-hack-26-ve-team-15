// Canales de aviso. Sin credenciales, cada canal solo escribe en consola y devuelve `simulated`: así los
// tests y el desarrollo nunca contactan a nadie.
//
//   send({ to, subject?, text, kind, fields, lang, contactName, incident })
//     -> { state: 'sent'|'simulated'|'failed', detail }
//
// `kind` = 'alert' | 'message' y `fields` (userName, category, severity, map, reply, text) sirven a los
// canales con plantillas (WhatsApp fuera de la ventana de 24 h). El bit `sms` del contrato (channels & 1)
// se entrega por WhatsApp (Kapso) si está configurado; si no, por SMS (Twilio).

const WINDOW_S = 24 * 3600;
const DETAIL_MAX = 160;

function digits(s) {
  return String(s ?? '').replace(/\D/g, '');
}

async function postJson(url, headers, body, fetchImpl) {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, DETAIL_MAX)}`);
  return res.json().catch(() => ({}));
}

function consoleChannel(name, log) {
  return {
    name,
    live: false,
    async send({ to, text, contactName }) {
      log(`[channel:${name}] SIMULADO -> ${contactName} <${to}>: ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
      return { state: 'simulated', detail: 'no provider configured' };
    },
  };
}

function twilioSms(cfg, fetchImpl) {
  return {
    name: 'sms',
    provider: 'twilio',
    live: true,
    async send({ to, text }) {
      const auth = Buffer.from(`${cfg.sid}:${cfg.token}`).toString('base64');
      const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/Messages.json`, {
        method: 'POST',
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: `+${digits(to)}`, From: cfg.from, Body: text }).toString(),
      });
      if (!res.ok) return { state: 'failed', detail: `twilio HTTP ${res.status}` };
      return { state: 'sent', detail: 'twilio' };
    },
  };
}

// Los parámetros de plantilla de WhatsApp no admiten saltos de línea ni tabuladores.
function templateText(v, max = 300) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || '-';
}

export function templateParams(kind, f) {
  const list = kind === 'alert'
    ? [f.userName, f.category, `${f.severity}/3`, f.map ?? 'sin ubicación', f.reply]
    : [f.userName, f.text, f.reply];
  return list.map((v) => ({ type: 'text', text: templateText(v) }));
}

function waBase(to) {
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to };
}

function waText(wa, to, text) {
  return postJson(wa.url, wa.headers, { ...waBase(to), type: 'text', text: { body: text, preview_url: false } }, wa.fetchImpl);
}

function templateLanguage(cfg, lang) {
  return lang === 'en' && cfg.templateLangEn ? cfg.templateLangEn : cfg.templateLang;
}

function waTemplate(wa, to, { name, kind, fields, lang }) {
  const template = {
    name, language: { code: templateLanguage(wa.cfg, lang) }, components: [{ type: 'body', parameters: templateParams(kind, fields) }],
  };
  return postJson(wa.url, wa.headers, { ...waBase(to), type: 'template', template }, wa.fetchImpl);
}

/** ¿El contacto nos escribió hace menos de 24 h? Entonces se puede enviar texto libre. */
function windowOpen(wa, num) {
  return (wa.store.getWaInbound(num) ?? 0) >= wa.now() - WINDOW_S;
}

/** Dentro de la ventana: texto libre primero. Fuera: plantilla primero; el texto queda como último recurso. */
function attemptOrder(isOpen, templateName) {
  return (isOpen ? ['text', 'template'] : ['template', 'text']).filter((how) => how === 'text' || templateName);
}

function sentDetail(how, res) {
  const wamid = res.messages?.[0]?.id;
  return `kapso-whatsapp:${how}${wamid ? `:wamid:${wamid}` : ''}`;
}

async function sendWhatsApp(wa, { to, text, kind = 'alert', fields = {}, lang }) {
  const num = digits(to);
  const name = kind === 'alert' ? wa.cfg.templateAlert : wa.cfg.templateMessage;
  let lastError = 'no attempt';
  for (const how of attemptOrder(windowOpen(wa, num), name)) {
    try {
      const res = how === 'text' ? await waText(wa, num, text) : await waTemplate(wa, num, { name, kind, fields, lang });
      return { state: 'sent', detail: sentDetail(how, res) };
    } catch (e) {
      lastError = `${how}: ${e.message}`.slice(0, DETAIL_MAX);
    }
  }
  return { state: 'failed', detail: lastError };
}

/**
 * WhatsApp Cloud API a través de Kapso (Meta proxy): `POST {base}/{phone_number_id}/messages`, cabecera
 * `X-API-Key`. Dentro de las 24 h desde el último mensaje del contacto se envía texto libre; fuera, hace
 * falta una plantilla aprobada (KAPSO_TEMPLATE_ALERT / KAPSO_TEMPLATE_MESSAGE).
 */
export function kapsoWhatsApp(cfg, fetchImpl, { store, now }) {
  const wa = { cfg, fetchImpl, store, now, url: `${cfg.baseUrl}/${cfg.phoneNumberId}/messages`, headers: { 'x-api-key': cfg.apiKey } };
  return { name: 'sms', provider: 'kapso', live: true, send: (message) => sendWhatsApp(wa, message) };
}

function resendEmail(cfg, fetchImpl) {
  return {
    name: 'email',
    provider: 'resend',
    live: true,
    async send({ to, subject, text }) {
      try {
        await postJson('https://api.resend.com/emails', { authorization: `Bearer ${cfg.apiKey}` },
          { from: cfg.from, to: [to], subject, text }, fetchImpl);
        return { state: 'sent', detail: 'resend' };
      } catch (e) {
        return { state: 'failed', detail: e.message.slice(0, DETAIL_MAX) };
      }
    },
  };
}

// Llamada saliente con un agente de voz de ElevenLabs Conversational AI (sobre Twilio).
function elevenLabsVoice(cfg, fetchImpl) {
  return {
    name: 'voice',
    provider: 'elevenlabs',
    live: true,
    async send({ to, text, lang, contactName, incident }) {
      try {
        await postJson('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', { 'xi-api-key': cfg.apiKey }, {
          agent_id: cfg.agentId,
          agent_phone_number_id: cfg.phoneNumberId,
          to_number: `+${digits(to)}`,
          conversation_initiation_client_data: {
            dynamic_variables: { contact_name: contactName, message: text, language: lang, incident_id: incident.incident_id },
          },
        }, fetchImpl);
        return { state: 'sent', detail: 'elevenlabs' };
      } catch (e) {
        return { state: 'failed', detail: e.message.slice(0, DETAIL_MAX) };
      }
    },
  };
}

function isKapsoReady(config, store) {
  return Boolean(config.kapso.apiKey && config.kapso.phoneNumberId && store);
}

function isTwilioReady({ sms }) {
  return Boolean(sms.sid && sms.token && sms.from);
}

/** El bit «sms» del contrato: WhatsApp (Kapso) si está configurado, si no Twilio, si no consola. */
function textChannel(config, { fetchImpl, log, store, now }) {
  if (isKapsoReady(config, store) && config.smsProvider !== 'twilio') return kapsoWhatsApp(config.kapso, fetchImpl, { store, now });
  if (isTwilioReady(config)) return twilioSms(config.sms, fetchImpl);
  return consoleChannel('sms', log);
}

function emailChannel({ email }, { fetchImpl, log }) {
  return email.apiKey && email.from ? resendEmail(email, fetchImpl) : consoleChannel('email', log);
}

function voiceChannel({ voice }, { fetchImpl, log }) {
  return voice.apiKey && voice.agentId && voice.phoneNumberId ? elevenLabsVoice(voice, fetchImpl) : consoleChannel('voice', log);
}

/** Nombre del proveedor de un canal ('kapso', 'twilio', 'resend', 'elevenlabs') o 'simulated'. */
export function providerOf(channel) {
  if (!channel?.live) return 'simulated';
  return channel.provider ?? channel.name;
}

export function buildChannels(config, { fetchImpl = fetch, log = console.log, store, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const deps = { fetchImpl, log, store, now };
  return { sms: textChannel(config, deps), email: emailChannel(config, deps), voice: voiceChannel(config, deps) };
}
