package com.baliza.emergency.codec

import com.baliza.emergency.crypto.Ed25519
import com.baliza.emergency.crypto.SealedBox
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.SecureRandom

class EmergencyCodecTest {

    private val user = Ed25519.keyPairFromSeed(ByteArray(32) { 1 })
    private val server = SealedBox.generateKeyPair()
    private val incident = ByteArray(8) { (it + 1).toByte() }

    private fun sos(text: String = "SOS medico", notePlaintext: Int = 100, ttl: Int = 7) = EmergencyPacket(
        type = EmergencyType.SOS, ttl = ttl, incidentId = incident, seq = 1, category = 1, severity = 3,
        lat = 1049700, lon = -6685300, accuracyM = 12, locationAge = 4, timestamp = 1_798_200_000L,
        senderId = Ed25519.senderId(user.publicKey), publicText = text,
        sealedBlob = SealedBox.seal(ByteArray(notePlaintext).also(SecureRandom()::nextBytes), server.publicKey)
    )

    private fun signed(p: EmergencyPacket = sos()) = EmergencyCodec.sign(p, user.seed)

    @Test
    fun `sign encode decode verify round trip`() {
        val wire = EmergencyCodec.encode(signed())
        val decoded = EmergencyCodec.decode(wire)
        assertEquals(EmergencyType.SOS, decoded.type)
        assertEquals("SOS medico", decoded.publicText)
        assertEquals(1049700, decoded.lat)
        assertEquals(-6685300, decoded.lon)
        assertEquals(1_798_200_000L, decoded.timestamp)
        assertTrue(EmergencyCodec.verify(decoded, user.publicKey))
        assertArrayEquals(wire, EmergencyCodec.encode(decoded))
    }

    @Test
    fun `ttl is outside the signature so relays can rewrite it`() {
        val decoded = EmergencyCodec.decode(EmergencyCodec.encode(signed(sos(ttl = 7))))
        assertTrue(EmergencyCodec.verify(decoded.copy(ttl = 2), user.publicKey))
    }

    @Test
    fun `changing any signed byte breaks verification`() {
        val wire = EmergencyCodec.encode(signed())
        for (index in wire.indices) {
            if (index == 2) continue // ttl
            val bad = wire.copyOf().also { it[index] = (it[index].toInt() xor 1).toByte() }
            val decoded = EmergencyCodec.decodeOrNull(bad) ?: continue // malformed is also a rejection
            assertFalse("flip at byte $index still verifies", EmergencyCodec.verify(decoded, user.publicKey))
        }
    }

    @Test
    fun `another key does not verify`() {
        val other = Ed25519.keyPairFromSeed(ByteArray(32) { 9 })
        assertFalse(EmergencyCodec.verify(signed(), other.publicKey))
    }

    @Test
    fun `worst case sos is exactly 418 bytes`() {
        val worst = sos(text = "x".repeat(60), notePlaintext = 204)
        assertEquals(418, EmergencyCodec.encode(signed(worst)).size)
    }

    @Test
    fun `over the limit is refused at encode`() {
        assertThrows(IllegalArgumentException::class.java) { EmergencyCodec.encode(signed(sos(text = "x".repeat(60), notePlaintext = 205))) }
        assertThrows(IllegalArgumentException::class.java) { EmergencyCodec.encode(signed(sos(text = "x".repeat(61)))) }
    }

    @Test
    fun `multi byte text counts bytes not characters`() {
        // 31 two-byte characters = 62 bytes
        assertThrows(IllegalArgumentException::class.java) { EmergencyCodec.encode(signed(sos(text = "é".repeat(31)))) }
        val ok = EmergencyCodec.decode(EmergencyCodec.encode(signed(sos(text = "é".repeat(30)))))
        assertEquals("é".repeat(30), ok.publicText)
    }

    @Test
    fun `unsigned packet cannot be encoded`() {
        assertThrows(IllegalArgumentException::class.java) { EmergencyCodec.encode(sos()) }
    }

    @Test
    fun `decode rejects malformed input without crashing`() {
        val good = EmergencyCodec.encode(signed())
        assertNull(EmergencyCodec.decodeOrNull(ByteArray(0)))
        assertNull(EmergencyCodec.decodeOrNull(good.copyOf(100)))               // truncated
        assertNull(EmergencyCodec.decodeOrNull(good + byteArrayOf(0)))          // trailing byte
        assertNull(EmergencyCodec.decodeOrNull(good.copyOf().also { it[0] = 2 }))  // version
        assertNull(EmergencyCodec.decodeOrNull(good.copyOf().also { it[1] = 0 }))  // type 0
        assertNull(EmergencyCodec.decodeOrNull(good.copyOf().also { it[1] = 8 }))  // type 8
        assertNull(EmergencyCodec.decodeOrNull(good.copyOf().also { it[EmergencyPacket.HEADER_BYTES] = 61 })) // text_len
        assertNull(EmergencyCodec.decodeOrNull(ByteArray(419)))                  // over the limit
        repeat(2000) {
            val noise = ByteArray(SecureRandom().nextInt(450)).also(SecureRandom()::nextBytes)
            EmergencyCodec.decodeOrNull(noise) // must never throw
        }
    }

    @Test
    fun `invalid utf8 in public text is rejected`() {
        val good = EmergencyCodec.encode(signed(sos(text = "ab")))
        val bad = good.copyOf().also { it[EmergencyPacket.HEADER_BYTES + 1] = 0xFF.toByte() }
        assertNull(EmergencyCodec.decodeOrNull(bad))
    }

    @Test
    fun `shape rules per type`() {
        fun packet(type: EmergencyType, text: String = "", blob: Int = 0) = EmergencyPacket(
            type = type, ttl = 7, incidentId = incident, seq = 1, timestamp = 1L,
            senderId = Ed25519.senderId(user.publicKey), publicText = text,
            sealedBlob = if (blob == 0) ByteArray(0) else SealedBox.seal(ByteArray(blob - 48), server.publicKey)
        )
        // ACK has no blob; MSG types have no public text
        assertThrows(IllegalArgumentException::class.java) { EmergencyCodec.encodeUnsigned(packet(EmergencyType.ACK, blob = 60)) }
        assertThrows(IllegalArgumentException::class.java) { EmergencyCodec.encodeUnsigned(packet(EmergencyType.MSG_OUT, text = "hi", blob = 60)) }
        EmergencyCodec.encodeUnsigned(packet(EmergencyType.ACK, text = "Recibido"))
        EmergencyCodec.encodeUnsigned(packet(EmergencyType.MSG_IN, blob = 60))
    }

    @Test
    fun `hops are initial ttl minus what the envelope has left`() {
        assertEquals(3, EmergencyPacket.hops(innerTtl = 7, envelopeTtl = 4))
        assertEquals(0, EmergencyPacket.hops(innerTtl = 7, envelopeTtl = 7))
        assertEquals(0, EmergencyPacket.hops(innerTtl = 3, envelopeTtl = 9)) // never negative
    }

    @Test
    fun `sender id is derived from the public key`() {
        assertEquals(8, Ed25519.senderId(user.publicKey).size)
        assertArrayEquals(Ed25519.senderId(user.publicKey), signed().senderId)
    }
}
