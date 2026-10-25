package com.baliza.emergency.pay

import com.baliza.emergency.EmergencyMeshTransport
import com.baliza.emergency.ReceivedEmergencyPacket
import com.baliza.emergency.SendResult
import com.baliza.emergency.ask.AskCounters
import com.baliza.emergency.ask.AskStore
import com.baliza.emergency.ask.NoAskStore
import com.baliza.emergency.codec.EmergencyCodec
import com.baliza.emergency.codec.EmergencyPacket
import com.baliza.emergency.codec.EmergencyType
import com.baliza.emergency.crypto.Ed25519
import com.baliza.emergency.crypto.SealedBox
import com.baliza.emergency.identity.ServerKeys
import com.baliza.emergency.identity.UserIdentity
import com.baliza.emergency.replies.ReplyInbox
import com.baliza.emergency.sos.RetrySchedule
import com.google.gson.GsonBuilder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.security.SecureRandom

/**
 * Pays with no internet: a Pago Móvil (`pagar`) or a top-up (`recargar_saldo`) advanced by the server against a
 * microcredit line. Both are SIMULATED: no bank is called and no money moves. The `CMD` is sealed to the server,
 * sent into the incident the server already acknowledged and resent until its own ACK arrives; then one
 * `CMD_RESULT` sealed to this user carries the `[MOCK]` receipt, the instalment plan and the credit left.
 *
 * It shares [store] with [com.baliza.emergency.ask.QuestionSender]: both draw `seq` numbers of the same incident
 * and `ref`s of the same user, and the server drops a repeated one. Pass the same instance to both.
 * Runs on [scope]; use the single-threaded scope of the SOS sender.
 */
class PaymentSender(
    private val transport: EmergencyMeshTransport,
    private val identity: UserIdentity,
    private val serverKeys: () -> ServerKeys?,
    /** The acknowledged incident, or null if there is none (see SosSender.acknowledgedIncidentId). */
    private val incidentId: () -> ByteArray?,
    private val scope: CoroutineScope,
    private val newNeighbors: Flow<Unit> = transport.newNeighbors,
    private val store: AskStore = NoAskStore,
    private val nowMillis: () -> Long = System::currentTimeMillis,
    private val random: SecureRandom = SecureRandom(),
    private val schedule: RetrySchedule = RetrySchedule(),
    /** Called once when the payment reaches a final state (e.g. to vibrate). */
    private val onFinished: (PayStatus) -> Unit = {}
) {
    private val _status = MutableStateFlow(PayStatus())
    val status: StateFlow<PayStatus> = _status.asStateFlow()

    private class Pending(val incident: ByteArray, val seq: Int, val ref: Int, val wire: ByteArray, val startedAt: Long)

    private var pending: Pending? = null
    private var jobs: List<Job> = emptyList()
    private var retryJob: Job? = null
    private val restart = Channel<Unit>(Channel.CONFLATED)

    fun pay(request: PaymentRequest): PayStart {
        if (_status.value.busy) return PayStart.Busy
        val server = serverKeys() ?: return PayStart.NotRegistered
        val incident = incidentId() ?: return PayStart.NoIncident
        val args = PaymentArgs.parse(request).getOrElse { return PayStart.Invalid(it.message ?: "datos inválidos") }

        val incidentHex = hex(incident)
        val counters = store.load()
        val seq = (counters.lastSeq[incidentHex] ?: 1) + 1
        if (seq > MAX_SEQ) return PayStart.Invalid("Demasiados paquetes en este aviso.")
        val ref = freshRef(counters.usedRefs)

        val json = commandJson(ref, args).toByteArray(Charsets.UTF_8)
        if (json.size > MAX_CMD_BYTES) return PayStart.Invalid("Los datos no caben en un paquete: acorta el concepto o el banco.")
        val wire = try {
            EmergencyCodec.encode(EmergencyCodec.sign(packet(incident, seq, SealedBox.seal(json, server.sealPublicKey, random)), identity.signSeed))
        } catch (e: IllegalArgumentException) {
            return PayStart.Invalid(e.message ?: "El paquete no cabe.")
        }

        // Spent before it is sent: if the app dies mid-send, the next command cannot collide with this one.
        store.save(AskCounters(counters.lastSeq + (incidentHex to seq), (counters.usedRefs + ref).takeLast(MAX_REFS_KEPT)))
        begin(Pending(incident, seq, ref, wire, nowMillis()), args.summary())
        return PayStart.Started
    }

    /** Back to the empty state, e.g. to fill in another payment. Does not tell the server anything. */
    fun reset() {
        jobs.forEach(Job::cancel)
        jobs = emptyList()
        retryJob = null
        pending = null
        _status.value = PayStatus()
    }

    // --- building ---

    private fun freshRef(used: List<Int>): Int {
        repeat(32) {
            val candidate = 1 + random.nextInt(MAX_REF) // 1..65535: 0 is kept free
            if (candidate !in used) return candidate
        }
        return (1..MAX_REF).first { it !in used }
    }

    private fun packet(incident: ByteArray, seq: Int, sealed: ByteArray) = EmergencyPacket(
        type = EmergencyType.CMD,
        ttl = EmergencyMeshTransport.DEFAULT_TTL,
        incidentId = incident,
        seq = seq,
        timestamp = nowMillis() / 1000,
        senderId = identity.senderId,
        sealedBlob = sealed
    )

    // --- sending ---

    private fun begin(p: Pending, summary: String) {
        jobs.forEach(Job::cancel)
        pending = p
        _status.value = PayStatus(PayState.SENDING, summary)
        val retry = scope.launch { retryLoop(p) }
        retryJob = retry
        jobs = listOf(
            scope.launch { transport.incoming.collect(::onReceived) },
            scope.launch { newNeighbors.collect { restart.trySend(Unit) } },
            retry
        )
    }

    private suspend fun sendOnce(p: Pending) {
        val accepted = try {
            transport.send(p.wire, EmergencyMeshTransport.DEFAULT_TTL) == SendResult.SENT
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            false
        }
        _status.update { s -> if (pending !== p || s.state != PayState.SENDING) s else PayStatus(s.state, s.summary, s.text, s.attempts + if (accepted) 1 else 0) }
    }

    /** Same schedule as the SOS (R1) until the ACK for this `seq` arrives; then only the receipt is awaited. */
    private suspend fun retryLoop(p: Pending) {
        sendOnce(p)
        while (_status.value.state == PayState.SENDING) {
            val elapsed = nowMillis() - p.startedAt
            if (elapsed >= schedule.giveUpAfterMs) {
                _status.update { s -> if (pending === p && s.state == PayState.SENDING) PayStatus(PayState.STOPPED, s.summary, "", s.attempts) else s }
                return
            }
            val interval = if (elapsed < schedule.fastWindowMs) schedule.fastIntervalMs else schedule.slowIntervalMs
            if (withTimeoutOrNull(interval) { restart.receive() } != null) delay(schedule.neighborSettleMs)
            if (_status.value.state == PayState.SENDING) sendOnce(p)
        }
    }

    // --- what comes back ---

    private fun onReceived(received: ReceivedEmergencyPacket) {
        val p = pending ?: return
        val packet = EmergencyCodec.decodeOrNull(received.payload) ?: return
        if (!packet.incidentId.contentEquals(p.incident)) return
        val server = serverKeys() ?: return
        if (!packet.senderId.contentEquals(Ed25519.senderId(server.signPublicKey))) return
        if (!EmergencyCodec.verify(packet, server.signPublicKey)) return
        when (packet.type) {
            EmergencyType.ACK -> onAck(p, packet)
            EmergencyType.CMD_RESULT -> onResult(p, packet)
            else -> Unit
        }
    }

    /** Only the ACK of this payment's own `seq`. Code 3 means the server could not read it. */
    private fun onAck(p: Pending, ack: EmergencyPacket) {
        if (ack.seq != p.seq || _status.value.state != PayState.SENDING) return
        if (ack.category == ACK_REFUSED) {
            finish(p, PayState.REJECTED, "El servidor no pudo leer el pago.")
            return
        }
        _status.update { s -> PayStatus(PayState.ACCEPTED, s.summary, "", s.attempts) }
        retryJob?.cancel()
    }

    /** CMD_RESULT: ref(2) · status(1) · text. Matched on `ref`; another command's result is ignored. */
    private fun onResult(p: Pending, packet: EmergencyPacket) {
        if (_status.value.state != PayState.SENDING && _status.value.state != PayState.ACCEPTED) return
        val plain = SealedBox.open(packet.sealedBlob, identity.sealPublicKey, identity.sealPrivateKey) ?: return
        if (plain.size < 3) return
        if ((((plain[0].toInt() and 0xFF) shl 8) or (plain[1].toInt() and 0xFF)) != p.ref) return
        val text = ReplyInbox.decodeUtf8(plain, 3)?.let { ReplyInbox.clean(it, MAX_TEXT_CHARS) } ?: return
        val state = when (plain[2].toInt() and 0xFF) {
            RESULT_OK -> PayState.APPROVED
            RESULT_REFUSED -> PayState.REJECTED
            RESULT_FAILED -> PayState.FAILED
            RESULT_DISABLED -> PayState.DISABLED
            else -> return
        }
        finish(p, state, text)
    }

    private fun finish(p: Pending, state: PayState, text: String) {
        if (pending !== p) return
        jobs.forEach(Job::cancel)
        jobs = emptyList()
        _status.update { s -> PayStatus(state, s.summary, text, s.attempts) }
        try { onFinished(_status.value) } catch (_: Exception) { /* a failing vibration must not lose the receipt */ }
    }

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    companion object {
        /** Sealed plaintext limit of a CMD (docs/contrato.md §2.1). */
        const val MAX_CMD_BYTES = 264
        private const val MAX_TEXT_CHARS = 300
        private const val MAX_SEQ = 0xFFFF
        private const val MAX_REF = 0xFFFF
        private const val MAX_REFS_KEPT = 500
        private const val ACK_REFUSED = 3
        private const val RESULT_OK = 0
        private const val RESULT_REFUSED = 1
        private const val RESULT_FAILED = 2
        private const val RESULT_DISABLED = 3

        // No HTML escaping: it would turn quotes and `<` into \u00XX and eat the 264 B budget.
        private val gson = GsonBuilder().disableHtmlEscaping().create()

        /**
         * `{"cmd":"pagar","ref":<ref>,"args":{"banco","cedula"?,"telefono","monto","concepto"}}` or
         * `{"cmd":"recargar_saldo","ref":<ref>,"args":{"operador","telefono","monto"}}`, exactly as the server parses
         * them. `moneda` is left out: with Pago Móvil fields the server settles in USD.
         */
        internal fun commandJson(ref: Int, a: PaymentArgs): String {
            val args = linkedMapOf<String, Any>()
            if (a.kind == PayKind.PAGO_MOVIL) {
                args["banco"] = a.bank.orEmpty()
                a.idNumber?.let { args["cedula"] = it }
            } else {
                args["operador"] = a.carrier.orEmpty()
            }
            args["telefono"] = a.phone
            args["monto"] = a.amountJson
            if (a.kind == PayKind.PAGO_MOVIL) args["concepto"] = a.concept.orEmpty()
            return gson.toJson(linkedMapOf("cmd" to a.kind.cmd, "ref" to ref, "args" to args))
        }
    }
}
