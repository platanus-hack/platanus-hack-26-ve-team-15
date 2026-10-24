package com.baliza.emergency

import kotlinx.coroutines.flow.SharedFlow

/**
 * Emergency-facing view of the mesh. The rest of Baliza Vital (SOS, egress, retries) talks to this
 * interface only, so it stays independent of bitchat's UI and of any specific transport.
 *
 * Payloads are the opaque inner packets defined in docs/contrato.md §3; this layer neither parses
 * nor signs them.
 */
interface EmergencyMeshTransport {

    /**
     * Every emergency packet this node hears, including ones it only relays. Hot flow: collectors
     * that fall behind lose the oldest packets, never block the mesh.
     */
    val incoming: SharedFlow<ReceivedEmergencyPacket>

    /** Broadcasts [payload] (at most [MAX_PAYLOAD_BYTES]) with an initial envelope TTL of [ttl]. */
    suspend fun send(payload: ByteArray, ttl: Int = DEFAULT_TTL): SendResult

    companion object {
        /** 512 B frame - 14 header - 8 sender - 8 recipient - 64 signature (contrato.md §2.1). */
        const val MAX_PAYLOAD_BYTES = 418
        const val DEFAULT_TTL = 7
    }
}

/** A packet heard from the mesh. [envelopeTtl] is what is left after the hops it already took. */
class ReceivedEmergencyPacket(
    val payload: ByteArray,
    val envelopeTtl: Int,
    /** Original sender in bitchat's namespace (not our app identity). */
    val senderPeerId: String?,
    /** Address of the link it arrived on, i.e. the immediate neighbor. */
    val linkAddress: String?
)

enum class SendResult {
    /** At least one neighbor accepted the write. This is "enviado", not "recibido" (R4). */
    SENT,

    /** No neighbor took the packet; retry later (R1). */
    NO_NEIGHBOR_ACCEPTED,

    /** Empty payload, or larger than [EmergencyMeshTransport.MAX_PAYLOAD_BYTES]. */
    REJECTED_INVALID
}
