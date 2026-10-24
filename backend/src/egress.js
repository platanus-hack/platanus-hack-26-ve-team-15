// POST /v1/egress (contrato §4). Orden de las comprobaciones: forma (400) -> registro (404) ->
// firma (401) -> duplicado -> tasa por emisor (429) -> ventana de tiempo (422). Es idempotente por
// (sender_id, incident_id, seq, msg_type) y responde sin esperar al agente ni a los canales.
import {
  MSG, MAX_INNER_BYTES, PacketError, decodePacket, parseCmdPlaintext, parseMsgOutPlaintext,
  parseSosPlaintext, verifyPacket,
} from './codec.js';
import { avisarContactos, registrarIncidente, runSosAgent } from './agent.js';
import { ASK_CMD, startAsk } from './ai.js';
import { buildAck, queueAck } from './context.js';
import { unseal } from './crypto.js';
import { executeCommand } from './commands.js';
import { HttpError } from './http.js';
import { applyRxCursor } from './radio.js';

const ACCEPTED_TYPES = new Set([MSG.SOS, MSG.UPDATE, MSG.MSG_OUT, MSG.CMD]);
const ALL_CONTACTS_SMS = { contactMask: 0xffffffff, channels: 1, rxCursor: 0, note: null };

function decodePacketB64(rawB64) {
  if (typeof rawB64 !== 'string' || !rawB64) throw new HttpError(400, 'packet_b64 required');
  // android.util.Base64.DEFAULT inserta saltos de línea cada 76 caracteres: se ignoran los espacios.
  const b64 = rawB64.replace(/\s+/g, '');
  if (b64.length > Math.ceil(MAX_INNER_BYTES / 3) * 4 + 4) throw new HttpError(400, `packet > ${MAX_INNER_BYTES} B`);
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new HttpError(400, 'packet_b64 is not valid base64');
  return Buffer.from(b64, 'base64');
}

function checkEgressId(id) {
  if (typeof id !== 'string' || !id || id.length > 64) throw new HttpError(400, 'rx.egress_id required');
}

function checkEnvelopeTtl(ttl) {
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > 255) throw new HttpError(400, 'rx.envelope_ttl must be 0..255');
}

function parseRx(rx) {
  if (!rx || typeof rx !== 'object') throw new HttpError(400, 'rx required');
  checkEgressId(rx.egress_id);
  checkEnvelopeTtl(rx.envelope_ttl);
  return { egressId: rx.egress_id, envelopeTtl: rx.envelope_ttl, rxAt: Number.isInteger(rx.rx_at) ? rx.rx_at : null };
}

function parseRequest(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'body must be a JSON object');
  const raw = decodePacketB64(body.packet_b64);
  return { raw, ...parseRx(body.rx) };
}

function ackBody(status, packet, ackB64) {
  return { status, incident_id: packet.incidentId, seq: packet.seq, ack_packet_b64: ackB64 };
}

/** Plaintext del blob, o null si no abre o su formato no es el del tipo. */
function openBlob(ctx, packet, parse) {
  if (!packet.sealedBlob.length) return null;
  const pt = unseal(packet.sealedBlob, ctx.keys.sealPk, ctx.keys.sealSk);
  if (!pt) return null;
  try {
    return parse(pt);
  } catch (e) {
    if (e instanceof PacketError) return null;
    throw e;
  }
}

function hitLimit(limiter, key, max, who) {
  if (!limiter.hit(key, max, 60)) throw new HttpError(429, `rate limit (${who})`);
}

function decodeOrReject(raw) {
  try {
    return decodePacket(raw);
  } catch (e) {
    if (e instanceof PacketError) throw new HttpError(400, e.message);
    throw e;
  }
}

function checkAccepted(ctx, packet) {
  if (!ACCEPTED_TYPES.has(packet.msgType) || packet.senderId === ctx.keys.senderId) {
    throw new HttpError(400, `msg_type ${packet.msgType} is not accepted from egress`);
  }
}

function authenticate(ctx, packet) {
  const user = ctx.store.getUser(packet.senderId);
  if (!user) throw new HttpError(404, 'sender not registered');
  if (!verifyPacket(packet, user.sign_pk)) throw new HttpError(401, 'invalid signature');
  return user;
}

function checkWindow(ctx, packet) {
  const now = ctx.now();
  if (packet.timestamp - now > ctx.config.futureSkewS || now - packet.timestamp > ctx.config.pastWindowS) {
    throw new HttpError(422, 'timestamp out of window');
  }
}

/** Dentro de la transacción: procesa el paquete, guarda el ACK (idempotencia) y lo deja en el buzón. */
function record(ctx, { packet, user, req, hops, work }) {
  const { senderId, incidentId, seq } = packet;
  const out = processPacket(ctx, packet, user, { hops, egressId: req.egressId, work });
  const bytes = buildAck(ctx, { incidentId, seq, code: out.ackCode, text: out.ackText });
  ctx.store.insertPacket({ senderId, incidentId, seq, msgType: packet.msgType, ackB64: bytes.toString('base64'),
    egressId: req.egressId, envelopeTtl: req.envelopeTtl, hops, rxAt: req.rxAt });
  // Las balizas (UPDATE) no necesitan ACK por buzón: la siguiente ocupa su lugar (R6).
  if (packet.msgType !== MSG.UPDATE) queueAck(ctx, { senderId, incidentId, seq, code: out.ackCode, text: out.ackText });
  ctx.emit('packet_received', { senderId, incidentId, data: { msg_type: packet.msgType, seq, hops, egress_id: req.egressId } });
  return bytes;
}

function accept(ctx, { packet, user, req }) {
  const hops = Math.max(0, packet.ttl - req.envelopeTtl);
  const work = { after: null };
  const ack = ctx.store.tx(() => record(ctx, { packet, user, req, hops, work }));
  if (work.after) ctx.defer(work.after);
  return { status: 200, body: ackBody('accepted', packet, ack.toString('base64')) };
}

export function handleEgress(ctx, body, limiter) {
  const req = parseRequest(body);
  const { rate } = ctx.config;
  hitLimit(limiter, `egress:${req.egressId}`, rate.egressPerMin, 'egress');
  const packet = decodeOrReject(req.raw);
  checkAccepted(ctx, packet);
  const user = authenticate(ctx, packet);
  // Un reenvío ya aceptado (R1) se responde antes de contar la tasa: varios egress pueden oír el mismo
  // reintento y un 429/4xx haría que el egress descarte el paquete (R3).
  const dup = ctx.store.getPacket(packet.senderId, packet.incidentId, packet.seq, packet.msgType);
  if (dup) return { status: 200, body: ackBody('duplicate', packet, dup.ack_b64) };
  hitLimit(limiter, `sender:${packet.senderId}`, rate.senderPerMin, 'sender');
  checkWindow(ctx, packet);
  return accept(ctx, { packet, user, req });
}

function processPacket(ctx, packet, user, { hops, egressId, work }) {
  switch (packet.msgType) {
    case MSG.SOS:
    case MSG.UPDATE:
      return processSos(ctx, packet, user, { hops, egressId, work });
    case MSG.MSG_OUT:
      return processMsgOut(ctx, packet, user, work);
    default:
      return processCmd(ctx, packet, user, work);
  }
}

function sosArgs(packet, parsed) {
  return {
    sender_id: packet.senderId, incident_id: packet.incidentId, category: packet.category, severity: packet.severity,
    lat: packet.lat, lon: packet.lon, accuracy_m: packet.accuracyM, location_age_s: packet.locationAge,
    public_text: packet.publicText, ...(parsed ? { nota: parsed.note } : {}),
  };
}

/** El recibo del origen (rx_cursor) detiene el envío por radio de lo que ya recibió. */
function recordRxCursor(ctx, packet, parsed) {
  if (!parsed) return;
  const incident = ctx.store.getIncident(packet.senderId, packet.incidentId);
  if (parsed.rxCursor <= incident.rx_cursor) return;
  ctx.store.updateIncident(packet.senderId, packet.incidentId, { rxCursor: parsed.rxCursor });
  applyRxCursor(ctx, packet.senderId, packet.incidentId, parsed.rxCursor);
}

/** El agente corre una sola vez por incidente, aunque el SOS llegue después de una baliza. */
function needsAgent(ctx, packet, created) {
  return (created || packet.msgType === MSG.SOS) && ctx.store.listNotifications(packet.senderId, packet.incidentId).length === 0;
}

function agentTask(ctx, packet, plain) {
  const key = `${packet.senderId}:${packet.incidentId}`;
  return () => {
    if (ctx.agentStarted.has(key)) return undefined;
    ctx.agentStarted.add(key);
    return runSosAgent(ctx, { senderId: packet.senderId, incidentId: packet.incidentId, seq: packet.seq,
      contactMask: plain.contactMask, channels: plain.channels, note: plain.note });
  };
}

function processSos(ctx, packet, user, { hops, egressId, work }) {
  const parsed = openBlob(ctx, packet, parseSosPlaintext);
  const meta = { hops, egressId, blobReadable: Boolean(parsed), seq: packet.seq, timestamp: packet.timestamp };
  const { creado } = registrarIncidente(ctx, sosArgs(packet, parsed), meta);
  if (!parsed) ctx.emit('blob_unreadable', { senderId: packet.senderId, incidentId: packet.incidentId, data: { msg_type: packet.msgType } });
  recordRxCursor(ctx, packet, parsed);
  if (packet.severity === 0) return { ackCode: 0, ackText: 'Recibido. Incidente cerrado' };
  if (needsAgent(ctx, packet, creado)) work.after = agentTask(ctx, packet, parsed ?? ALL_CONTACTS_SMS);
  return { ackCode: 2, ackText: 'Recibido. El agente gestiona tu caso' };
}

function processMsgOut(ctx, packet, user, work) {
  const msg = openBlob(ctx, packet, parseMsgOutPlaintext);
  if (!msg) return { ackCode: 3, ackText: 'No se pudo leer el mensaje' };
  const contactos = msg.contactIdx === 0xff ? 'todos' : [msg.contactIdx];
  const canales = [[1, 'sms'], [2, 'email'], [4, 'llamada_voz']].filter(([bit]) => msg.channels & bit).map(([, n]) => n);
  work.after = async () => {
    for (const canal of canales) {
      await avisarContactos(ctx, packet.senderId, { incident_id: packet.incidentId, canal, contactos, mensaje: msg.text });
    }
  };
  return { ackCode: 0, ackText: 'Recibido. Enviando a tus contactos' };
}

function processCmd(ctx, packet, user, work) {
  const cmd = openBlob(ctx, packet, parseCmdPlaintext);
  if (!cmd) return { ackCode: 3, ackText: 'No se pudo leer el comando' };
  if (cmd.ref < 0 || cmd.ref > 0xffff) return { ackCode: 3, ackText: 'Comando con ref inválido' };
  const params = { incidentId: packet.incidentId, cmd: cmd.cmd, ref: cmd.ref, args: cmd.args };
  // La consulta a la IA es asíncrona: ACK ahora, CMD_RESULT por el buzón cuando responda el modelo.
  if (cmd.cmd === ASK_CMD) return startAsk(ctx, user, params, work);
  executeCommand(ctx, user, params);
  return { ackCode: 0, ackText: 'Recibido' };
}
