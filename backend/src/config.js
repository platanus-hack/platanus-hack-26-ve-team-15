// Configuración desde variables de entorno (ver backend/README.md para la lista completa).
import { fileURLToPath } from 'node:url';

// Datos por defecto junto al backend (no dependen del directorio desde el que se arranca).
const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));

const flag = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());
const int = (v, dflt) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? dflt : Number(v));

export function loadConfig(env = process.env) {
  return {
    port: int(env.PORT, 8080),
    dbPath: env.DATABASE_PATH || `${DATA_DIR}baliza.db`,
    keyFile: env.BALIZA_KEY_FILE || `${DATA_DIR}server-keys.json`,
    // En Render, RENDER_EXTERNAL_URL trae la URL pública del servicio.
    publicBaseUrl: (env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${int(env.PORT, 8080)}`).replace(/\/$/, ''),
    // Detrás de un proxy (Render) la IP del cliente viene en X-Forwarded-For.
    trustProxy: flag(env.TRUST_PROXY),
    featurePayments: flag(env.FEATURE_PAYMENTS),
    featureRides: flag(env.FEATURE_RIDES),
    dashboardToken: env.DASHBOARD_TOKEN || null,
    adminToken: env.ADMIN_TOKEN || null,
    corsOrigin: env.CORS_ORIGIN || '*',
    // Con canales reales, solo los contactos 'verified' reciben avisos (el registro es abierto: sin esto,
    // cualquiera podría hacer que el servidor envíe SMS o llame a números ajenos).
    allowUnverifiedContacts: flag(env.ALLOW_UNVERIFIED_CONTACTS),
    futureSkewS: int(env.FUTURE_SKEW_S, 600),
    pastWindowS: int(env.PAST_WINDOW_S, 7 * 24 * 3600),
    mailboxRetentionS: int(env.MAILBOX_RETENTION_S, 24 * 3600),
    rate: {
      egressPerMin: int(env.RATE_EGRESS_PER_MIN, 120),
      senderPerMin: int(env.RATE_SENDER_PER_MIN, 30),
      registerPerMin: int(env.RATE_REGISTER_PER_MIN, 20),
      replyPerHour: int(env.RATE_REPLY_PER_HOUR, 20),
    },
    limits: {
      cmdPerDay: int(env.CMD_MAX_PER_DAY, 10),
      cmdAmountPerDay: int(env.CMD_MAX_AMOUNT_PER_DAY, 500),
    },
    llm: {
      apiKey: env.ANTHROPIC_API_KEY || null,
      model: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
      // El LLM nunca debe retrasar un aviso de emergencia: pasado este tiempo se usa la plantilla.
      timeoutMs: int(env.LLM_TIMEOUT_MS, 6000),
    },
    smsProvider: env.SMS_PROVIDER || null, // 'twilio' fuerza Twilio aunque Kapso esté configurado
    kapso: {
      apiKey: env.KAPSO_API_KEY || null,
      phoneNumberId: env.KAPSO_PHONE_NUMBER_ID || null,
      baseUrl: (env.KAPSO_BASE_URL || 'https://api.kapso.ai/meta/whatsapp/v24.0').replace(/\/$/, ''),
      webhookSecret: env.KAPSO_WEBHOOK_SECRET || null,
      // Plantillas aprobadas (necesarias para escribir primero a alguien fuera de la ventana de 24 h).
      templateAlert: env.KAPSO_TEMPLATE_ALERT || null,
      templateMessage: env.KAPSO_TEMPLATE_MESSAGE || null,
      templateLang: env.KAPSO_TEMPLATE_LANG || 'es',
      templateLangEn: env.KAPSO_TEMPLATE_LANG_EN || null,
    },
    sms: {
      sid: env.TWILIO_ACCOUNT_SID || null,
      token: env.TWILIO_AUTH_TOKEN || null,
      from: env.TWILIO_FROM || null,
    },
    email: {
      apiKey: env.RESEND_API_KEY || null,
      from: env.EMAIL_FROM || null,
    },
    voice: {
      apiKey: env.ELEVENLABS_API_KEY || null,
      agentId: env.ELEVENLABS_AGENT_ID || null,
      phoneNumberId: env.ELEVENLABS_PHONE_NUMBER_ID || null,
    },
  };
}
