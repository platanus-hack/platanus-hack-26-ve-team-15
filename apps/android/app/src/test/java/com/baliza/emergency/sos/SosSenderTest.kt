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
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SosSenderTest {

    private val userSign = Ed25519.keyPairFromSeed(ByteArray(32) { 1 })
    private val userSeal = SealedBox.generateKeyPair()
    private val identity = UserIdentity(userSign.seed, userSign.publicKey, userSeal.privateKey, userSeal.publicKey)
    private val serverSign = Ed25519.keyPairFromSeed(ByteArray(32) { 5 })
    private val serverSeal = SealedBox.generateKeyPair()
    private val server = ServerKeys("k1", serverSign.publicKey, serverSeal.publicKey)
    private val epochMs = 1_798_200_000_000L

    private class FakeTransport(private val clock: () -> Long) : EmergencyMeshTransport {
        val sent = mutableListOf<ByteArray>()
        val sentAt = mutableListOf<Long>()
        var result = SendResult.SENT
        private val flow = MutableSharedFlow<ReceivedEmergencyPacket>(extraBufferCapacity = 16)
        override val incoming = flow
        override val newNeighbors = kotlinx.coroutines.flow.emptyFlow<Unit>()
        override suspend fun send(payload: ByteArray, ttl: Int): SendResult {
            sent += payload.copyOf(); sentAt += clock()
            return result
        }
        fun hear(payload: ByteArray) = flow.tryEmit(ReceivedEmergencyPacket(payload, 5, "00", "AA"))
    }

    private val request = SosRequest(
        category = 1, severity = 3, publicText = "SOS medico, necesito ayuda",
        location = SosLocation(10.497, -66.853, accuracyM = 12, fixAgeSeconds = 4),
        note = "Persona inconsciente en la plaza", contactMask = 0b11, channels = Channels.SMS or Channels.EMAIL
    )

    private class Rig(val sender: SosSender, val transport: FakeTransport, val neighbors: MutableSharedFlow<Unit>)

    private fun TestScope.rig(
        keys: ServerKeys? = server,
        schedule: RetrySchedule = RetrySchedule()
    ): Rig {
        val clock = { epochMs + currentTime }
        val transport = FakeTransport(clock)
        val neighbors = MutableSharedFlow<Unit>(extraBufferCapacity = 4)
        val sender = SosSender(transport, identity, { keys }, backgroundScope, neighbors, nowMillis = clock, schedule = schedule)
        return Rig(sender, transport, neighbors)
    }

    private fun ack(incidentHex: String, code: Int, seq: Int = 1, signer: Ed25519.KeyPair = serverSign, incidentOverride: ByteArray? = null): ByteArray {
        val packet = EmergencyPacket(
            type = EmergencyType.ACK, ttl = 7,
            incidentId = incidentOverride ?: incidentHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray(),
            seq = seq, category = code, timestamp = 1_798_200_040L,
            senderId = Ed25519.senderId(signer.publicKey), publicText = "Recibido"
        )
        return EmergencyCodec.encode(EmergencyCodec.sign(packet, signer.seed))
    }

    // --- the packet itself ---

    @Test
    fun `builds a valid signed SOS with the sealed plaintext of the contract`() = runTest {
        val r = rig()
        val started = r.sender.start(request) as StartResult.Started
        runCurrent()

        val wire = r.transport.sent.first()
        assertTrue(wire.size <= EmergencyMeshTransport.MAX_PAYLOAD_BYTES)
        val packet = EmergencyCodec.decode(wire)
        assertEquals(EmergencyType.SOS, packet.type)
        assertTrue(EmergencyCodec.verify(packet, userSign.publicKey))
        assertArrayEquals(identity.senderId, packet.senderId)
        assertEquals(started.incidentIdHex, packet.incidentId.joinToString("") { "%02x".format(it) })
        assertEquals(1, packet.seq)
        assertEquals(1, packet.category)
        assertEquals(3, packet.severity)
        assertEquals(1049700, packet.lat)
        assertEquals(-6685300, packet.lon)
        assertEquals(12, packet.accuracyM)
        assertEquals(4, packet.locationAge)
        assertEquals(epochMs / 1000, packet.timestamp)
        assertEquals("SOS medico, necesito ayuda", packet.publicText)

        val plain = SealedBox.open(packet.sealedBlob, server.sealPublicKey, serverSeal.privateKey)!!
        assertEquals(0b11, java.nio.ByteBuffer.wrap(plain, 0, 4).int)
        assertEquals((Channels.SMS or Channels.EMAIL), plain[4].toInt())
        assertEquals(0, java.nio.ByteBuffer.wrap(plain, 5, 2).short.toInt()) // rx_cursor
        assertEquals("Persona inconsciente en la plaza", String(plain, 7, plain.size - 7, Charsets.UTF_8))
    }

    @Test
    fun `no location is sent as the no-location marker`() = runTest {
        val r = rig()
        r.sender.start(SosRequest(2, 2, "Incendio", null, contactMask = 1, channels = Channels.SMS))
        runCurrent()
        val packet = EmergencyCodec.decode(r.transport.sent.first())
        assertEquals(EmergencyPacket.NO_LOCATION, packet.lat)
        assertEquals(EmergencyPacket.NO_LOCATION, packet.lon)
    }

    @Test
    fun `worst case input still fits one frame`() = runTest {
        val r = rig()
        val worst = SosRequest(7, 3, "x".repeat(60), SosLocation(-90.0, 180.0, 65535, 65535),
            note = "n".repeat(SosSender.MAX_NOTE_BYTES), contactMask = -1, channels = 7)
        assertTrue(r.sender.start(worst) is StartResult.Started)
        runCurrent()
        assertEquals(418, r.transport.sent.first().size)
    }

    @Test
    fun `refuses what cannot be sent`() = runTest {
        val r = rig()
        val bad = listOf(
            SosRequest(0, 3, "a", null, contactMask = 1, channels = 1),
            SosRequest(1, 0, "a", null, contactMask = 1, channels = 1),
            SosRequest(1, 4, "a", null, contactMask = 1, channels = 1),
            SosRequest(1, 3, "x".repeat(61), null, contactMask = 1, channels = 1),
            SosRequest(1, 3, "a", null, note = "n".repeat(198), contactMask = 1, channels = 1),
            SosRequest(1, 3, "a", null, contactMask = 0, channels = 1),
            SosRequest(1, 3, "a", null, contactMask = 1, channels = 0),
            SosRequest(1, 3, "a", null, contactMask = 1, channels = 8),
            SosRequest(1, 3, "a", SosLocation(91.0, 0.0, 1), contactMask = 1, channels = 1),
            SosRequest(1, 3, "a", SosLocation(0.0, 181.0, 1), contactMask = 1, channels = 1)
        )
        for (b in bad) assertTrue(r.sender.start(b) is StartResult.Invalid)
        runCurrent()
        assertTrue(r.transport.sent.isEmpty())
        assertEquals(SosState.IDLE, r.sender.status.value.state)
    }

    @Test
    fun `without server keys nothing is sent`() = runTest {
        val r = rig(keys = null)
        assertTrue(r.sender.start(request) is StartResult.NotRegistered)
        runCurrent()
        assertTrue(r.transport.sent.isEmpty())
    }

    @Test
    fun `a second incident is refused until the first is cancelled`() = runTest {
        val r = rig()
        val first = r.sender.start(request) as StartResult.Started
        assertTrue((r.sender.start(request) as StartResult.AlreadyActive).incidentIdHex == first.incidentIdHex)
        r.sender.cancel()
        assertTrue(r.sender.start(request) is StartResult.Started)
    }

    // --- retries (R1) ---

    @Test
    fun `retries every 15 s for 2 minutes, then every minute, always the same bytes`() = runTest {
        val r = rig()
        r.sender.start(request)
        advanceTimeBy(5 * 60_000); runCurrent()

        val seconds = r.transport.sentAt.map { (it - epochMs) / 1000 }
        assertEquals(listOf<Long>(0, 15, 30, 45, 60, 75, 90, 105, 120, 180, 240, 300), seconds)
        r.transport.sent.forEach { assertArrayEquals(r.transport.sent.first(), it) }
    }

    @Test
    fun `gives up after 30 minutes and a new neighbor resumes at once`() = runTest {
        val r = rig()
        r.sender.start(request)
        advanceTimeBy(31 * 60_000); runCurrent()
        assertEquals(SosState.STOPPED, r.sender.status.value.state)
        val sentWhenStopped = r.transport.sent.size
        assertEquals((30 * 60).toLong(), (r.transport.sentAt.last() - epochMs) / 1000)

        advanceTimeBy(10 * 60_000); runCurrent()
        assertEquals("nothing is sent while stopped", sentWhenStopped, r.transport.sent.size)

        r.neighbors.tryEmit(Unit); runCurrent()
        advanceTimeBy(1_000); runCurrent() // settle time of the new link
        assertEquals(sentWhenStopped + 1, r.transport.sent.size)
        assertEquals(SosState.UNCONFIRMED, r.sender.status.value.state)

        advanceTimeBy(14_000); runCurrent()
        assertEquals("the schedule restarted from the fast interval", sentWhenStopped + 1, r.transport.sent.size)
        advanceTimeBy(1_000); runCurrent()
        assertEquals(sentWhenStopped + 2, r.transport.sent.size)
    }

    @Test
    fun `a new neighbor mid-schedule sends after the settle time and restarts the window`() = runTest {
        val r = rig()
        r.sender.start(request)
        advanceTimeBy(7_000); runCurrent()
        assertEquals(1, r.transport.sent.size)
        r.neighbors.tryEmit(Unit); runCurrent()
        advanceTimeBy(1_000); runCurrent() // settle time of the new link
        assertEquals(2, r.transport.sent.size)
        advanceTimeBy(14_000); runCurrent()
        assertEquals(2, r.transport.sent.size)
        advanceTimeBy(1_000); runCurrent()
        assertEquals(3, r.transport.sent.size)
    }

    @Test
    fun `cancel stops the retries`() = runTest {
        val r = rig()
        r.sender.start(request)
        advanceTimeBy(20_000); runCurrent()
        val n = r.transport.sent.size
        r.sender.cancel()
        advanceTimeBy(10 * 60_000); runCurrent()
        assertEquals(n, r.transport.sent.size)
        assertEquals(SosState.IDLE, r.sender.status.value.state)
    }

    // --- states (R4) ---

    @Test
    fun `states go unsent, sent, unconfirmed`() = runTest {
        val r = rig()
        r.transport.result = SendResult.NO_NEIGHBOR_ACCEPTED
        r.sender.start(request); runCurrent()
        assertEquals(SosState.UNSENT, r.sender.status.value.state)

        r.transport.result = SendResult.SENT
        advanceTimeBy(15_000); runCurrent()
        assertEquals(SosState.SENT, r.sender.status.value.state)

        advanceTimeBy(15_000); runCurrent()
        assertEquals(SosState.UNCONFIRMED, r.sender.status.value.state)
    }

    @Test
    fun `accepted for the first time after 30 s goes straight to unconfirmed`() = runTest {
        val r = rig()
        r.transport.result = SendResult.NO_NEIGHBOR_ACCEPTED
        r.sender.start(request)
        advanceTimeBy(40_000); runCurrent()
        r.transport.result = SendResult.SENT
        advanceTimeBy(15_000); runCurrent()
        assertEquals(SosState.UNCONFIRMED, r.sender.status.value.state)
    }

    @Test
    fun `attempts are counted`() = runTest {
        val r = rig()
        r.sender.start(request)
        advanceTimeBy(31_000); runCurrent()
        assertEquals(3, r.sender.status.value.attempts)
    }

    // --- acknowledgements ---

    private fun started(r: Rig): String = (r.sender.start(request) as StartResult.Started).incidentIdHex

    @Test
    fun `a valid ack stops the retries and shows received`() = runTest {
        val r = rig()
        val id = started(r); runCurrent()
        r.transport.hear(ack(id, code = 0)); runCurrent()
        assertEquals(SosState.RECEIVED, r.sender.status.value.state)
        val n = r.transport.sent.size
        advanceTimeBy(10 * 60_000); runCurrent()
        assertEquals(n, r.transport.sent.size)
    }

    @Test
    fun `ack codes map to states and never go backwards`() = runTest {
        val r = rig()
        val id = started(r); runCurrent()
        r.transport.hear(ack(id, 2)); runCurrent()
        assertEquals(SosState.IN_PROGRESS, r.sender.status.value.state)
        r.transport.hear(ack(id, 0)); runCurrent() // late and out of order
        assertEquals(SosState.IN_PROGRESS, r.sender.status.value.state)
        r.transport.hear(ack(id, 1)); runCurrent()
        assertEquals(SosState.CONTACTS_NOTIFIED, r.sender.status.value.state)
        r.transport.hear(ack(id, 2)); runCurrent()
        assertEquals(SosState.CONTACTS_NOTIFIED, r.sender.status.value.state)
    }

    @Test
    fun `rejected is final and stops the retries`() = runTest {
        val r = rig()
        val id = started(r); runCurrent()
        r.transport.hear(ack(id, 3)); runCurrent()
        assertEquals(SosState.REJECTED, r.sender.status.value.state)
        r.transport.hear(ack(id, 1)); runCurrent()
        assertEquals(SosState.REJECTED, r.sender.status.value.state)
    }

    @Test
    fun `acks that are not for us or not from the server are ignored`() = runTest {
        val r = rig()
        val id = started(r); runCurrent()
        val impostor = Ed25519.keyPairFromSeed(ByteArray(32) { 9 })
        val ignored = listOf(
            ack(id, 0, signer = impostor),                                   // signed by someone else
            ack(id, 0, incidentOverride = ByteArray(8) { 7 }),               // another incident
            ack(id, 0, seq = 0),                                             // acknowledges nothing we sent
            ByteArray(0), ByteArray(100) { 3 },                              // garbage
            EmergencyCodec.encode(EmergencyCodec.sign(                       // a server MSG_IN is not an ACK
                EmergencyPacket(EmergencyType.MSG_IN, 7, id.chunked(2).map { it.toInt(16).toByte() }.toByteArray(), 1,
                    timestamp = 1L, senderId = Ed25519.senderId(serverSign.publicKey),
                    sealedBlob = SealedBox.seal(ByteArray(4), userSeal.publicKey)), serverSign.seed))
        )
        for (bytes in ignored) { r.transport.hear(bytes); runCurrent() }
        assertTrue(r.sender.status.value.state in setOf(SosState.SENT, SosState.UNSENT))
        advanceTimeBy(15_000); runCurrent()
        assertTrue("retries continue", r.transport.sent.size >= 2)
    }

    @Test
    fun `the ack of a later packet of the incident does not touch the SOS`() = runTest {
        val r = rig()
        val id = started(r); runCurrent()
        // A refused CMD (seq 2) comes back as code 3 or 0: the SOS never arrived, so it must keep resending.
        r.transport.hear(ack(id, code = 3, seq = 2)); runCurrent()
        r.transport.hear(ack(id, code = 0, seq = 2)); runCurrent()
        r.transport.hear(ack(id, code = 2, seq = 7)); runCurrent()
        assertTrue(r.sender.status.value.state in setOf(SosState.SENT, SosState.UNSENT))
        val before = r.transport.sent.size
        advanceTimeBy(15_000); runCurrent()
        assertTrue("still resending", r.transport.sent.size > before)
        r.transport.hear(ack(id, code = 0, seq = 1)); runCurrent()
        assertEquals(SosState.RECEIVED, r.sender.status.value.state)
    }

    @Test
    fun `the incident id is offered for a CMD only once the server acknowledged the SOS`() = runTest {
        val r = rig()
        assertEquals(null, r.sender.acknowledgedIncidentId())
        val id = started(r); runCurrent()
        assertEquals(null, r.sender.acknowledgedIncidentId())
        r.transport.hear(ack(id, code = 0)); runCurrent()
        assertEquals(id, r.sender.acknowledgedIncidentId()!!.joinToString("") { "%02x".format(it) })
        r.sender.cancel()
        assertEquals(null, r.sender.acknowledgedIncidentId())

        val rejected = rig()
        val rid = started(rejected); runCurrent()
        rejected.transport.hear(ack(rid, code = 3)); runCurrent()
        assertEquals(null, rejected.sender.acknowledgedIncidentId())
    }

    @Test
    fun `an ack whose sender id does not match the server key is ignored`() = runTest {
        val r = rig()
        val id = started(r); runCurrent()
        val forged = EmergencyPacket(EmergencyType.ACK, 7, id.chunked(2).map { it.toInt(16).toByte() }.toByteArray(), 1,
            category = 0, timestamp = 1L, senderId = ByteArray(8) { 1 }, publicText = "x")
        r.transport.hear(EmergencyCodec.encode(EmergencyCodec.sign(forged, serverSign.seed))); runCurrent()
        assertTrue(r.sender.status.value.state != SosState.RECEIVED)
    }
}
