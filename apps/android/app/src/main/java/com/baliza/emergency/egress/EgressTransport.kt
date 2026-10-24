package com.baliza.emergency.egress

import com.baliza.emergency.EmergencyMeshTransport
import com.baliza.emergency.ReceivedEmergencyPacket
import com.baliza.emergency.SendResult
import com.baliza.emergency.codec.EmergencyCodec
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.launch
import java.security.SecureRandom

/**
 * Wraps the mesh so that a phone with internet also works as an egress, and so that the SOS sender needs no
 * change (docs/contrato.md §4, §5 and §5.1).
 *
 * - [send]: goes to the mesh as before, and the same bytes are offered to the backend directly, because the
 *   origin never hears its own packet back from a neighbour.
 * - [incoming]: what the mesh hears, plus what the server answered for *our own* incidents. Packets heard for
 *   someone else are uploaded; the server's replies for them are put on the mesh.
 */
class EgressTransport(
    private val mesh: EmergencyMeshTransport,
    api: EgressApi,
    outbox: Outbox,
    private val scope: CoroutineScope,
    online: StateFlow<Boolean>,
    ownSenderIdHex: String,
    serverSignKey: () -> ByteArray?,
    nowMillis: () -> Long = System::currentTimeMillis,
    private val replyTtl: Int = EmergencyMeshTransport.DEFAULT_TTL
) : EmergencyMeshTransport {

    // Replays the last few: the SOS sender subscribes asynchronously and the server's answer can win the race.
    // Late or repeated copies are harmless, the sender ignores what is not for its incident and never goes back.
    private val local = MutableSharedFlow<ReceivedEmergencyPacket>(replay = 4, extraBufferCapacity = 32)
    private val ownIncidents = LinkedHashSet<String>()

    override val incoming: Flow<ReceivedEmergencyPacket> = merge(mesh.incoming, local)
    override val newNeighbors: Flow<Unit> = mesh.newNeighbors

    val egressId: String = ByteArray(16).also(SecureRandom()::nextBytes).joinToString("") { "%02x".format(it) }

    private val uploader = EgressUploader(
        api = api, outbox = outbox, scope = scope, online = online, egressId = egressId, nowMillis = nowMillis,
        serverSignKey = serverSignKey,
        isOwnIncident = { synchronized(ownIncidents) { it in ownIncidents } },
        deliver = ::deliver
    )

    private val mailbox = MailboxWatcher(api, scope, ownSenderIdHex, nowMillis, deliver = ::deliver)

    init {
        mailbox.start()
        scope.launch {
            mesh.incoming.collect { heard ->
                val packet = EmergencyCodec.decodeOrNull(heard.payload) ?: return@collect
                if (!packet.type.fromPhone) return@collect
                uploader.offerHeard(heard.payload, heard.envelopeTtl)
                mailbox.noteHeard(MailboxWatcher.senderHex(packet), MailboxWatcher.hex(packet.incidentId))
            }
        }
    }

    override suspend fun send(payload: ByteArray, ttl: Int): SendResult {
        EmergencyCodec.decodeOrNull(payload)?.takeIf { it.type.fromPhone }?.let {
            val incident = MailboxWatcher.hex(it.incidentId)
            synchronized(ownIncidents) { ownIncidents.add(incident) }
            mailbox.trackOwn(incident)
            uploader.offerOwn(payload)
        }
        return mesh.send(payload, ttl)
    }

    /** An incident of ours that was restored after a restart: its server replies must keep arriving. */
    fun trackOwn(incidentIdHex: String) {
        synchronized(ownIncidents) { ownIncidents.add(incidentIdHex) }
        mailbox.trackOwn(incidentIdHex)
    }

    /** The user cancelled: stop asking the server about that incident. */
    fun forgetOwn(incidentIdHex: String) {
        synchronized(ownIncidents) { ownIncidents.remove(incidentIdHex) }
        mailbox.untrackOwn(incidentIdHex)
    }

    /** A packet from the server. Ours goes straight to the SOS sender, anyone else's onto the mesh. */
    private fun deliver(packet: ByteArray, forOwnIncident: Boolean) {
        if (forOwnIncident) {
            local.tryEmit(ReceivedEmergencyPacket(packet, envelopeTtl = replyTtl, senderPeerId = null, linkAddress = null))
        } else {
            scope.launch { mesh.send(packet, replyTtl) }
        }
    }
}
