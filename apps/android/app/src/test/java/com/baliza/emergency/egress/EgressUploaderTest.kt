package com.baliza.emergency.egress

import com.baliza.emergency.codec.EmergencyType
import com.baliza.emergency.egress.EgressFixtures.FakeApi
import com.baliza.emergency.egress.EgressFixtures.MemoryStore
import com.baliza.emergency.egress.EgressFixtures.ack
import com.baliza.emergency.egress.EgressFixtures.hex
import com.baliza.emergency.egress.EgressFixtures.incident
import com.baliza.emergency.egress.EgressFixtures.sos
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class EgressUploaderTest {
    private val epochMs = 1_798_200_000_000L

    private class Rig(
        val uploader: EgressUploader, val api: FakeApi, val outbox: Outbox, val online: MutableStateFlow<Boolean>,
        val delivered: MutableList<Pair<ByteArray, Boolean>>, val own: MutableSet<String>
    )

    private fun TestScope.rig(
        store: MemoryStore = MemoryStore(),
        serverKey: ByteArray? = EgressFixtures.server.publicKey,
        online: Boolean = true
    ): Rig {
        val clock = { epochMs + currentTime }
        val api = FakeApi()
        val box = Outbox(store, clock)
        val flag = MutableStateFlow(online)
        val delivered = mutableListOf<Pair<ByteArray, Boolean>>()
        val own = mutableSetOf<String>()
        val uploader = EgressUploader(api, box, backgroundScope, flag, "egress-test", clock, { serverKey },
            isOwnIncident = { it in own }, deliver = { p, forOwn -> delivered += p to forOwn })
        return Rig(uploader, api, box, flag, delivered, own)
    }

    // --- what is uploaded ---

    @Test
    fun `a heard sos is uploaded with the egress id, the envelope ttl and the time`() = runTest {
        val r = rig()
        val packet = sos()
        r.uploader.offerHeard(packet, envelopeTtl = 4)
        runCurrent()

        val up = r.api.uploads.single()
        assertArrayEquals(packet, up.packet)
        assertEquals("egress-test", up.egressId)
        assertEquals(4, up.envelopeTtl)
        assertEquals(epochMs / 1000, up.rxAt)
    }

    @Test
    fun `an own packet reports its own ttl, so hops are zero`() = runTest {
        val r = rig()
        r.uploader.offerOwn(sos(ttl = 7))
        runCurrent()
        assertEquals(7, r.api.uploads.single().envelopeTtl)
    }

    @Test
    fun `only packets a phone originates are uploaded`() = runTest {
        val r = rig()
        r.uploader.offerHeard(ack(), 5)                       // the server's own type
        r.uploader.offerHeard(ByteArray(0), 5)                // garbage
        r.uploader.offerHeard(ByteArray(120) { 9 }, 5)
        r.uploader.offerHeard(sos(type = EmergencyType.UPDATE, seq = 2), 5)
        runCurrent()
        assertEquals(1, r.api.uploads.size)
        assertEquals(EmergencyType.UPDATE, com.baliza.emergency.codec.EmergencyCodec.decode(r.api.uploads[0].packet).type)
    }

    @Test
    fun `the same retry heard several times is uploaded once per window`() = runTest {
        val r = rig()
        repeat(4) { r.uploader.offerHeard(sos(), 5) }
        runCurrent()
        assertEquals(1, r.api.uploads.size)

        advanceTimeBy(9_000); runCurrent()
        r.uploader.offerHeard(sos(), 5); runCurrent()
        assertEquals("still inside 10 s", 1, r.api.uploads.size)

        advanceTimeBy(2_000); runCurrent()
        r.uploader.offerHeard(sos(), 5); runCurrent()
        assertEquals("the next 15 s retry goes through, so R1 can reopen the path", 2, r.api.uploads.size)
    }

    // --- what comes back ---

    @Test
    fun `the servers ack is handed on`() = runTest {
        val r = rig()
        r.uploader.offerHeard(sos(incident(3)), 5); runCurrent()
        val (bytes, forOwn) = r.delivered.single()
        assertArrayEquals(ack(incident(3)), bytes)
        assertFalse("someone else's incident goes on the mesh", forOwn)
    }

    @Test
    fun `an ack for our own incident is marked as ours`() = runTest {
        val r = rig()
        r.own += hex(incident(3))
        r.uploader.offerOwn(sos(incident(3))); runCurrent()
        assertTrue(r.delivered.single().second)
    }

    @Test
    fun `an ack the server did not sign is dropped, a missing one is ignored`() = runTest {
        val r = rig()
        val impostor = com.baliza.emergency.crypto.Ed25519.keyPairFromSeed(ByteArray(32) { 9 })
        r.api.onUpload = { com.baliza.emergency.egress.UploadResult.Accepted("accepted", ack(signer = impostor)) }
        r.uploader.offerHeard(sos(), 5); runCurrent()
        assertTrue(r.delivered.isEmpty())

        r.api.onUpload = { UploadResult.Accepted("accepted", null) }
        r.uploader.offerHeard(sos(seq = 2), 5); runCurrent()
        assertTrue(r.delivered.isEmpty())
    }

    @Test
    fun `before registering there is no key to check against, so the ack is handed on`() = runTest {
        val r = rig(serverKey = null)
        r.uploader.offerHeard(sos(), 5); runCurrent()
        assertEquals(1, r.delivered.size)
    }

    // --- the outbox (R3) ---

    @Test
    fun `a heard packet that cannot be uploaded waits in the outbox`() = runTest {
        val r = rig(online = false)
        r.api.onUpload = { UploadResult.Retry("network") }
        r.uploader.offerHeard(sos(), 4); runCurrent()
        assertEquals(1, r.outbox.size)
        assertEquals(4, r.outbox.peek()!!.envelopeTtl)
    }

    @Test
    fun `an own packet that cannot be uploaded is not queued, its sender retries`() = runTest {
        val r = rig(online = false)
        r.own += hex(incident(3))
        r.api.onUpload = { UploadResult.Retry("network") }
        r.uploader.offerOwn(sos(incident(3))); runCurrent()
        assertTrue(r.outbox.isEmpty())
    }

    @Test
    fun `a final rejection is dropped, not queued`() = runTest {
        val r = rig()
        r.api.onUpload = { UploadResult.Discard(404) }
        r.uploader.offerHeard(sos(), 5); runCurrent()
        assertTrue(r.outbox.isEmpty())
    }

    @Test
    fun `the outbox is emptied oldest first once there is internet`() = runTest {
        val r = rig(online = false)
        var online = false
        r.api.onUpload = { if (online) UploadResult.Accepted("accepted", null) else UploadResult.Retry("network") }
        r.uploader.offerHeard(sos(incident(1)), 5); runCurrent()
        advanceTimeBy(11_000)
        r.uploader.offerHeard(sos(incident(2)), 5); runCurrent()
        assertEquals(2, r.outbox.size)
        val before = r.api.uploads.size

        advanceTimeBy(60_000); runCurrent()
        assertEquals("nothing is tried while offline", before, r.api.uploads.size)

        online = true
        r.online.value = true; runCurrent()
        assertTrue(r.outbox.isEmpty())
        val order = r.api.uploads.drop(before).map { com.baliza.emergency.codec.EmergencyCodec.decode(it.packet).incidentId[0].toInt() }
        assertEquals(listOf(1, 2), order)
    }

    @Test
    fun `retries back off from 30 s to 5 min and success resets them`() = runTest {
        val r = rig()
        var ok = false
        r.api.onUpload = { if (ok) UploadResult.Accepted("accepted", null) else UploadResult.Retry("503") }
        r.uploader.offerHeard(sos(), 5); runCurrent()
        val start = currentTime
        val attemptsAt = mutableListOf<Long>()
        var seen = r.api.uploads.size
        repeat(600) {
            advanceTimeBy(1_000); runCurrent()
            if (r.api.uploads.size > seen) { attemptsAt += (currentTime - start) / 1000; seen = r.api.uploads.size }
        }
        // first try at 0 (from the offer), then the flush loop: +30, +60, +120, +240, then 300 each
        assertEquals(listOf<Long>(30, 90, 210, 450), attemptsAt.take(4))
        ok = true
        advanceTimeBy(300_000); runCurrent()
        assertTrue(r.outbox.isEmpty())
    }

    @Test
    fun `an outbox left by a previous run is flushed at start`() = runTest {
        val store = MemoryStore()
        Outbox(store, { epochMs }).add(OutboxEntry(sos(incident(7)), 4, 1, epochMs))
        val r = rig(store = store)
        runCurrent()
        assertEquals(1, r.api.uploads.size)
        assertTrue(r.outbox.isEmpty())
    }

    @Test
    fun `a 429 keeps the packet`() = runTest {
        val r = rig()
        r.api.onUpload = { UploadResult.Retry("http 429") }
        r.uploader.offerHeard(sos(), 5); runCurrent()
        assertEquals(1, r.outbox.size)
    }
}
