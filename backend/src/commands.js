// Ejecución de CMD firmados (contrato §7). Todo lo monetario o de movilidad es SIMULADO: el único
// adaptador es el mock de este archivo, no hay credenciales ni llamadas de red. Solo un CMD firmado por
// el usuario (paquete tipo 6 ya verificado) llega aquí; el texto de MSG_IN o de la nota nunca lo hace.
import { createHash } from 'node:crypto';
import { consultarAlertas } from './agent.js';
import { queueCmdResult } from './context.js';

export const STATUS = Object.freeze({ OK: 0, REJECTED: 1, ERROR: 2, DISABLED: 3 });

const PAYMENT_CMDS = new Set(['recargar_saldo', 'pagar']);
const RIDE_CMDS = new Set(['pedir_ride', 'pedir_delivery']);
const KNOWN = new Set(['consultar_alertas', ...PAYMENT_CMDS, ...RIDE_CMDS]);

class ArgError extends Error {}

const DAY_S = 24 * 3600;

function str(v, max, field) {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new ArgError(`${field} inválido`);
  return v.trim();
}

function amount(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 100_000) throw new ArgError('monto inválido');
  return v;
}

function currency(v) {
  if (typeof v !== 'string' || !/^[A-Za-z]{3}$/.test(v)) throw new ArgError('moneda inválida');
  return v.toUpperCase();
}

function mockRef(senderId, ref, cmd) {
  const digest = createHash('sha256').update(`${senderId}:${ref}:${cmd}`).digest('hex');
  return `MOCK-${digest.slice(0, 8).toUpperCase()}`;
}

function mockEta(senderId, ref) {
  return 4 + (createHash('sha256').update(`${senderId}:${ref}`).digest()[0] % 8);
}

/** Coordenada del argumento o, si falta, la del incidente (guardada en grados × 1e5). */
function coordinate(arg, incidentValue) {
  if (typeof arg === 'number') return arg;
  return incidentValue == null ? null : incidentValue / 1e5;
}

function alertsSummary(alertas) {
  if (!alertas.length) return 'Sin alertas cercanas';
  const list = alertas.slice(0, 3).map((x) => `${x.tipo} a ${x.distancia_m} m`).join('; ');
  return `${alertas.length} alerta(s) cercanas: ${list}`;
}

// Cada herramienta valida sus argumentos con un esquema estricto y devuelve { text, amount }.
const TOOLS = {
  recargar_saldo(a, { senderId, ref }) {
    const operador = str(a.operador, 40, 'operador');
    const monto = amount(a.monto);
    const moneda = currency(a.moneda);
    return { amount: monto, text: `[MOCK] Recarga simulada de ${monto} ${moneda} a ${operador}. Ref ${mockRef(senderId, ref, 'recargar_saldo')}` };
  },
  pagar(a, { senderId, ref }) {
    const beneficiario = str(a.beneficiario, 80, 'beneficiario');
    const monto = amount(a.monto);
    const moneda = currency(a.moneda);
    const concepto = str(a.concepto, 80, 'concepto');
    return { amount: monto, text: `[MOCK] Pago simulado de ${monto} ${moneda} a ${beneficiario} (${concepto}). Ref ${mockRef(senderId, ref, 'pagar')}` };
  },
  pedir_ride(a, { senderId, ref }) {
    const destino = str(a.destino, 80, 'destino');
    const modo = str(a.modo ?? 'normal', 20, 'modo');
    return { amount: 0, text: `[MOCK] Ride simulado a ${destino} (${modo}), llega en ${mockEta(senderId, ref)} min. Ref ${mockRef(senderId, ref, 'pedir_ride')}` };
  },
  pedir_delivery(a, { senderId, ref }) {
    const comercio = str(a.comercio, 80, 'comercio');
    const direccion = str(a.direccion, 120, 'direccion');
    if (!Array.isArray(a.articulos) || !a.articulos.length || a.articulos.length > 10) throw new ArgError('articulos inválidos');
    const articulos = a.articulos.map((x) => str(x, 60, 'articulo'));
    return { amount: 0, text: `[MOCK] Delivery simulado de ${articulos.length} artículo(s) desde ${comercio} a ${direccion}, llega en ${mockEta(senderId, ref) + 15} min. Ref ${mockRef(senderId, ref, 'pedir_delivery')}` };
  },
  consultar_alertas(a, { ctx, incident }) {
    const lat = coordinate(a.lat, incident?.lat);
    const lon = coordinate(a.lon, incident?.lon);
    if (lat === null || lon === null) throw new ArgError('sin ubicación');
    const { alertas } = consultarAlertas(ctx, { lat, lon, radio_m: a.radio_m, desde: a.desde });
    return { amount: 0, text: alertsSummary(alertas) };
  },
};

function featureOff(ctx, cmd) {
  return (PAYMENT_CMDS.has(cmd) && !ctx.config.featurePayments) || (RIDE_CMDS.has(cmd) && !ctx.config.featureRides);
}

function outcome(status, text, amountValue = 0) {
  return { status, text, amount: amountValue };
}

function dailyCountReached(ctx, { senderId, cmd }) {
  return cmd !== 'consultar_alertas' && ctx.store.countCommandsSince(senderId, ctx.now() - DAY_S) >= ctx.config.limits.cmdPerDay;
}

function amountCapped(ctx, senderId, amountValue) {
  return amountValue > 0 && ctx.store.sumCommandAmountSince(senderId, ctx.now() - DAY_S) + amountValue > ctx.config.limits.cmdAmountPerDay;
}

/** Rechazos que no necesitan ejecutar nada (comando desconocido, función apagada, tope de comandos). */
function precheck(ctx, c) {
  if (!KNOWN.has(c.cmd)) return outcome(STATUS.REJECTED, 'Comando no reconocido');
  if (featureOff(ctx, c.cmd)) return outcome(STATUS.DISABLED, 'Función desactivada');
  if (dailyCountReached(ctx, c)) return outcome(STATUS.REJECTED, 'Tope diario de comandos alcanzado');
  return null;
}

function execute(ctx, c) {
  try {
    const incident = ctx.store.getIncident(c.senderId, c.incidentId);
    const out = TOOLS[c.cmd](c.args, { ctx, senderId: c.senderId, ref: c.ref, incident });
    if (amountCapped(ctx, c.senderId, out.amount)) return outcome(STATUS.REJECTED, 'Tope diario de monto alcanzado');
    return outcome(STATUS.OK, out.text, out.amount);
  } catch (e) {
    if (e instanceof ArgError) return outcome(STATUS.REJECTED, e.message);
    ctx.log(`[cmd] ${c.cmd}: ${e.stack || e}`);
    return outcome(STATUS.ERROR, 'Error al ejecutar el comando');
  }
}

/** Decide y registra el resultado. Idempotente por (sender_id, ref): un ref repetido no se re-ejecuta. */
export function decideCommand(ctx, c) {
  const prior = ctx.store.getCommand(c.senderId, c.ref);
  if (prior) return { status: prior.status, text: prior.result_text, repeated: true };
  const result = precheck(ctx, c) ?? execute(ctx, c);
  ctx.store.addCommand({ senderId: c.senderId, ref: c.ref, cmd: c.cmd, status: result.status, resultText: result.text, amount: result.amount, at: ctx.now() });
  return { status: result.status, text: result.text, repeated: false };
}

export function executeCommand(ctx, user, params) {
  const result = decideCommand(ctx, { ...params, senderId: user.sender_id });
  if (!result.repeated) {
    queueCmdResult(ctx, user, params.incidentId, { ref: params.ref, status: result.status, text: result.text });
    ctx.emit('command', { senderId: user.sender_id, incidentId: params.incidentId, data: { cmd: params.cmd, ref: params.ref, status: result.status } });
  }
  return result;
}
