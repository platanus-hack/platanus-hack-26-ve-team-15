// Consultas a una IA desde un teléfono sin internet: CMD `preguntar_ia` (contrato §3.3 y §7).
// La pregunta llega sellada por el mesh; el backend consulta el modelo fuera de la petición del egress y
// devuelve la respuesta en un solo CMD_RESULT sellado al usuario. El modelo no recibe herramientas: una
// pregunta solo puede producir texto para quien la hizo. No se guarda el texto de preguntas ni respuestas.
import { readFileSync } from 'node:fs';
import { CATEGORY_LABELS } from './agent.js';
import { truncateUtf8 } from './codec.js';
import { STATUS } from './commands.js';
import { queueCmdResult } from './context.js';
import { buildClient, escapeTags, replyText } from './llm.js';

export const ASK_CMD = 'preguntar_ia';

const SYSTEM = readFileSync(new URL('./prompts/ask-assistant.txt', import.meta.url), 'utf8').trim();
// Incluye el razonamiento breve del modelo; la longitud real la acotan el prompt y el recorte.
const MAX_TOKENS = 1024;
const MIN_SENTENCE_CHARS = 40;
const ELLIPSIS = '…';
const DAY_S = 24 * 3600;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const MARKDOWN = /[*_#`]+/g;
const SENTENCE_END = /[.!?…](?=\s|$)/g;

const ACK_RECEIVED = { ackCode: 0, ackText: 'Recibido' };
const ACK_ASKING = { ackCode: 2, ackText: 'Recibido. Consultando a la IA' };
const TEXT = {
  disabled: 'Función desactivada',
  capped: 'Tope diario de consultas a la IA alcanzado',
  busy: 'La IA está ocupada. Intenta de nuevo en un minuto.',
  failed: 'No pude obtener respuesta de la IA. Intenta de nuevo.',
  interrupted: 'La consulta se interrumpió. Intenta de nuevo.',
};

// --- pregunta y respuesta -------------------------------------------------------------------------

/** Motivo de rechazo de la pregunta, o null si es válida (≤ 200 caracteres y ≤ 210 B UTF-8). */
export function questionError(ask, q) {
  const text = typeof q === 'string' ? q.trim() : '';
  if (!text) return 'Pregunta vacía';
  if ([...text].length > ask.maxQuestionChars) return `Pregunta de más de ${ask.maxQuestionChars} caracteres`;
  if (Buffer.byteLength(text, 'utf8') > ask.maxQuestionBytes) return `Pregunta de más de ${ask.maxQuestionBytes} bytes`;
  return null;
}

/** Texto plano en una línea: sin caracteres de control ni marcas de markdown. */
export function cleanAnswer(text) {
  return String(text ?? '').replace(CONTROL_CHARS, ' ').replace(MARKDOWN, '').replace(/\s+/g, ' ').trim();
}

function lastSentenceEnd(text) {
  let end = -1;
  for (const m of text.matchAll(SENTENCE_END)) end = m.index + 1;
  return end;
}

function cutAtWord(text, maxBytes) {
  const cut = truncateUtf8(text, maxBytes - Buffer.byteLength(ELLIPSIS));
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}${ELLIPSIS}`;
}

/** Recorta a `maxBytes` UTF-8 en el último final de frase; si no hay una frase útil, en palabra con «…». */
export function truncateAtSentence(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const cut = truncateUtf8(text, maxBytes);
  const end = lastSentenceEnd(cut);
  return end >= MIN_SENTENCE_CHARS ? cut.slice(0, end) : cutAtWord(text, maxBytes);
}

export function fitAnswer(text, maxBytes) {
  return truncateAtSentence(cleanAnswer(text), maxBytes);
}

// --- modelo ---------------------------------------------------------------------------------------

/** Solo categoría y gravedad del incidente: nada de nombre, ubicación ni contactos. */
function contextLine(incident) {
  if (!incident) return 'sin incidente registrado';
  return `categoría: ${CATEGORY_LABELS[incident.category] ?? 'otra'}; gravedad: ${incident.severity}/3`;
}

export function buildAskPrompt(question, incident) {
  return `<contexto>${contextLine(incident)}</contexto>\n<pregunta>${escapeTags(question)}</pregunta>`;
}

/**
 * `asker(question, incident) -> Promise<{ text, model, usage }>`. Usa la misma clave y el mismo proxy que
 * el redactor de avisos (`buildClient`), con su propio modelo y tiempo de espera. Sin API key: null.
 */
export function createAsker(config, { client } = {}) {
  const apiClient = client ?? buildClient({ ...config.llm, timeoutMs: config.ask.timeoutMs });
  if (!apiClient) return null;
  return async (question, incident) => {
    const res = await apiClient.messages.create({
      model: config.ask.model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: buildAskPrompt(question, incident) }],
    });
    return { text: replyText(res), model: res.model ?? config.ask.model, usage: res.usage ?? {} };
  };
}

function withTimeout(promise, ms) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

// --- flujo del comando ----------------------------------------------------------------------------

function isEnabled(ctx) {
  return ctx.config.ask.enabled && typeof ctx.asker === 'function';
}

/** Rechazos que se resuelven sin llamar al modelo: función apagada, pregunta inválida, tope, saturación. */
function rejection(ctx, senderId, args) {
  if (!isEnabled(ctx)) return { status: STATUS.DISABLED, text: TEXT.disabled };
  const invalid = questionError(ctx.config.ask, args.q);
  if (invalid) return { status: STATUS.REJECTED, text: invalid };
  if (ctx.store.countAskSince(senderId, ctx.now() - DAY_S) >= ctx.config.ask.perDay) return { status: STATUS.REJECTED, text: TEXT.capped };
  if (ctx.store.countPendingAsks() >= ctx.config.ask.maxConcurrent) return { status: STATUS.REJECTED, text: TEXT.busy };
  return null;
}

function reply(ctx, user, job, { status, text }) {
  queueCmdResult(ctx, user, job.incidentId, { ref: job.ref, status, text });
  ctx.emit('ai_query', { senderId: job.senderId, incidentId: job.incidentId, data: { ref: job.ref, status } });
}

/**
 * Ruta del CMD `preguntar_ia` dentro de la petición del egress. Devuelve el ACK al momento; si la
 * pregunta es válida, la consulta al modelo queda en `work.after` y la respuesta llega luego por el buzón.
 */
export function startAsk(ctx, user, { incidentId, ref, args }, work) {
  const job = { senderId: user.sender_id, incidentId, ref };
  // Idempotencia (sender_id, ref): un ref repetido ya se respondió o está en curso.
  if (ctx.store.getAskJob(job.senderId, ref)) return ACK_RECEIVED;
  const refused = rejection(ctx, job.senderId, args);
  if (refused) {
    reply(ctx, user, job, refused);
    return ACK_RECEIVED;
  }
  ctx.store.startAskJob({ ...job, at: ctx.now() });
  work.after = () => runAsk(ctx, user, { ...job, question: args.q.trim() });
  return ACK_ASKING;
}

/** Nunca lanza: un error, una respuesta vacía o el tiempo agotado se convierten en status 2. */
async function consult(ctx, job) {
  try {
    const incident = ctx.store.getIncident(job.senderId, job.incidentId);
    const answer = await withTimeout(ctx.asker(job.question, incident), ctx.config.ask.timeoutMs);
    const text = fitAnswer(answer.text, ctx.config.ask.maxAnswerBytes);
    return text ? { status: STATUS.OK, text, model: answer.model, usage: answer.usage } : { status: STATUS.ERROR, text: TEXT.failed };
  } catch {
    return { status: STATUS.ERROR, text: TEXT.failed };
  }
}

function usageOf(result) {
  const usage = result.usage ?? {};
  return { model: result.model ?? null, inTokens: usage.input_tokens ?? null, outTokens: usage.output_tokens ?? null };
}

export async function runAsk(ctx, user, job) {
  const started = Date.now();
  const result = await consult(ctx, job);
  reply(ctx, user, job, result);
  ctx.store.finishAskJob({
    senderId: job.senderId, ref: job.ref, state: result.status === STATUS.OK ? 'done' : 'failed', status: result.status,
    at: ctx.now(), ms: Date.now() - started, ...usageOf(result),
  });
}

/** Al arrancar: las consultas que quedaron a medias por un reinicio reciben un CMD_RESULT de error. */
export function recoverPendingAsks(ctx) {
  for (const row of ctx.store.listPendingAsks()) {
    const job = { senderId: row.sender_id, incidentId: row.incident_id, ref: row.ref };
    const user = ctx.store.getUser(job.senderId);
    if (user) reply(ctx, user, job, { status: STATUS.ERROR, text: TEXT.interrupted });
    ctx.store.finishAskJob({ ...job, state: 'interrupted', status: STATUS.ERROR, at: ctx.now() });
  }
}
