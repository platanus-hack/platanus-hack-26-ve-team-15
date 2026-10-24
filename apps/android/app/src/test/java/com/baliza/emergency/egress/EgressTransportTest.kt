package com.baliza.emergency.egress

import com.baliza.emergency.ReceivedEmergencyPacket
import com.baliza.emergency.SendResult
import com.baliza.emergency.codec.EmergencyCodec
import com.baliza.emergency.codec.EmergencyType
import com.baliza.emergency.egress.EgressFixtures.FakeApi
import com.baliza.emergency.egress.EgressFixtures.FakeMesh
import com.baliza.emergency.egress.EgressFixtures.MemoryStore
import com.baliza.emergency.egress.EgressFixtures.ack
import com.baliza.emergency.egress.EgressFixtures.hex
import com.baliza.emergency.egress.EgressFixtures.incident
import com.baliza.emergency.egress.EgressFixtures.sos
import com.baliza.emergency.identity.ServerKeys
import com.baliza.emergency.identity.UserIdentity
import com.baliza.emergency.sos.Channels
import com.baliza.emergency.sos.NoIncidentStore
import com.baliza.emergency.sos.SosLocation
import com.baliza.emergency.sos.SosRequest
import com.baliza.emergency.sos.SosSender
import com.baliza.emergency.sos.SosState
import com.baliza.emergency.sos.StartResult
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
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
class EgressTransportTest {
    private val epochMs = 1_798_200_000_000L

    private class Rig(
        val transport: EgressTransport, val mesh: FakeMesh, val api: FakeApi,
        val heardOnIncoming: MutableList<ReceivedEmergencyPacket>
    )

    private fun TestScope.rig(): Rig {
        val clock = { epochMs + currentTime }
        val mesh = FakeMesh()
        val api = FakeApi()
        val transport = EgressTransport(
            mesh, api, Outbox(MemoryStore(), clock), backgroundScope, MutableStateFlow(true),
            EgressFixtures.userSenderHex, { EgressFixtures.server.publicKey }, clock
        )
        val seen = mutableListOf<ReceivedEmergencyPacket>()
        backgroundScope.launch { transport.incoming.collect { seen += it } }
        runCurrent() // the collectors must be subscribed before the test "hears" anything: the flows do not replay
        return Rig(transport, mesh, api, seen)
    }

    // --- our own packets ---

    @Test
    fun `a packet we send goes to the mesh and to the backend`() = runTest {
        val r = rig()
        val packet = sos(ttl = 7)
        assertEquals(SendResult.SENT, r.transport.send(packet, 7))
        runCurrent()
        assertArrayEquals(packet, r.mesh.sent.single().first)
        assertArrayEquals(packet, r.api.uploads.single().packet)
        assertEquals("hops are 0 for our own packet", 7, r.api.uploads.single().envelopeTtl)
    }

    @Test
    fun `the mesh result is what the caller sees even if the backend is down`() = runTest {
        val r = rig()
        r.api.onUpload = { UploadResult.Retry("network") }
        r.mesh.result = SendResult.NO_NEIGHBOR_ACCEPTED
        assertEquals(SendResult.NO_NEIGHBOR_ACCEPTED, r.transport.send(sos(), 7))
    }

    @Test
    fun `the servers ack for our incident comes back to us, not onto the mesh`() = runTest {
        val r = rig()
        r.transport.send(sos(incident(3)), 7)
        runCurrent()
        val heard = r.heardOnIncoming.single()
        assertArrayEquals(ack(incident(3)), heard.payload)
        assertTrue("nothing to inject: the mesh would never give it back to us", r.mesh.sent.none { EmergencyCodec.decodeOrNull(it.first)?.type == EmergencyType.ACK })
    }

    // --- someone else's packets ---

    @Test
    fun `a packet we hear is uploaded with the envelope ttl and its ack goes onto the mesh`() = runTest {
        val r = rig()
        r.mesh.hear(sos(incident(5)), envelopeTtl = 4)
        runCurrent()
        assertEquals(4, r.api.uploads.single().envelopeTtl)
        val (bytes, ttl) = r.mesh.sent.single()
        assertArrayEquals(ack(incident(5)), bytes)
        assertEquals(7, ttl)
    }

    @Test
    fun `the servers own packets heard on the mesh are not uploaded`() = runTest {
        val r = rig()
        r.mesh.hear(ack(incident(5)))
        runCurrent()
        assertTrue(r.api.uploads.isEmpty())
    }

    @Test
    fun `the mesh packets still reach whoever listens`() = runTest {
        val r = rig()
        r.mesh.hear(sos(incident(5)))
        runCurrent()
        assertTrue(r.heardOnIncoming.any { it.payload.contentEquals(sos(incident(5))) })
    }

    // --- the mailbox ---

    @Test
    fun `contacts notified reaches the origin through its mailbox`() = runTest {
        val r = rig()
        r.transport.send(sos(incident(3)), 7)
        runCurrent()
        r.heardOnIncoming.clear()
        r.api.onPoll = { PollResult.Messages(listOf(MailboxMessage("m_0002", 3, hex(incident(3)), ack(incident(3), code = 1)))) }
        advanceTimeBy(25_000); runCurrent()
        assertArrayEquals(ack(incident(3), code = 1), r.heardOnIncoming.single().payload)
        assertEquals(EgressFixtures.userSenderHex, r.api.polls.first().single().senderIdHex)
    }

    @Test
    fun `cancelling stops asking the server`() = runTest {
        val r = rig()
        r.transport.send(sos(incident(3)), 7)
        runCurrent()
        advanceTimeBy(25_000); runCurrent()
        val n = r.api.polls.size
        r.transport.forgetOwn(hex(incident(3)))
        advanceTimeBy(120_000); runCurrent()
        assertEquals(n, r.api.polls.size)
    }

    @Test
    fun `an incident restored after a restart is tracked again`() = runTest {
        val r = rig()
        r.transport.trackOwn(hex(incident(8)))
        advanceTimeBy(25_000); runCurrent()
        assertEquals(listOf(hex(incident(8))), r.api.polls.single().single().incidentIdsHex)
    }

    @Test
    fun `a reply waiting for someone out of the servers reach is put on the mesh`() = runTest {
        val r = rig()
        r.mesh.hear(sos(incident(5)))
        runCurrent()
        r.mesh.sent.clear()
        r.api.onPoll = { PollResult.Messages(listOf(MailboxMessage("m_0007", 3, hex(incident(5)), ack(incident(5), code = 1)))) }
        advanceTimeBy(25_000); runCurrent()
        assertArrayEquals(ack(incident(5), code = 1), r.mesh.sent.single().first)
    }

    // --- the whole loop with the real SOS sender ---

    private val identity = UserIdentity(
        EgressFixtures.user.seed, EgressFixtures.user.publicKey,
        EgressFixtures.serverSeal.privateKey, EgressFixtures.serverSeal.publicKey
    )
    private val serverKeys = ServerKeys("k1", EgressFixtures.server.publicKey, EgressFixtures.serverSeal.publicKey)
    private val request = SosRequest(1, 3, "SOS medico", SosLocation(10.497, -66.853, 12), "nota", 1, Channels.SMS)

    private fun TestScope.sender(r: Rig) =
        SosSender(r.transport, identity, { serverKeys }, backgroundScope, store = NoIncidentStore, nowMillis = { epochMs + currentTime })

    @Test
    fun `an SOS with nobody in range still gets its acknowledgement through the internet`() = runTest {
        val r = rig()
        r.mesh.result = SendResult.NO_NEIGHBOR_ACCEPTED
        val s = sender(r)
        assertTrue(s.start(request) is StartResult.Started)
        runCurrent()
        assertEquals("the server's ack for our incident reached the sender without any mesh echo", SosState.IN_PROGRESS, s.status.value.state)
    }

    @Test
    fun `the full loop reaches contacts notified through the mailbox`() = runTest {
        val r = rig()
        val s = sender(r)
        val id = (s.start(request) as StartResult.Started).incidentIdHex
        runCurrent()
        assertEquals(SosState.IN_PROGRESS, s.status.value.state)

        r.api.onPoll = { PollResult.Messages(listOf(MailboxMessage("m_0002", 3, id, ack(id.chunked(2).map { it.toInt(16).toByte() }.toByteArray(), code = 1)))) }
        advanceTimeBy(25_000); runCurrent()
        assertEquals(SosState.CONTACTS_NOTIFIED, s.status.value.state)
    }

    @Test
    fun `when the backend is down the sender keeps retrying and the ack arrives as soon as it is back`() = runTest {
        val r = rig()
        val original = r.api.onUpload
        r.api.onUpload = { UploadResult.Retry("503") }
        val s = sender(r)
        s.start(request)
        advanceTimeBy(50_000); runCurrent()
        assertTrue("retried, never gave up", r.api.uploads.size >= 3)
        assertTrue(s.status.value.state != SosState.IN_PROGRESS)

        r.api.onUpload = original
        advanceTimeBy(16_000); runCurrent()
        assertEquals(SosState.IN_PROGRESS, s.status.value.state)
    }

    @Test
    fun `a rejected sender gets nothing back and is not retried forever on the server side`() = runTest {
        val r = rig()
        r.api.onUpload = { UploadResult.Discard(404) }
        val s = sender(r)
        s.start(request)
        advanceTimeBy(20_000); runCurrent()
        assertTrue("no ack, the sender keeps its own retry schedule", s.status.value.state != SosState.IN_PROGRESS)
        assertTrue(r.heardOnIncoming.none { EmergencyCodec.decodeOrNull(it.payload)?.type == EmergencyType.ACK })
    }
}
