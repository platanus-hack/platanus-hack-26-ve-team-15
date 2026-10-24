// Configuración desde variables de entorno (ver backend/README.md para la lista completa).
import { fileURLToPath } from 'node:url';

// Datos por defecto junto al backend (no dependen del directorio desde el que se arranca).
const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const DAY_S = 24 * 3600;

function flag(v) {
  return TRUE_VALUES.has(String(v ?? '').toLowerCase());
}

function int(v, dflt) {
  if (v === undefined || v === '' || Number.isNaN(Number(v))) return dflt;
  return Number(v);
}

/** Texto de la variable, o `dflt` si falta o está vacía. */
function str(v, dflt = null) {
  return v || dflt;
}

function trimSlash(url) {
  return url.replace(/\/$/, '');
}

function serverConfig(env) {
  const port = int(env.PORT, 8080);
  return {
    port,
    dbPath: str(env.DATABASE_PATH, `${DATA_DIR}baliza.db`),
    keyFile: str(env.BALIZA_KEY_FILE, `${DATA_DIR}server-keys.json`),
    // En Render, RENDER_EXTERNAL_URL trae la URL pública del servicio.
    publicBaseUrl: trimSlash(str(env.PUBLIC_BASE_URL, str(env.RENDER_EXTERNAL_URL, `http://localhost:${port}`))),
    // Detrás de un proxy (Render) la IP del cliente viene en X-Forwarded-For.
    trustProxy: flag(env.TRUST_PROXY),
    corsOrigin: str(env.CORS_ORIGIN, '*'),
  };
}

function securityConfig(env) {
  return {
    dashboardToken: str(env.DASHBOARD_TOKEN),
    adminToken: str(env.ADMIN_TOKEN),
    // Con canales reales, solo los contactos 'verified' reciben avisos (el registro es abierto: sin esto,
    // cualquiera podría hacer que el servidor envíe SMS o llame a números ajenos).
    allowUnverifiedContacts: flag(env.ALLOW_UNVERIFIED_CONTACTS),
  };
}

function windowsConfig(env) {
  return {
    futureSkewS: int(env.FUTURE_SKEW_S, 600),
    pastWindowS: int(env.PAST_WINDOW_S, 7 * DAY_S),
    mailboxRetentionS: int(env.MAILBOX_RETENTION_S, DAY_S),
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
  };
}

function llmConfig(env) {
  return {
    apiKey: str(env.ANTHROPIC_API_KEY),
    baseUrl: str(env.ANTHROPIC_BASE_URL),
    model: str(env.ANTHROPIC_MODEL, 'claude-opus-5-5'),
    // El LLM nunca debe retrasar un aviso de emergencia: pasado este tiempo se usa la plantilla.
    timeoutMs: int(env.LLM_TIMEOUT_MS, 6000),
  };
}

/**
 * Consultas a la IA desde el mesh (CMD `preguntar_ia`). Los límites de tamaño los fija el paquete
 * (contrato §2.1: ≤ 264 B de plaintext en CMD y CMD_RESULT), así que no se configuran por entorno.
 */
function askConfig(env) {
  return {
    enabled: flag(env.FEATURE_ASK_AI),
    model: str(env.ANTHROPIC_ASK_MODEL, 'claude-haiku-5-5'),
    maxQuestionChars: 200,
    maxQuestionBytes: 210,
    maxAnswerBytes: 250,
    timeoutMs: int(env.ASK_TIMEOUT_MS, 15000),
    perDay: int(env.ASK_MAX_PER_DAY, 20),
    maxConcurrent: int(env.ASK_MAX_CONCURRENT, 4),
  };
}

function kapsoConfig(env) {
  return {
    apiKey: str(env.KAPSO_API_KEY),
    phoneNumberId: str(env.KAPSO_PHONE_NUMBER_ID),
    baseUrl: trimSlash(str(env.KAPSO_BASE_URL, 'https://api.kapso.ai/meta/whatsapp/v24.0')),
    webhookSecret: str(env.KAPSO_WEBHOOK_SECRET),
    // Plantillas aprobadas (necesarias para escribir primero a alguien fuera de la ventana de 24 h).
    templateAlert: str(env.KAPSO_TEMPLATE_ALERT),
    templateMessage: str(env.KAPSO_TEMPLATE_MESSAGE),
    templateLang: str(env.KAPSO_TEMPLATE_LANG, 'es'),
    templateLangEn: str(env.KAPSO_TEMPLATE_LANG_EN),
  };
}

function channelsConfig(env) {
  return {
    smsProvider: str(env.SMS_PROVIDER), // 'twilio' fuerza Twilio aunque Kapso esté configurado
    kapso: kapsoConfig(env),
    sms: { sid: str(env.TWILIO_ACCOUNT_SID), token: str(env.TWILIO_AUTH_TOKEN), from: str(env.TWILIO_FROM) },
    email: { apiKey: str(env.RESEND_API_KEY), from: str(env.EMAIL_FROM) },
    voice: {
      apiKey: str(env.ELEVENLABS_API_KEY),
      agentId: str(env.ELEVENLABS_AGENT_ID),
      phoneNumberId: str(env.ELEVENLABS_PHONE_NUMBER_ID),
    },
  };
}

export function loadConfig(env = process.env) {
  return {
    ...serverConfig(env),
    featurePayments: flag(env.FEATURE_PAYMENTS),
    featureRides: flag(env.FEATURE_RIDES),
    ...securityConfig(env),
    ...windowsConfig(env),
    llm: llmConfig(env),
    ask: askConfig(env),
    ...channelsConfig(env),
  };
}
