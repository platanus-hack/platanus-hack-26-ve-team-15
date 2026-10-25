package com.baliza.emergency.ask

import com.baliza.emergency.EmergencyMeshTransport
import com.baliza.emergency.ReceivedEmergencyPacket
import com.baliza.emergency.SendResult
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
 * Asks an AI a question with no internet (docs/contrato.md §7.1): a `CMD` `preguntar_ia` sealed to the server,
 * sent into the incident the server already acknowledged, resent until its own ACK arrives, then one
 * `CMD_RESULT` sealed to this user with the answer.
 *
 * The answer is text written by a model about text written by the user: it is only ever shown, never acted on.
 * Runs on [scope]; use the single-threaded scope of the SOS sender.
 */
class QuestionSender(
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
    /** Called once when the question reaches a final state (e.g. to vibrate). */
    private val onFinished: (AskStatus) -> Unit = {}
) {
    private val _status = MutableStateFlow(AskStatus())
    val status: StateFlow<AskStatus> = _status.asStateFlow()

    private class Pending(val incident: ByteArray, val seq: Int, val ref: Int, val wire: ByteArray, val startedAt: Long)

    private var pending: Pending? = null
    private var jobs: List<Job> = emptyList()
    private var retryJob: Job? = null
    private val restart = Channel<Unit>(Channel.CONFLATED)

    fun ask(rawQuestion: String): AskStart {
        if (_status.value.busy) return AskStart.Busy
        val server = serverKeys() ?: return AskStart.NotRegistered
        val incident = incidentId() ?: return AskStart.NoIncident
        val question = rawQuestion.trim()
        questionProblem(question)?.let { return AskStart.Invalid(it) }

        val incidentHex = hex(incident)
        val counters = store.load()
        val seq = (counters.lastSeq[incidentHex] ?: 1) + 1
        if (seq > MAX_SEQ) return AskStart.Invalid("too many packets in this incident")
        val ref = freshRef(counters.usedRefs)

        val json = commandJson(ref, question)
        if (json.toByteArray(Charsets.UTF_8).size > MAX_CMD_BYTES) return AskStart.Invalid("question does not fit once encoded")
        val wire = try {
            EmergencyCodec.encode(EmergencyCodec.sign(packet(incident, seq, SealedBox.seal(json.toByteArray(Charsets.UTF_8), server.sealPublicKey, random)), identity.signSeed))
        } catch (e: IllegalArgumentException) {
            return AskStart.Invalid(e.message ?: "packet does not fit")
        }

        // Spent before it is sent: if the app dies mid-send, the next question cannot collide with this one.
        store.save(AskCounters(counters.lastSeq + (incidentHex to seq), (counters.usedRefs + ref).takeLast(MAX_REFS_KEPT)))
        begin(Pending(incident, seq, ref, wire, nowMillis()), question)
        return AskStart.Started
    }

    /** Back to the empty state, e.g. to type another question. Does not tell the server anything. */
    fun reset() {
        jobs.forEach(Job::cancel)
        jobs = emptyList()
        retryJob = null
        pending = null
        _status.value = AskStatus()
    }

    // --- building ---

    private fun questionProblem(q: String): String? = when {
        q.isEmpty() -> "write a question"
        q.length > MAX_QUESTION_CHARS -> "question over $MAX_QUESTION_CHARS characters"
        q.toByteArray(Charsets.UTF_8).size > MAX_QUESTION_BYTES -> "question over $MAX_QUESTION_BYTES bytes"
        else -> null
    }

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

    private fun begin(p: Pending, question: String) {
        jobs.forEach(Job::cancel)
        pending = p
        _status.value = AskStatus(AskState.SENDING, question)
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
        _status.update { s -> if (pending !== p || s.state != AskState.SENDING) s else AskStatus(s.state, s.question, s.text, s.attempts + if (accepted) 1 else 0) }
    }

    /** Same schedule as the SOS (R1) until the ACK for this `seq` arrives; then only the answer is awaited. */
    private suspend fun retryLoop(p: Pending) {
        sendOnce(p)
        while (_status.value.state == AskState.SENDING) {
            val elapsed = nowMillis() - p.startedAt
            if (elapsed >= schedule.giveUpAfterMs) {
                _status.update { s -> if (pending === p && s.state == AskState.SENDING) AskStatus(AskState.STOPPED, s.question, "", s.attempts) else s }
                return
            }
            val interval = if (elapsed < schedule.fastWindowMs) schedule.fastIntervalMs else schedule.slowIntervalMs
            if (withTimeoutOrNull(interval) { restart.receive() } != null) delay(schedule.neighborSettleMs)
            if (_status.value.state == AskState.SENDING) sendOnce(p)
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

    /** Only the ACK of this question's own `seq`. Code 3 means the server could not read it. */
    private fun onAck(p: Pending, ack: EmergencyPacket) {
        if (ack.seq != p.seq || _status.value.state != AskState.SENDING) return
        if (ack.category == ACK_REFUSED) {
            finish(p, AskState.REJECTED, "El servidor no pudo leer la pregunta.")
            return
        }
        _status.update { s -> AskStatus(AskState.ACCEPTED, s.question, "", s.attempts) }
        retryJob?.cancel()
    }

    /** CMD_RESULT: ref(2) · status(1) · text. Matched on `ref`; another question's answer is ignored. */
    private fun onResult(p: Pending, packet: EmergencyPacket) {
        if (_status.value.state != AskState.SENDING && _status.value.state != AskState.ACCEPTED) return
        val plain = SealedBox.open(packet.sealedBlob, identity.sealPublicKey, identity.sealPrivateKey) ?: return
        if (plain.size < 3) return
        if ((((plain[0].toInt() and 0xFF) shl 8) or (plain[1].toInt() and 0xFF)) != p.ref) return
        val text = ReplyInbox.decodeUtf8(plain, 3)?.let { ReplyInbox.clean(it, MAX_ANSWER_CHARS) } ?: return
        val state = when (plain[2].toInt() and 0xFF) {
            RESULT_OK -> AskState.ANSWERED
            RESULT_REFUSED -> AskState.REJECTED
            RESULT_FAILED -> AskState.FAILED
            RESULT_DISABLED -> AskState.DISABLED
            else -> return
        }
        finish(p, state, text)
    }

    private fun finish(p: Pending, state: AskState, text: String) {
        if (pending !== p) return
        jobs.forEach(Job::cancel)
        jobs = emptyList()
        _status.update { s -> AskStatus(state, s.question, text, s.attempts) }
        try { onFinished(_status.value) } catch (_: Exception) { /* a failing vibration must not lose the answer */ }
    }

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    companion object {
        const val MAX_QUESTION_CHARS = 200
        const val MAX_QUESTION_BYTES = 210

        /** Sealed plaintext limit of a CMD (docs/contrato.md §2.1). */
        const val MAX_CMD_BYTES = 264
        private const val MAX_ANSWER_CHARS = 300
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

        /** `{"cmd":"preguntar_ia","ref":<ref>,"args":{"q":"<question>"}}`, exactly as the server parses it. */
        fun commandJson(ref: Int, question: String): String =
            gson.toJson(linkedMapOf("cmd" to "preguntar_ia", "ref" to ref, "args" to linkedMapOf("q" to question)))
    }
}
