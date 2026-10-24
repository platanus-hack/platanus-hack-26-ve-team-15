package com.baliza.emergency.egress

import com.baliza.emergency.codec.EmergencyCodec
import com.baliza.emergency.codec.EmergencyType
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.security.MessageDigest

/**
 * Takes packets to the backend (`POST /v1/egress`, docs/contrato.md §4) and brings the ACK back.
 *
 * Two kinds of packet arrive here:
 *  - **heard** ones, relayed by the mesh from someone else: if the upload cannot be done they wait in the
 *    [Outbox] until there is internet (R3), because this phone may be the only way out;
 *  - **own** ones, from this phone's SosSender: never queued, since its retry schedule already is the queue.
 *
 * The server's answer is handed to [deliver] together with whether it belongs to one of our own incidents
 * (an origin never hears itself on the mesh, so its ACK must be given to it directly).
 */
class EgressUploader(
    private val api: EgressApi,
    private val outbox: Outbox,
    private val scope: CoroutineScope,
    private val online: StateFlow<Boolean>,
    private val egressId: String,
    private val nowMillis: () -> Long,
    /** The pinned server key, to refuse an ACK that the server did not sign. Null before registering. */
    private val serverSignKey: () -> ByteArray?,
    private val isOwnIncident: (incidentIdHex: String) -> Boolean,
    private val deliver: (packet: ByteArray, forOwnIncident: Boolean) -> Unit,
    private val dedupeWindowMs: Long = 10_000,
    private val firstBackoffMs: Long = 30_000,
    private val maxBackoffMs: Long = 300_000
) {
    private class Offer(val wire: ByteArray, val envelopeTtl: Int)

    private val queue = Channel<Offer>(capacity = 64, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    private val outboxSignal = Channel<Unit>(Channel.CONFLATED)
    private val uploading = Mutex()
    private val recent = LinkedHashMap<String, Long>()

    init {
        scope.launch { for (offer in queue) handle(offer) }
        scope.launch { flushLoop() }
        if (!outbox.isEmpty()) outboxSignal.trySend(Unit) // left over from a previous run
    }

    /** A packet from the mesh. Only phone-originated types are worth uploading. */
    fun offerHeard(wire: ByteArray, envelopeTtl: Int) {
        val type = EmergencyCodec.decodeOrNull(wire)?.type ?: return
        if (type.fromPhone) queue.trySend(Offer(wire, envelopeTtl))
    }

    /** This phone's own packet: hops are 0, so the envelope TTL is the packet's own TTL. */
    fun offerOwn(wire: ByteArray) {
        val packet = EmergencyCodec.decodeOrNull(wire) ?: return
        if (packet.type.fromPhone) queue.trySend(Offer(wire, packet.ttl))
    }

    private suspend fun handle(offer: Offer) {
        if (seenRecently(offer.wire)) return
        val ownIncident = isOwn(offer.wire)
        when (val result = upload(offer.wire, offer.envelopeTtl)) {
            is UploadResult.Accepted -> result.ackPacket?.let(::accept)
            is UploadResult.Retry -> if (!ownIncident) {
                if (outbox.add(OutboxEntry(offer.wire, offer.envelopeTtl, nowMillis() / 1000, nowMillis()))) {
                    outboxSignal.trySend(Unit)
                }
            }
            is UploadResult.Discard -> Unit
        }
    }

    /** Relays hand us the same retry several times; one upload per window is enough and keeps the rate limit. */
    private fun seenRecently(wire: ByteArray): Boolean {
        val now = nowMillis()
        recent.entries.removeAll { now - it.value > dedupeWindowMs }
        val key = MessageDigest.getInstance("SHA-256").digest(wire).joinToString("") { "%02x".format(it) }
        if (recent.containsKey(key)) return true
        recent[key] = now
        return false
    }

    private suspend fun upload(wire: ByteArray, envelopeTtl: Int): UploadResult = uploading.withLock {
        try {
            api.upload(wire, egressId, envelopeTtl, nowMillis() / 1000)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            UploadResult.Retry(e.javaClass.simpleName)
        }
    }

    private fun accept(ack: ByteArray) {
        val packet = EmergencyCodec.decodeOrNull(ack) ?: return
        if (packet.type != EmergencyType.ACK) return
        serverSignKey()?.let { if (!EmergencyCodec.verify(packet, it)) return }
        deliver(ack, isOwnIncident(packet.incidentId.joinToString("") { "%02x".format(it) }))
    }

    private fun isOwn(wire: ByteArray): Boolean =
        EmergencyCodec.decodeOrNull(wire)?.let { isOwnIncident(it.incidentId.joinToString("") { b -> "%02x".format(b) }) } ?: false

    /** Empties the outbox oldest first whenever there is internet, backing off 30 s .. 5 min while it fails. */
    private suspend fun flushLoop() {
        var backoff = firstBackoffMs
        while (true) {
            val entry = outbox.peek()
            if (entry == null) {
                outboxSignal.receive()
                continue
            }
            online.first { it }
            when (val result = upload(entry.wire, entry.envelopeTtl)) {
                is UploadResult.Accepted -> {
                    outbox.remove(entry)
                    result.ackPacket?.let(::accept)
                    backoff = firstBackoffMs
                }
                is UploadResult.Discard -> {
                    outbox.remove(entry)
                    backoff = firstBackoffMs
                }
                is UploadResult.Retry -> {
                    delay(backoff)
                    backoff = (backoff * 2).coerceAtMost(maxBackoffMs)
                }
            }
        }
    }
}
