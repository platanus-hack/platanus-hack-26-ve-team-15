package com.bitchat.android.mesh

import com.baliza.emergency.EmergencyMeshTransport
import com.bitchat.android.model.RoutedPacket
import com.bitchat.android.protocol.BinaryProtocol
import com.bitchat.android.protocol.BitchatPacket
import com.bitchat.android.protocol.MessageType
import com.bitchat.android.protocol.SpecialRecipients
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.kotlin.any
import org.mockito.kotlin.doAnswer
import org.mockito.kotlin.doReturn
import org.mockito.kotlin.mock
import org.mockito.kotlin.timeout
import org.mockito.kotlin.verify
import org.robolectric.RobolectricTestRunner
import java.util.Random
import java.util.concurrent.atomic.AtomicInteger

/**
 * Locks the facts docs/contrato.md relies on: EMERGENCY (0x30) is a known type, an inner packet of
 * up to 418 B stays in one frame, and every node relays it whether or not a sink is attached.
 */
@RunWith(RobolectricTestRunner::class)
class EmergencyPacketTest {

    private val sender = byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8)
    private val peerId = "0102030405060708"

    private fun emergencyPacket(payload: ByteArray, ttl: UByte = 7u) = BitchatPacket(
        version = 1u,
        type = MessageType.EMERGENCY.value,
        senderID = sender,
        recipientID = SpecialRecipients.BROADCAST,
        timestamp = 1_798_200_000_000UL,
        payload = payload,
        signature = ByteArray(64).also { Random(7).nextBytes(it) }, // envelope signature, always present
        ttl = ttl
    )

    private fun randomBytes(n: Int) = ByteArray(n).also { Random(42).nextBytes(it) }

    /** Shaped like a worst-case SOS: 39 B header, 60 B text, 252 B sealed blob (random), 64 B signature. */
    private fun realisticWorstCase(): ByteArray {
        val random = Random(1)
        val header = ByteArray(39) { (it % 7).toByte() }
        val text = ByteArray(60) { ('a'.code + it % 26).toByte() }
        val blob = ByteArray(252).also { random.nextBytes(it) }
        val signature = ByteArray(64).also { random.nextBytes(it) }
        return header + byteArrayOf(60) + text + byteArrayOf(0, 252.toByte()) + blob + signature
    }

    // --- budget (contrato.md §2.1) ---

    @Test
    fun `contract limit and service constant agree`() {
        assertEquals(418, EmergencyMeshTransport.MAX_PAYLOAD_BYTES)
        assertEquals(
            EmergencyMeshTransport.MAX_PAYLOAD_BYTES,
            BluetoothMeshService.EMERGENCY_MAX_PAYLOAD_BYTES
        )
    }

    @Test
    fun `418 B payload fits one frame whether it compresses or not`() {
        val payloads = mapOf(
            "random (no compression)" to randomBytes(418),
            "filler (compresses, adds size field)" to ByteArray(418) { 0xA5.toByte() },
            "realistic worst-case SOS" to realisticWorstCase()
        )
        for ((name, payload) in payloads) {
            assertEquals(name, 418, payload.size)
            val frames = FragmentManager().createFragments(emergencyPacket(payload))
            assertEquals("$name must not fragment", 1, frames.size)
            assertEquals(MessageType.EMERGENCY.value, frames[0].type)
        }
    }

    @Test
    fun `one byte over the limit does fragment, so the boundary is real`() {
        val frames = FragmentManager().createFragments(emergencyPacket(randomBytes(419)))
        assertTrue("419 B random payload should need fragments", frames.size > 1)
    }

    // --- wire format ---

    @Test
    fun `EMERGENCY packet survives encode and decode`() {
        val original = emergencyPacket(realisticWorstCase())
        val encoded = BinaryProtocol.encode(original, padding = false)
        assertNotNull(encoded)
        assertTrue("single frame", encoded!!.size <= 512)

        val decoded = BinaryProtocol.decode(encoded)
        assertNotNull(decoded)
        assertEquals(MessageType.EMERGENCY.value, decoded!!.type)
        assertArrayEquals(original.payload, decoded.payload)
        assertArrayEquals(SpecialRecipients.BROADCAST, decoded.recipientID)
        assertEquals(7u.toUByte(), decoded.ttl)
    }

    // --- processor hook ---

    private fun processor(
        sink: EmergencyPacketSink?,
        relayed: AtomicInteger
    ): Pair<PacketProcessor, PacketProcessorDelegate> {
        val delegate = mock<PacketProcessorDelegate> {
            on { validatePacketSecurity(any(), any()) } doReturn true
            on { getNetworkSize() } doReturn 2
            on { getBroadcastRecipient() } doReturn SpecialRecipients.BROADCAST
            on { relayPacket(any()) } doAnswer { relayed.incrementAndGet(); Unit }
        }
        val processor = PacketProcessor("a1a2a3a4a5a6a7a8", Dispatchers.Unconfined)
        processor.delegate = delegate
        processor.emergencySink = sink
        return processor to delegate
    }

    private fun routed(packet: BitchatPacket) =
        RoutedPacket(packet, peerID = peerId, relayAddress = "AA:BB:CC:DD:EE:FF")

    private fun awaitRelay(relayed: AtomicInteger, expected: Int) {
        val deadline = System.currentTimeMillis() + 3_000
        while (relayed.get() < expected && System.currentTimeMillis() < deadline) Thread.sleep(20)
    }

    @Test
    fun `sink receives the packet and it is still relayed with ttl decremented`() {
        val seen = mutableListOf<RoutedPacket>()
        val relayed = AtomicInteger()
        val (processor, delegate) = processor({ seen += it }, relayed)

        processor.processPacket(routed(emergencyPacket(randomBytes(100), ttl = 5u)))
        awaitRelay(relayed, 1)

        assertEquals(1, seen.size)
        assertEquals(5u.toUByte(), seen[0].packet.ttl)
        verify(delegate, timeout(3_000)).relayPacket(any())
        assertEquals(1, relayed.get())
        processor.shutdown()
    }

    @Test
    fun `relay still happens when no sink is attached`() {
        val relayed = AtomicInteger()
        val (processor, _) = processor(null, relayed)
        processor.processPacket(routed(emergencyPacket(randomBytes(100))))
        awaitRelay(relayed, 1)
        assertEquals(1, relayed.get())
        processor.shutdown()
    }

    @Test
    fun `a failing sink does not stop the relay`() {
        val relayed = AtomicInteger()
        val (processor, _) = processor({ error("boom") }, relayed)
        processor.processPacket(routed(emergencyPacket(randomBytes(100))))
        awaitRelay(relayed, 1)
        assertEquals(1, relayed.get())
        processor.shutdown()
    }
}
