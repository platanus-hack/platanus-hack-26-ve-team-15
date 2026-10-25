package com.baliza.emergency.sos

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
import java.nio.ByteBuffer
import java.security.SecureRandom
import kotlin.math.roundToInt

/**
 * Sends one SOS and keeps resending it until the server acknowledges it (docs/contrato.md §5.1).
 *
 * The packet is built, signed and sealed once; every retry sends the very same bytes, so the backend
 * sees one incident (idempotent on `(sender_id, incident_id, seq, type)`). The mesh gives each send a
 * new envelope timestamp, which is what keeps relays from dropping retries as duplicates.
 *
 * Nothing here touches the UI: observe [status] and render it.
 *
 * Runs on [scope]; use a single-threaded scope so state updates and the retry loop do not race.
 * The incident lives in memory only: if the process dies, the retries stop.
 */
class SosSender(
    private val transport: EmergencyMeshTransport,
    private val identity: UserIdentity,
    private val serverKeys: () -> ServerKeys?,
    private val scope: CoroutineScope,
    /** Emits when a new neighbor appears: restarts the retry schedule, even after giving up. */
    private val newNeighbors: Flow<Unit> = transport.newNeighbors,
    private val store: IncidentStore = NoIncidentStore,
    private val nowMillis: () -> Long = System::currentTimeMillis,
    private val random: SecureRandom = SecureRandom(),
    private val schedule: RetrySchedule = RetrySchedule()
) {
    private val _status = MutableStateFlow(SosStatus(SosState.IDLE))
    val status: StateFlow<SosStatus> = _status.asStateFlow()

    private class Incident(val id: ByteArray, val seq: Int, val wire: ByteArray, val startedAt: Long)

    private var incident: Incident? = null
    private var listeners: List<Job> = emptyList()
    private var retryJobs: List<Job> = emptyList()
    private val restart = Channel<Unit>(Channel.CONFLATED)

    fun start(request: SosRequest): StartResult {
        incident?.let { if (_status.value.state != SosState.IDLE) return StartResult.AlreadyActive(hex(it.id)) }
        val server = serverKeys() ?: return StartResult.NotRegistered()
        validate(request)?.let { return StartResult.Invalid(it) }

        val id = ByteArray(EmergencyPacket.INCIDENT_ID_BYTES).also(random::nextBytes)
        val packet = build(request, id, server)
        val wire = try {
            EmergencyCodec.encode(EmergencyCodec.sign(packet, identity.signSeed))
        } catch (e: IllegalArgumentException) {
            return StartResult.Invalid(e.message ?: "packet does not fit")
        }

        val current = Incident(id, packet.seq, wire, nowMillis())
        store.save(IncidentRecord(id, current.seq, wire, ackState = null))
        begin(current, ackState = null)
        return StartResult.Started(hex(id))
    }

    /**
     * Picks up the incident saved by a previous run (call it when the app or its service starts).
     * Unacknowledged incidents resume resending with a fresh retry window; acknowledged ones only
     * listen for further ACKs. A record that does not check out is discarded.
     *
     * @return true if an incident was resumed.
     */
    fun resume(): Boolean {
        if (incident != null) return false
        val record = store.load() ?: return false
        if (!matchesUs(record)) {
            store.clear()
            return false
        }
        begin(Incident(record.incidentId, record.seq, record.wire, nowMillis()), record.ackState)
        return true
    }

    /** The saved packet must be ours: our key, our sender id, the id it was saved under. */
    private fun matchesUs(record: IncidentRecord): Boolean {
        val packet = EmergencyCodec.decodeOrNull(record.wire) ?: return false
        return packet.type == EmergencyType.SOS &&
            packet.seq == record.seq &&
            packet.incidentId.contentEquals(record.incidentId) &&
            packet.senderId.contentEquals(identity.senderId) &&
            EmergencyCodec.verify(packet, identity.signPublicKey)
    }

    private fun begin(current: Incident, ackState: SosState?) {
        incident = current
        _status.value = SosStatus(ackState ?: SosState.UNSENT, hex(current.id), current.seq, attempts = 0)
        listeners = listOf(
            scope.launch { transport.incoming.collect(::onReceived) },
            scope.launch { newNeighbors.collect { restart.trySend(Unit) } }
        )
        retryJobs = if (ackState != null) emptyList() else listOf(
            scope.launch { markUnconfirmedLater(current) },
            scope.launch { retryLoop(current) }
        )
    }

    /**
     * The incident id once the server has acknowledged the SOS: what a later CMD must belong to. Null before
     * the first ACK, after a rejection, or with no incident.
     */
    fun acknowledgedIncidentId(): ByteArray? =
        incident?.takeIf { _status.value.state.let { s -> isAckState(s) && s != SosState.REJECTED } }?.id?.copyOf()

    /** Stops resending. Does not tell the server; closing an incident is a separate UPDATE (R6). */
    fun cancel() {
        (listeners + retryJobs).forEach(Job::cancel)
        listeners = emptyList()
        retryJobs = emptyList()
        incident = null
        store.clear()
        _status.value = SosStatus(SosState.IDLE)
    }

    // --- sending ---

    private fun validate(r: SosRequest): String? {
        if (r.category !in 1..7) return "category must be 1..7"
        if (r.severity !in 1..3) return "severity must be 1..3"
        if (r.publicText.toByteArray(Charsets.UTF_8).size > EmergencyPacket.MAX_TEXT_BYTES) return "public_text over 60 bytes"
        if (r.note.toByteArray(Charsets.UTF_8).size > MAX_NOTE_BYTES) return "note over $MAX_NOTE_BYTES bytes"
        if (r.contactMask == 0) return "pick at least one contact"
        if (r.channels == 0 || r.channels and (Channels.SMS or Channels.EMAIL or Channels.VOICE).inv() != 0) return "invalid channels"
        r.location?.let {
            if (it.latitude !in -90.0..90.0 || it.longitude !in -180.0..180.0) return "location out of range"
            if (it.accuracyM < 0 || it.fixAgeSeconds < 0) return "negative accuracy or age"
        }
        return null
    }

    private fun build(r: SosRequest, id: ByteArray, server: ServerKeys): EmergencyPacket {
        val note = r.note.toByteArray(Charsets.UTF_8)
        val plaintext = ByteBuffer.allocate(4 + 1 + 2 + note.size)
            .putInt(r.contactMask).put(r.channels.toByte()).putShort(0 /* rx_cursor */).put(note).array()
        val loc = r.location
        return EmergencyPacket(
            type = EmergencyType.SOS,
            ttl = EmergencyMeshTransport.DEFAULT_TTL,
            incidentId = id,
            seq = 1,
            category = r.category,
            severity = r.severity,
            lat = loc?.let { (it.latitude * COORD_SCALE).roundToInt() } ?: EmergencyPacket.NO_LOCATION,
            lon = loc?.let { (it.longitude * COORD_SCALE).roundToInt() } ?: EmergencyPacket.NO_LOCATION,
            accuracyM = loc?.accuracyM?.coerceAtMost(0xFFFF) ?: 0,
            locationAge = loc?.fixAgeSeconds?.coerceAtMost(0xFFFF) ?: 0,
            timestamp = nowMillis() / 1000,
            senderId = identity.senderId,
            publicText = r.publicText,
            sealedBlob = SealedBox.seal(plaintext, server.sealPublicKey, random)
        )
    }

    private suspend fun sendOnce(current: Incident) {
        val accepted = try {
            transport.send(current.wire, EmergencyMeshTransport.DEFAULT_TTL) == SendResult.SENT
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            false
        }
        _status.update { s ->
            if (s.seq != current.seq || s.incidentIdHex != hex(current.id)) return@update s
            val next = when {
                !accepted -> s.state
                s.state == SosState.UNSENT ->
                    if (nowMillis() - current.startedAt >= schedule.unconfirmedAfterMs) SosState.UNCONFIRMED else SosState.SENT
                s.state == SosState.STOPPED -> SosState.UNCONFIRMED
                else -> s.state
            }
            SosStatus(next, s.incidentIdHex, s.seq, s.attempts + 1)
        }
    }

    private suspend fun markUnconfirmedLater(current: Incident) {
        delay(schedule.unconfirmedAfterMs)
        _status.update { s -> if (s.state == SosState.SENT) SosStatus(SosState.UNCONFIRMED, s.incidentIdHex, s.seq, s.attempts) else s }
    }

    /** First send now, then every 15 s for 2 min, then every 60 s, giving up after 30 min without an ACK. */
    private suspend fun retryLoop(current: Incident) {
        var windowStart = current.startedAt
        sendOnce(current)
        while (true) {
            val elapsed = nowMillis() - windowStart
            if (elapsed >= schedule.giveUpAfterMs) {
                _status.update { s -> if (isAckState(s.state)) s else SosStatus(SosState.STOPPED, s.incidentIdHex, s.seq, s.attempts) }
                restart.receive() // wait for a neighbor
                delay(schedule.neighborSettleMs)
                windowStart = nowMillis()
                sendOnce(current)
                continue
            }
            val interval = if (elapsed < schedule.fastWindowMs) schedule.fastIntervalMs else schedule.slowIntervalMs
            val neighbor = withTimeoutOrNull(interval) { restart.receive() }
            if (neighbor != null) {
                delay(schedule.neighborSettleMs) // let the new link finish connecting before writing
                windowStart = nowMillis()
            }
            sendOnce(current)
        }
    }

    // --- acknowledgements ---

    private fun onReceived(received: ReceivedEmergencyPacket) {
        val current = incident ?: return
        val ack = EmergencyCodec.decodeOrNull(received.payload) ?: return
        if (ack.type != EmergencyType.ACK) return
        if (!ack.incidentId.contentEquals(current.id)) return
        // Only the SOS's own ACK counts. A CMD of the same incident gets its own (seq 2+), and a refusal of it
        // (ACK code 3) must not mark the SOS as rejected or stop resending an SOS that never arrived.
        if (ack.seq != current.seq) return
        val server = serverKeys() ?: return
        if (!ack.senderId.contentEquals(Ed25519.senderId(server.signPublicKey))) return
        if (!EmergencyCodec.verify(ack, server.signPublicKey)) return
        val reported = when (ack.category) {
            ACK_RECEIVED -> SosState.RECEIVED
            ACK_CONTACTS_NOTIFIED -> SosState.CONTACTS_NOTIFIED
            ACK_IN_PROGRESS -> SosState.IN_PROGRESS
            ACK_REJECTED -> SosState.REJECTED
            else -> return
        }
        _status.update { s ->
            when {
                s.state == SosState.REJECTED -> s
                reported == SosState.REJECTED -> SosStatus(reported, s.incidentIdHex, s.seq, s.attempts)
                rank(reported) > rank(s.state) -> SosStatus(reported, s.incidentIdHex, s.seq, s.attempts)
                isAckState(s.state) -> s // acknowledgements can arrive out of order: never go back
                else -> SosStatus(reported, s.incidentIdHex, s.seq, s.attempts)
            }
        }
        // Acknowledged: no more resending. Keep listening for later ACKs of the same incident.
        store.save(IncidentRecord(current.id, current.seq, current.wire, _status.value.state.takeIf(::isAckState)))
        retryJobs.forEach(Job::cancel)
    }

    private fun isAckState(s: SosState) = rank(s) > 0

    private fun rank(s: SosState) = when (s) {
        SosState.RECEIVED -> 1
        SosState.IN_PROGRESS -> 2
        SosState.CONTACTS_NOTIFIED -> 3
        SosState.REJECTED -> 4
        else -> 0
    }

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    companion object {
        /** 204 B plaintext limit of SOS/UPDATE minus contact_mask(4), channels(1) and rx_cursor(2). */
        const val MAX_NOTE_BYTES = 197
        private const val COORD_SCALE = 100_000.0
        private const val ACK_RECEIVED = 0
        private const val ACK_CONTACTS_NOTIFIED = 1
        private const val ACK_IN_PROGRESS = 2
        private const val ACK_REJECTED = 3
    }
}
