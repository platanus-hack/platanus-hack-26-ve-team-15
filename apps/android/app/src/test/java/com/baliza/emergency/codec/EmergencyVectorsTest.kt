package com.baliza.emergency.codec

import com.baliza.emergency.crypto.Ed25519
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

/**
 * Conformance with docs/examples/examples.json, the same bytes the backend must decode.
 * Regenerate with `node docs/examples/generate-examples.mjs > docs/examples/examples.json`.
 */
@RunWith(RobolectricTestRunner::class)
class EmergencyVectorsTest {

    private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(2 * it, 2 * it + 2).toInt(16).toByte() }

    // Working dir is apps/android/app; in Docker /docs is the mounted repo docs/ folder.
    private val vectors = JSONObject(File("../../../docs/examples/examples.json").readText())
    private val userKey = hex(vectors.getJSONObject("keys").getJSONObject("user").getString("sign_pk_hex"))
    private val serverKey = hex(vectors.getJSONObject("keys").getJSONObject("server").getString("sign_pk_hex"))
    private val packets = vectors.getJSONObject("packets")

    private fun forEachPacket(block: (name: String, wire: ByteArray, type: EmergencyType) -> Unit) {
        assertEquals(7, packets.length())
        for (name in packets.keys()) {
            val p = packets.getJSONObject(name)
            block(name, hex(p.getString("hex")), EmergencyType.fromId(p.getInt("msg_type"))!!)
        }
    }

    @Test
    fun `sender ids match the keys`() {
        val keys = vectors.getJSONObject("keys")
        assertArrayEquals(hex(keys.getJSONObject("user").getString("sender_id")), Ed25519.senderId(userKey))
        assertArrayEquals(hex(keys.getJSONObject("server").getString("sender_id")), Ed25519.senderId(serverKey))
    }

    @Test
    fun `every vector decodes, verifies with the right key and re-encodes identically`() = forEachPacket { name, wire, type ->
        val packet = EmergencyCodec.decode(wire)
        assertEquals(name, type, packet.type)
        val key = if (type.fromPhone) userKey else serverKey
        assertTrue("$name signature", EmergencyCodec.verify(packet, key))
        assertArrayEquals("$name sender", Ed25519.senderId(key), packet.senderId)
        assertArrayEquals("$name re-encode", wire, EmergencyCodec.encode(packet))
    }

    @Test
    fun `a vector does not verify with the other side's key`() = forEachPacket { name, wire, type ->
        val wrong = if (type.fromPhone) serverKey else userKey
        assertFalse(name, EmergencyCodec.verify(EmergencyCodec.decode(wire), wrong))
    }

    @Test
    fun `decoded fields of the SOS match the contract example`() {
        val sos = EmergencyCodec.decode(hex(packets.getJSONObject("SOS").getString("hex")))
        assertEquals(EmergencyType.SOS, sos.type)
        assertEquals(7, sos.ttl)
        assertArrayEquals(hex(vectors.getString("incident_id")), sos.incidentId)
        assertEquals(1, sos.seq)
        assertEquals(1, sos.category)
        assertEquals(3, sos.severity)
        assertEquals(1049700, sos.lat)
        assertEquals(-6685300, sos.lon)
        assertEquals(12, sos.accuracyM)
        assertEquals(4, sos.locationAge)
        assertEquals(1_798_200_000L, sos.timestamp)
        assertEquals("SOS medico, necesito ayuda", sos.publicText)
    }

    @Test
    fun `ACK vector has no location and no blob`() {
        val ack = EmergencyCodec.decode(hex(packets.getJSONObject("ACK").getString("hex")))
        assertFalse(ack.hasLocation)
        assertEquals(0, ack.sealedBlob.size)
        assertEquals("Recibido. 2 contactos avisados", ack.publicText)
    }

    @Test
    fun `worst case from the generator matches the budget`() {
        assertEquals(418, vectors.getJSONObject("worst_case_sos").getInt("bytes"))
        assertEquals(EmergencyPacket.MAX_PACKET_BYTES, vectors.getJSONObject("worst_case_sos").getInt("bytes"))
    }
}
