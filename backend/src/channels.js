// Canales de aviso. Sin credenciales, cada canal solo escribe en consola y devuelve `simulated`: así los
// tests y el desarrollo nunca contactan a nadie.
//
//   send({ to, subject?, text, kind, fields, lang, contactName, incident })
//     -> { state: 'sent'|'simulated'|'failed', detail }
//
// `kind` = 'alert' | 'message' y `fields` (userName, category, severity, map, reply, text) sirven a los
// canales con plantillas (WhatsApp fuera de la ventana de 24 h). El bit `sms` del contrato (channels & 1)
// se entrega por WhatsApp (Kapso) si está configurado; si no, por SMS (Twilio).

const digits = (s) => String(s ?? '').replace(/\D/g, '');
const WINDOW_S = 24 * 3600;
const DETAIL_MAX = 160;

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
const templateText = (v, max = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || '-';

export function templateParams(kind, f) {
  const list = kind === 'alert'
    ? [f.userName, f.category, `${f.severity}/3`, f.map ?? 'sin ubicación', f.reply]
    : [f.userName, f.text, f.reply];
  return list.map((v) => ({ type: 'text', text: templateText(v) }));
}

/**
 * WhatsApp Cloud API a través de Kapso (Meta proxy): `POST {base}/{phone_number_id}/messages`, cabecera
 * `X-API-Key`. Dentro de las 24 h desde el último mensaje del contacto se envía texto libre; fuera, hace
 * falta una plantilla aprobada (KAPSO_TEMPLATE_ALERT / KAPSO_TEMPLATE_MESSAGE).
 */
export function kapsoWhatsApp(cfg, fetchImpl, { store, now }) {
  const url = `${cfg.baseUrl}/${cfg.phoneNumberId}/messages`;
  const headers = { 'x-api-key': cfg.apiKey };
  const base = (to) => ({ messaging_product: 'whatsapp', recipient_type: 'individual', to });
  const attemptText = (to, text) => postJson(url, headers, { ...base(to), type: 'text', text: { body: text, preview_url: false } }, fetchImpl);
  const attemptTemplate = (to, name, kind, fields, lang) => postJson(url, headers, {
    ...base(to), type: 'template',
    template: { name, language: { code: lang }, components: [{ type: 'body', parameters: templateParams(kind, fields) }] },
  }, fetchImpl);

  return {
    name: 'sms',
    live: true,
    async send({ to, text, kind = 'alert', fields = {}, lang }) {
      const num = digits(to);
      const templateName = kind === 'alert' ? cfg.templateAlert : cfg.templateMessage;
      const windowOpen = (store.getWaInbound(num) ?? 0) >= now() - WINDOW_S;
      // Dentro de la ventana: texto libre primero. Fuera: plantilla primero; el texto queda como último recurso.
      const tries = (windowOpen ? ['text', 'template'] : ['template', 'text']).filter((how) => how === 'text' || templateName);
      let lastError = 'no attempt';
      for (const how of tries) {
        try {
          const res = how === 'text'
            ? await attemptText(num, text)
            : await attemptTemplate(num, templateName, kind, fields, lang === 'en' && cfg.templateLangEn ? cfg.templateLangEn : cfg.templateLang);
          const wamid = res.messages?.[0]?.id;
          return { state: 'sent', detail: `kapso-whatsapp:${how}${wamid ? `:wamid:${wamid}` : ''}` };
        } catch (e) {
          lastError = `${how}: ${e.message}`.slice(0, DETAIL_MAX);
        }
      }
      return { state: 'failed', detail: lastError };
    },
  };
}

function resendEmail(cfg, fetchImpl) {
  return {
    name: 'email',
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

export function buildChannels(config, { fetchImpl = fetch, log = console.log, store, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const { sms, email, voice, kapso } = config;
  const kapsoReady = kapso.apiKey && kapso.phoneNumberId && store;
  const twilioReady = sms.sid && sms.token && sms.from;
  let text;
  if (kapsoReady && config.smsProvider !== 'twilio') text = kapsoWhatsApp(kapso, fetchImpl, { store, now });
  else if (twilioReady) text = twilioSms(sms, fetchImpl);
  else text = consoleChannel('sms', log);
  return {
    sms: text,
    email: email.apiKey && email.from ? resendEmail(email, fetchImpl) : consoleChannel('email', log),
    voice: voice.apiKey && voice.agentId && voice.phoneNumberId ? elevenLabsVoice(voice, fetchImpl) : consoleChannel('voice', log),
  };
}
