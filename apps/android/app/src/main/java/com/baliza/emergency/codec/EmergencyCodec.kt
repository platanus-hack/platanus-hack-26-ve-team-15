package com.baliza.emergency.codec

import com.baliza.emergency.crypto.Ed25519
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * Binary codec and signing for the inner emergency packet (docs/contrato.md §3).
 * All integers are big-endian. Decoding is strict: anything that does not match the contract is
 * rejected, because relays and the backend must agree on exactly the same bytes.
 */
object EmergencyCodec {

    private val DOMAIN = "BALIZA-V1".toByteArray(Charsets.US_ASCII)
    private const val TTL_OFFSET = 2

    /** Packet bytes without the signature. */
    fun encodeUnsigned(packet: EmergencyPacket): ByteArray {
        require(packet.version == EmergencyPacket.VERSION) { "unsupported version ${packet.version}" }
        require(packet.incidentId.size == EmergencyPacket.INCIDENT_ID_BYTES) { "incident_id must be 8 bytes" }
        require(packet.senderId.size == EmergencyPacket.SENDER_ID_BYTES) { "sender_id must be 8 bytes" }
        require(packet.ttl in 0..255) { "ttl out of range" }
        require(packet.seq in 0..0xFFFF) { "seq out of range" }
        require(packet.category in 0..255 && packet.severity in 0..255) { "category/severity out of range" }
        require(packet.accuracyM in 0..0xFFFF && packet.locationAge in 0..0xFFFF) { "accuracy/location_age out of range" }
        require(packet.timestamp in 0..0xFFFF_FFFFL) { "timestamp out of range" }
        val text = packet.publicText.toByteArray(Charsets.UTF_8)
        require(text.size <= EmergencyPacket.MAX_TEXT_BYTES) { "public_text over ${EmergencyPacket.MAX_TEXT_BYTES} B" }
        require(packet.sealedBlob.size <= 0xFFFF) { "sealed_blob too large" }
        val size = EmergencyPacket.HEADER_BYTES + 1 + text.size + 2 + packet.sealedBlob.size
        require(size + EmergencyPacket.SIGNATURE_BYTES <= EmergencyPacket.MAX_PACKET_BYTES) {
            "packet would be ${size + EmergencyPacket.SIGNATURE_BYTES} B, limit ${EmergencyPacket.MAX_PACKET_BYTES} B"
        }
        checkShape(packet.type, text.size, packet.sealedBlob.size)

        return ByteBuffer.allocate(size).order(ByteOrder.BIG_ENDIAN).apply {
            put(packet.version.toByte())
            put(packet.type.id.toByte())
            put(packet.ttl.toByte())
            put(packet.incidentId)
            putShort(packet.seq.toShort())
            put(packet.category.toByte())
            put(packet.severity.toByte())
            putInt(packet.lat)
            putInt(packet.lon)
            putShort(packet.accuracyM.toShort())
            putShort(packet.locationAge.toShort())
            putInt(packet.timestamp.toInt())
            put(packet.senderId)
            put(text.size.toByte())
            put(text)
            putShort(packet.sealedBlob.size.toShort())
            put(packet.sealedBlob)
        }.array()
    }

    /** Full wire bytes. The packet must be signed. */
    fun encode(packet: EmergencyPacket): ByteArray {
        val signature = requireNotNull(packet.signature) { "packet is not signed" }
        require(signature.size == EmergencyPacket.SIGNATURE_BYTES) { "signature must be 64 bytes" }
        return encodeUnsigned(packet) + signature
    }

    /** What is signed: domain tag, then every byte except `ttl` and the signature. */
    fun signingPreimage(unsigned: ByteArray): ByteArray =
        DOMAIN + unsigned.copyOfRange(0, TTL_OFFSET) + unsigned.copyOfRange(TTL_OFFSET + 1, unsigned.size)

    fun sign(packet: EmergencyPacket, signingSeed: ByteArray): EmergencyPacket {
        val signature = Ed25519.sign(signingSeed, signingPreimage(encodeUnsigned(packet)))
        return packet.copy(signature = signature)
    }

    /** True only if the packet carries a signature that `signerPublicKey` made over it. */
    fun verify(packet: EmergencyPacket, signerPublicKey: ByteArray): Boolean {
        val signature = packet.signature ?: return false
        return Ed25519.verify(signerPublicKey, signingPreimage(encodeUnsigned(packet)), signature)
    }

    /** Parses wire bytes. Does not verify the signature: the caller picks the right key for the type. */
    @Throws(EmergencyFormatException::class)
    fun decode(bytes: ByteArray): EmergencyPacket {
        fail(bytes.size < EmergencyPacket.FIXED_BYTES) { "too short: ${bytes.size} B" }
        fail(bytes.size > EmergencyPacket.MAX_PACKET_BYTES) { "too long: ${bytes.size} B" }
        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)

        val version = buf.get().toInt() and 0xFF
        fail(version != EmergencyPacket.VERSION) { "unsupported version $version" }
        val typeId = buf.get().toInt() and 0xFF
        val type = EmergencyType.fromId(typeId) ?: throw EmergencyFormatException("unknown type $typeId")
        val ttl = buf.get().toInt() and 0xFF
        val incidentId = ByteArray(EmergencyPacket.INCIDENT_ID_BYTES).also(buf::get)
        val seq = buf.short.toInt() and 0xFFFF
        val category = buf.get().toInt() and 0xFF
        val severity = buf.get().toInt() and 0xFF
        val lat = buf.int
        val lon = buf.int
        val accuracyM = buf.short.toInt() and 0xFFFF
        val locationAge = buf.short.toInt() and 0xFFFF
        val timestamp = buf.int.toLong() and 0xFFFF_FFFFL
        val senderId = ByteArray(EmergencyPacket.SENDER_ID_BYTES).also(buf::get)

        val textLen = buf.get().toInt() and 0xFF
        fail(textLen > EmergencyPacket.MAX_TEXT_BYTES) { "public_text $textLen B over limit" }
        fail(buf.remaining() < textLen + 2 + EmergencyPacket.SIGNATURE_BYTES) { "truncated after text_len" }
        val textBytes = ByteArray(textLen).also(buf::get)
        val publicText = try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(textBytes)).toString()
        } catch (_: CharacterCodingException) {
            throw EmergencyFormatException("public_text is not valid UTF-8")
        }

        val blobLen = buf.short.toInt() and 0xFFFF
        fail(buf.remaining() != blobLen + EmergencyPacket.SIGNATURE_BYTES) {
            "blob_len $blobLen does not match the ${buf.remaining()} B left"
        }
        val sealedBlob = ByteArray(blobLen).also(buf::get)
        val signature = ByteArray(EmergencyPacket.SIGNATURE_BYTES).also(buf::get)

        try {
            checkShape(type, textLen, blobLen)
        } catch (e: IllegalArgumentException) {
            throw EmergencyFormatException(e.message ?: "bad shape")
        }
        return EmergencyPacket(
            type, ttl, incidentId, seq, category, severity, lat, lon, accuracyM, locationAge,
            timestamp, senderId, publicText, sealedBlob, signature, version
        )
    }

    /** Same as [decode] but returns null instead of throwing. */
    fun decodeOrNull(bytes: ByteArray): EmergencyPacket? =
        try { decode(bytes) } catch (_: EmergencyFormatException) { null }

    /**
     * Per-type rules of docs/contrato.md §2.1: ACK has no blob, and only SOS/UPDATE/ACK may carry
     * public text. Sealed boxes are at least 48 bytes.
     */
    private fun checkShape(type: EmergencyType, textLen: Int, blobLen: Int) {
        when (type) {
            EmergencyType.ACK -> require(blobLen == 0) { "ACK carries no sealed_blob" }
            else -> require(blobLen == 0 || blobLen >= com.baliza.emergency.crypto.SealedBox.OVERHEAD_BYTES) {
                "sealed_blob shorter than a sealed box"
            }
        }
        if (type != EmergencyType.SOS && type != EmergencyType.UPDATE && type != EmergencyType.ACK) {
            require(textLen == 0) { "$type carries no public_text" }
        }
    }

    private inline fun fail(condition: Boolean, message: () -> String) {
        if (condition) throw EmergencyFormatException(message())
    }
}
