// Pago Móvil adelantado y recargas contra el microcrédito (SIMULADO, ver credit.js). Un CMD usa el microcrédito
// cuando trae campos de Pago Móvil (banco, cédula, teléfono/destino, cuotas); con los argumentos de siempre
// (beneficiario, monto, moneda, concepto) sigue siendo el mock plano de commands.js.
import { ArgError, amount, currency, str } from './args.js';
import { INSTALLMENTS, charge, quote } from './credit.js';

const CREDIT_FIELDS = ['banco', 'cedula', 'telefono', 'destino', 'cuotas'];
const CEDULA = /^[VEJGPvejgp]?-?\d{5,10}$/;
const MOBILE_VE = /^(?:0|58)(?:412|414|416|424|426)\d{7}$/;
const MAX_PAYER_CHARS = 40;
const WHATSAPP_TEXT_CHARS = 200;

export const usesCredit = (args) => CREDIT_FIELDS.some((k) => args[k] !== undefined);

const usd = (cents) => `US$${(cents / 100).toFixed(2)}`;
const oneLine = (s) => String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Teléfono venezolano (0412 1234567, +58 412 1234567) o E.164 con «+» → solo dígitos con código de país.
 * Cualquier otra cosa se rechaza: el comprobante se envía a este número.
 */
export function normalizePhone(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const digits = raw.replace(/\D/g, '');
  if (!raw || raw.length > 24) throw new ArgError('telefono inválido');
  if (MOBILE_VE.test(digits)) return digits.startsWith('0') ? `58${digits.slice(1)}` : digits;
  if (raw.startsWith('+') && /^\d{8,15}$/.test(digits)) return digits;
  throw new ArgError('telefono inválido');
}

const mask = (digits) => `+${digits.slice(0, 5)}***${digits.slice(-4)}`;

function creditAmount(a) {
  const monto = amount(a.monto);
  const moneda = a.moneda === undefined ? 'USD' : currency(a.moneda);
  if (moneda !== 'USD') throw new ArgError('moneda no soportada: solo USD');
  if (a.cuotas !== undefined && a.cuotas !== INSTALLMENTS) throw new ArgError(`solo ${INSTALLMENTS} cuotas`);
  const cents = Math.round(monto * 100);
  if (cents < 1) throw new ArgError('monto inválido');
  return cents;
}

function optionalCedula(v) {
  if (v === undefined) return;
  if (!CEDULA.test(String(v))) throw new ArgError('cedula inválida');
}

/** `pagar` con campos de Pago Móvil: banco y teléfono son obligatorios; la cédula y el beneficiario, opcionales. */
export function parsePagoMovil(a) {
  const phone = normalizePhone(a.telefono ?? a.destino);
  const banco = str(a.banco, 40, 'banco');
  optionalCedula(a.cedula);
  const beneficiario = a.beneficiario === undefined ? null : str(a.beneficiario, 80, 'beneficiario');
  const concept = oneLine(str(a.concepto, 80, 'concepto'));
  return { kind: 'pagar', cents: creditAmount(a), phone, banco, beneficiario, concept, operator: null };
}

/** `recargar_saldo` con teléfono: recarga de una línea Movistar/Digitel/Movilnet contra el cupo. */
export function parseRecarga(a) {
  const operator = oneLine(str(a.operador, 40, 'operador'));
  const phone = normalizePhone(a.telefono ?? a.destino);
  return { kind: 'recargar_saldo', cents: creditAmount(a), phone, banco: null, beneficiario: null, concept: `Recarga ${operator}`, operator };
}

function receiptText(p, { parts, feeBps, availableAfter, refCode }) {
  const plan = `${INSTALLMENTS} cuotas de ${usd(parts[0])} (com. ${feeBps / 100}%). Cupo restante ${usd(availableAfter)}. Ref ${refCode}`;
  const to = mask(p.phone);
  return p.kind === 'pagar'
    ? `[MOCK] Pago Móvil adelantado ${usd(p.cents)} a ${to}. ${plan}`
    : `[MOCK] Recarga adelantada ${usd(p.cents)} a ${p.operator.slice(0, 16)} ${to}. ${plan}`;
}

function recipientText(ctx, senderId, p, refCode) {
  const payer = oneLine(ctx.store.getUser(senderId)?.display_name ?? '').slice(0, MAX_PAYER_CHARS) || 'Un usuario';
  const text = p.kind === 'pagar'
    ? `Baliza Vital: ${payer} te envió un Pago Móvil adelantado de ${usd(p.cents)} (${p.concept}). Ref ${refCode}. Es una simulación de demostración, no un pago real.`
    : `Baliza Vital: se simuló una recarga de ${usd(p.cents)} (${p.operator}) a tu línea. Ref ${refCode}. Demostración: no es una recarga real.`;
  return text.slice(0, WHATSAPP_TEXT_CHARS);
}

/** Comprobante al destinatario por el canal de texto real; en segundo plano y sin que un fallo afecte al comando. */
function notifyRecipient(ctx, senderId, p, refCode) {
  const sms = ctx.channels?.sms;
  if (!sms?.live) return;
  const text = recipientText(ctx, senderId, p, refCode);
  ctx.defer(() => sms.send({
    to: p.phone, text, kind: 'message', lang: 'es', contactName: p.phone,
    fields: { userName: 'Baliza Vital', text, reply: '-' }, incident: { incident_id: null },
  }));
}

/**
 * Valida el cupo y arma el recibo. No toca el cupo: devuelve `commit`, que commands.js ejecuta cuando ya pasaron
 * todos los topes, para no descontar un adelanto que luego se rechaza.
 */
export function advance(ctx, { senderId, ref, refCode }, p) {
  const q = quote(ctx, senderId, p.cents);
  if (!q.ok) throw new ArgError(`Cupo insuficiente: disponible ${usd(q.available)}`);
  const text = receiptText(p, { parts: q.parts, feeBps: q.feeBps, availableAfter: q.availableAfter, refCode });
  const receipt = {
    kind: p.kind, ref: refCode, amount_cents: p.cents, fee_cents: q.fee, installments: INSTALLMENTS, installment_cents: q.parts[0],
    available_cents: q.availableAfter, destination: mask(p.phone), concept: p.concept,
  };
  const commit = () => {
    const taken = charge(ctx, { senderId, ref, kind: p.kind, cents: p.cents, destination: receipt.destination, concept: p.concept, receiptRef: refCode });
    if (!taken) throw new ArgError('Cupo insuficiente');
    notifyRecipient(ctx, senderId, p, refCode);
  };
  return { amount: p.cents / 100, text, receipt, commit };
}
