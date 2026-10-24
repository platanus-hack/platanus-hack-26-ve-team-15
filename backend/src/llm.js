// Redactor de avisos. El LLM SOLO devuelve texto: nunca recibe herramientas, así que ni la nota del
// SOS ni nada escrito por usuarios o contactos puede disparar acciones (contrato §7).
import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

const SYSTEM = readFileSync(new URL('./prompts/alert-writer.txt', import.meta.url), 'utf8').trim();

// Los textos de usuarios no pueden cerrar las etiquetas que delimitan el dato no confiable.
const esc = (s) => String(s ?? '').replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›'));

export function buildPrompt({ incident, contact, mapUrl, replyUrl, note, lang }) {
  const lines = [
    `<lang>${lang}</lang>`,
    `<contact>${esc(contact.name)}${contact.relation ? ` (${esc(contact.relation)})` : ''}</contact>`,
    `<category>${incident.categoryLabel}</category>`,
    `<severity>${incident.severity}/3</severity>`,
    `<public_text>${esc(incident.public_text)}</public_text>`,
    `<user_note>${esc(note)}</user_note>`,
    `<map_url>${mapUrl ?? 'sin ubicación'}</map_url>`,
    `<reply_url>${replyUrl}</reply_url>`,
  ];
  return lines.join('\n');
}

/**
 * `writer(promptXml, fallbackText) -> Promise<string>`. Sin API key o ante cualquier error devuelve la
 * plantilla determinista, que es el camino probado; el LLM solo mejora la redacción.
 */
export function createMessageWriter(config, { client } = {}) {
  const apiClient = client ?? (config.llm.apiKey
    ? new Anthropic({
      apiKey: config.llm.apiKey,
      ...(config.llm.baseUrl ? { baseURL: config.llm.baseUrl } : {}),
      timeout: config.llm.timeoutMs,
      maxRetries: 0,
    })
    : null);
  if (!apiClient) return async (_prompt, fallback) => fallback;
  return async (prompt, fallback) => {
    try {
      const res = await apiClient.messages.create({
        model: config.llm.model,
        max_tokens: 2000,
        system: SYSTEM,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: prompt }],
      });
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      return text.length >= 10 && text.length <= 600 ? text : fallback;
    } catch {
      return fallback;
    }
  };
}
