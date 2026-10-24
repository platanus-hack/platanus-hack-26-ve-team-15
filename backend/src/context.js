// Contexto compartido: config, store, llaves, canales y utilidades para emitir paquetes del servidor.
import { EventEmitter } from 'node:events';
import {
  MAX_TEXT_BYTES, MSG, SEAL_OVERHEAD, buildCmdResultPlaintext, buildMsgInPlaintext, encodePacket, truncateUtf8,
} from './codec.js';
import { seal } from './crypto.js';

const MAX_PLAINTEXT = 312 - SEAL_OVERHEAD; // 264 B (contrato §2.1)
const MAX_BODY_TEXT = MAX_PLAINTEXT - 3;

export function createContext({ config, store, keys, channels, writer, now = () => Math.floor(Date.now() / 1000), log = console.log }) {
  const bus = new EventEmitter();
  bus.setMaxListeners(200);
  const pending = new Set();
  const ctx = {
    config, store, keys, channels, writer, now, log, bus, agentStarted: new Set(),
    /** Trabajo posterior a la respuesta (agente, avisos). Nunca bloquea al egress. */
    defer(fn) {
      const p = Promise.resolve().then(fn).catch((e) => log(`[deferred] ${e.stack || e}`)).finally(() => pending.delete(p));
      pending.add(p);
    },
    async idle() {
      while (pending.size) await Promise.all([...pending]);
    },
    emit(kind, { senderId = null, incidentId = null, data = {} } = {}) {
      const at = now();
      const id = store.addEvent({ at, kind, senderId, incidentId, data });
      bus.emit('event', { id, at, kind, sender_id: senderId, incident_id: incidentId, data });
    },
  };
  ctx.signServerPacket = (fields) => encodePacket({ ...fields, signer: { privateKey: keys.privateKey, senderId: keys.senderId } });
  return ctx;
}

/** ACK firmado por el servidor (contrato §3.3). `seq` es el confirmado; `category` el código de ACK. */
export function buildAck(ctx, { incidentId, seq, code, text }) {
  return ctx.signServerPacket({
    msgType: MSG.ACK, incidentId, seq, category: code, timestamp: ctx.now(), publicText: truncateUtf8(text, MAX_TEXT_BYTES),
  });
}

function addToMailbox(ctx, { senderId, incidentId, msgType, srvSeq, packet }) {
  const id = ctx.store.addMailbox({ senderId, incidentId, msgType, srvSeq, createdAt: ctx.now(), packetB64: packet.toString('base64') });
  ctx.emit('mailbox', { senderId, incidentId, data: { msg_type: msgType, mailbox_id: id } });
  ctx.onMailbox?.({ id, senderId, incidentId, msgType });
  return id;
}

export function queueAck(ctx, { senderId, incidentId, seq, code, text }) {
  const packet = buildAck(ctx, { incidentId, seq, code, text });
  return addToMailbox(ctx, { senderId, incidentId, msgType: MSG.ACK, srvSeq: 0, packet });
}

function queueSealed(ctx, user, incidentId, msgType, plaintext) {
  const srvSeq = ctx.store.nextServerSeq(user.sender_id, incidentId);
  const packet = ctx.signServerPacket({
    msgType, incidentId, seq: srvSeq, timestamp: ctx.now(), blob: seal(plaintext, user.seal_pk),
  });
  return { id: addToMailbox(ctx, { senderId: user.sender_id, incidentId, msgType, srvSeq, packet }), seq: srvSeq };
}

/** Respuesta de un contacto, sellada al usuario (MSG_IN). */
export function queueMsgIn(ctx, user, incidentId, { contactIdx, channel, text }) {
  const body = truncateUtf8(text, MAX_BODY_TEXT - 2);
  return queueSealed(ctx, user, incidentId, MSG.MSG_IN, buildMsgInPlaintext(contactIdx, channel, body));
}

/** Resultado de un CMD, sellado al usuario (CMD_RESULT). */
export function queueCmdResult(ctx, user, incidentId, { ref, status, text }) {
  const body = truncateUtf8(text, MAX_BODY_TEXT);
  return queueSealed(ctx, user, incidentId, MSG.CMD_RESULT, buildCmdResultPlaintext(ref, status, body));
}
