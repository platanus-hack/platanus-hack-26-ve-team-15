#!/usr/bin/env node
// Prueba real del modelo que responde `preguntar_ia`, con tus credenciales. No toca el mesh ni la base.
//
//   cd backend && node --env-file=../.env scripts/ask-smoke.mjs "¿Qué hago ante una quemadura?"
//
// Usa ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL (si hay proxy) y ANTHROPIC_ASK_MODEL (por defecto
// claude-haiku-5-5). Sirve para confirmar que el proxy acepta el modelo y para medir la latencia.
import { createAsker, fitAnswer } from '../src/ai.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig(process.env);
const asker = createAsker(config);
if (!asker) {
  console.error('Falta ANTHROPIC_API_KEY en el entorno.');
  process.exit(1);
}

const question = process.argv[2] ?? '¿Qué hago si alguien se desmaya?';
console.log(`modelo: ${config.ask.model}   base: ${config.llm.baseUrl ?? 'https://api.anthropic.com'}`);
console.log(`pregunta (${Buffer.byteLength(question)} B): ${question}\n`);

const started = Date.now();
try {
  const answer = await asker(question, { category: 1, severity: 2 });
  const fitted = fitAnswer(answer.text, config.ask.maxAnswerBytes);
  console.log(`latencia: ${Date.now() - started} ms   modelo devuelto: ${answer.model}`);
  console.log(`tokens: entrada ${answer.usage.input_tokens ?? '?'}, salida ${answer.usage.output_tokens ?? '?'}`);
  console.log(`respuesta del modelo (${Buffer.byteLength(answer.text)} B): ${answer.text}`);
  console.log(`lo que viajaría por el mesh (${Buffer.byteLength(fitted)} B de ${config.ask.maxAnswerBytes}): ${fitted}`);
  process.exit(fitted ? 0 : 1);
} catch (e) {
  console.error(`Error del modelo tras ${Date.now() - started} ms: ${e.status ?? ''} ${e.message}`);
  process.exit(1);
}
