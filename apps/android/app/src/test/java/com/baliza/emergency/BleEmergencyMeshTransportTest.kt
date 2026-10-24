package com.baliza.emergency

import com.bitchat.android.mesh.EmergencyPacketSink
import com.bitchat.android.model.RoutedPacket
import com.bitchat.android.protocol.BitchatPacket
import com.bitchat.android.protocol.MessageType
import com.bitchat.android.protocol.SpecialRecipients
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class BleEmergencyMeshTransportTest {

    private var sink: EmergencyPacketSink? = null
    private var neighborListener: (() -> Unit)? = null
    private val sent = mutableListOf<Pair<ByteArray, UByte>>()
    private var accept = true

    private fun transport() = BleEmergencyMeshTransport(
        attachSink = { sink = it },
        attachNeighborListener = { neighborListener = it },
        sendRaw = { payload, ttl -> sent += payload to ttl; accept }
    )

    @Test
    fun `incoming packets reach collectors with ttl and link`() = runBlocking {
        val transport = transport()
        val payload = byteArrayOf(9, 8, 7)
        val received = async(start = CoroutineStart.UNDISPATCHED) {
            withTimeout(2_000) { transport.incoming.first() }
        }
        sink!!.onEmergencyPacket(
            RoutedPacket(
                BitchatPacket(
                    version = 1u,
                    type = MessageType.EMERGENCY.value,
                    senderID = ByteArray(8) { 1 },
                    recipientID = SpecialRecipients.BROADCAST,
                    timestamp = 1UL,
                    payload = payload,
                    ttl = 4u
                ),
                peerID = "0101010101010101",
                relayAddress = "AA:BB"
            )
        )
        val packet = received.await()
        assertArrayEquals(payload, packet.payload)
        assertEquals(4, packet.envelopeTtl)
        assertEquals("0101010101010101", packet.senderPeerId)
        assertEquals("AA:BB", packet.linkAddress)
    }

    @Test
    fun `a slow collector never blocks the mesh`() {
        transport()
        val packet = RoutedPacket(
            BitchatPacket(1u, MessageType.EMERGENCY.value, ByteArray(8), null, 1UL, byteArrayOf(1), null, 3u),
            peerID = "00"
        )
        // No collector at all, far more packets than the buffer: must return immediately every time.
        repeat(1_000) { sink!!.onEmergencyPacket(packet) }
    }

    @Test
    fun `send maps the mesh result`() = runBlocking {
        val transport = transport()
        assertEquals(SendResult.SENT, transport.send(ByteArray(10)))
        accept = false
        assertEquals(SendResult.NO_NEIGHBOR_ACCEPTED, transport.send(ByteArray(10)))
    }

    @Test
    fun `send rejects empty and oversized payloads without touching the mesh`() = runBlocking {
        val transport = transport()
        assertEquals(SendResult.REJECTED_INVALID, transport.send(ByteArray(0)))
        assertEquals(
            SendResult.REJECTED_INVALID,
            transport.send(ByteArray(EmergencyMeshTransport.MAX_PAYLOAD_BYTES + 1))
        )
        assertEquals(SendResult.SENT, transport.send(ByteArray(EmergencyMeshTransport.MAX_PAYLOAD_BYTES)))
        assertEquals(1, sent.size)
    }

    @Test
    fun `ttl is clamped to the envelope range`() = runBlocking {
        val transport = transport()
        transport.send(ByteArray(1), ttl = 0)
        transport.send(ByteArray(1), ttl = 1_000)
        transport.send(ByteArray(1))
        assertEquals(listOf<UByte>(1u, 255u, 7u), sent.map { it.second })
    }

    @Test
    fun `close detaches from the mesh`() {
        val transport = transport()
        assertNotNull(sink)
        assertNotNull(neighborListener)
        transport.close()
        assertNull(sink)
        assertNull(neighborListener)
    }

    @Test
    fun `a new link is announced to collectors`() = runBlocking {
        val transport = transport()
        val heard = async(start = CoroutineStart.UNDISPATCHED) { withTimeout(2_000) { transport.newNeighbors.first() } }
        neighborListener!!.invoke()
        heard.await()
    }

    @Test
    fun `new links never block the mesh when nobody listens`() {
        transport()
        repeat(1_000) { neighborListener!!.invoke() }
    }
}
