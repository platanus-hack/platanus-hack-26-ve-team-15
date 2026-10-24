package com.baliza.emergency.codec

/** Inner packet types, docs/contrato.md §3.3. */
enum class EmergencyType(val id: Int) {
    SOS(1), UPDATE(2), ACK(3), MSG_OUT(4), MSG_IN(5), CMD(6), CMD_RESULT(7);

    /** Types the phone originates; they are signed with the user's key. The rest are the server's. */
    val fromPhone: Boolean get() = this == SOS || this == UPDATE || this == MSG_OUT || this == CMD

    companion object {
        fun fromId(id: Int): EmergencyType? = entries.firstOrNull { it.id == id }
    }
}

/**
 * Inner emergency packet (docs/contrato.md §3.1). Numeric fields hold their unsigned wire value in
 * the next wider type where needed ([timestamp] is a uint32 in seconds).
 *
 * [signature] is null on an unsigned packet; [EmergencyCodec.sign] fills it.
 */
class EmergencyPacket(
    val type: EmergencyType,
    /** Initial hop budget. Not covered by the signature, so relays could rewrite it. */
    val ttl: Int,
    val incidentId: ByteArray,
    val seq: Int,
    val category: Int = 0,
    val severity: Int = 0,
    /** Degrees times 1e5, or [NO_LOCATION]. */
    val lat: Int = NO_LOCATION,
    val lon: Int = NO_LOCATION,
    val accuracyM: Int = 0,
    /** Seconds since the location fix, saturated at 65535. */
    val locationAge: Int = 0,
    /** Unix seconds (uint32). */
    val timestamp: Long,
    val senderId: ByteArray,
    val publicText: String = "",
    val sealedBlob: ByteArray = ByteArray(0),
    val signature: ByteArray? = null,
    val version: Int = VERSION
) {
    val hasLocation: Boolean get() = lat != NO_LOCATION && lon != NO_LOCATION

    fun copy(
        ttl: Int = this.ttl,
        signature: ByteArray? = this.signature,
        sealedBlob: ByteArray = this.sealedBlob,
        publicText: String = this.publicText,
        seq: Int = this.seq
    ) = EmergencyPacket(
        type, ttl, incidentId, seq, category, severity, lat, lon, accuracyM, locationAge,
        timestamp, senderId, publicText, sealedBlob, signature, version
    )

    companion object {
        const val VERSION = 1
        const val NO_LOCATION = Int.MIN_VALUE

        /** Fixed header up to and including `sender_id`. */
        const val HEADER_BYTES = 39
        const val SIGNATURE_BYTES = 64

        /** Header + text_len(1) + blob_len(2) + signature: the size with empty text and blob. */
        const val FIXED_BYTES = HEADER_BYTES + 1 + 2 + SIGNATURE_BYTES

        const val MAX_PACKET_BYTES = 418
        const val MAX_TEXT_BYTES = 60
        const val INCIDENT_ID_BYTES = 8
        const val SENDER_ID_BYTES = 8

        /** Hops taken so far: initial `ttl` of the packet minus what the envelope has left. */
        fun hops(innerTtl: Int, envelopeTtl: Int): Int = (innerTtl - envelopeTtl).coerceAtLeast(0)
    }
}

/** The bytes are not a valid emergency packet. [reason] is for logs, never shown to users. */
class EmergencyFormatException(val reason: String) : Exception(reason)
