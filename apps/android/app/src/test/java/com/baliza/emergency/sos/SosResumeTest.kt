package com.baliza.emergency.sos

import android.content.Context
import androidx.test.core.app.ApplicationProvider
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
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The incident must survive Android killing the process: same packet, retries resume. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class SosResumeTest {

    private val userSign = Ed25519.keyPairFromSeed(ByteArray(32) { 1 })
    private val userSeal = SealedBox.generateKeyPair()
    private val identity = UserIdentity(userSign.seed, userSign.publicKey, userSeal.privateKey, userSeal.publicKey)
    private val serverSign = Ed25519.keyPairFromSeed(ByteArray(32) { 5 })
    private val server = ServerKeys("k1", serverSign.publicKey, SealedBox.generateKeyPair().publicKey)
    private val epochMs = 1_798_200_000_000L
    private lateinit var prefs: android.content.SharedPreferences
    private lateinit var store: PrefsIncidentStore

    private class FakeTransport(private val clock: () -> Long) : EmergencyMeshTransport {
        val sent = mutableListOf<ByteArray>()
        val sentAt = mutableListOf<Long>()
        private val flow = MutableSharedFlow<ReceivedEmergencyPacket>(extraBufferCapacity = 16)
        override val incoming = flow
        override val newNeighbors = emptyFlow<Unit>()
        override suspend fun send(payload: ByteArray, ttl: Int): SendResult {
            sent += payload.copyOf(); sentAt += clock()
            return SendResult.SENT
        }
        fun hear(payload: ByteArray) = flow.tryEmit(ReceivedEmergencyPacket(payload, 5, "00", "AA"))
    }

    private val request = SosRequest(1, 3, "SOS medico", SosLocation(10.497, -66.853, 12), "nota", 1, Channels.SMS)

    @Before
    fun setUp() {
        val context: Context = ApplicationProvider.getApplicationContext()
        prefs = context.getSharedPreferences("test_incident", Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        store = PrefsIncidentStore.forTesting(prefs)
    }

    private class Run(val sender: SosSender, val transport: FakeTransport)

    /** A "process": new sender and transport, same disk. */
    private fun TestScope.process(who: UserIdentity = identity): Run {
        val clock = { epochMs + currentTime }
        val transport = FakeTransport(clock)
        return Run(SosSender(transport, who, { server }, backgroundScope, store = store, nowMillis = clock), transport)
    }

    private fun ack(incidentHex: String, code: Int): ByteArray = EmergencyCodec.encode(EmergencyCodec.sign(
        EmergencyPacket(EmergencyType.ACK, 7, incidentHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray(), 1,
            category = code, timestamp = 1L, senderId = Ed25519.senderId(serverSign.publicKey), publicText = "ok"),
        serverSign.seed))

    @Test
    fun `starting an incident saves it`() = runTest {
        val first = process()
        val id = (first.sender.start(request) as StartResult.Started).incidentIdHex
        runCurrent()
        val saved = store.load()!!
        assertEquals(id, saved.incidentId.joinToString("") { "%02x".format(it) })
        assertEquals(1, saved.seq)
        assertNull(saved.ackState)
        assertArrayEquals(first.transport.sent.first(), saved.wire)
    }

    @Test
    fun `after a restart the same packet is resent on a fresh schedule`() = runTest {
        val before = process()
        val id = (before.sender.start(request) as StartResult.Started).incidentIdHex
        advanceTimeBy(40_000); runCurrent()
        val original = before.transport.sent.first()
        val restartedAt = currentTime

        // process dies: nothing of `before` runs again
        val after = process()
        assertTrue(after.sender.resume())
        assertEquals(id, after.sender.status.value.incidentIdHex)
        advanceTimeBy(31_000); runCurrent()

        assertEquals(listOf<Long>(0, 15, 30), after.transport.sentAt.map { (it - epochMs - restartedAt) / 1000 })
        after.transport.sent.forEach { assertArrayEquals(original, it) }
    }

    @Test
    fun `an acknowledged incident resumes quietly and keeps its state`() = runTest {
        val before = process()
        val id = (before.sender.start(request) as StartResult.Started).incidentIdHex
        runCurrent()
        before.transport.hear(ack(id, 1)); runCurrent()
        assertEquals(SosState.CONTACTS_NOTIFIED, store.load()!!.ackState)

        val after = process()
        assertTrue(after.sender.resume())
        assertEquals(SosState.CONTACTS_NOTIFIED, after.sender.status.value.state)
        advanceTimeBy(10 * 60_000); runCurrent()
        assertTrue("nothing is resent once acknowledged", after.transport.sent.isEmpty())

        // and later ACKs are still understood
        after.transport.hear(ack(id, 3)); runCurrent()
        assertEquals(SosState.REJECTED, after.sender.status.value.state)
    }

    @Test
    fun `cancel forgets the incident`() = runTest {
        val first = process()
        first.sender.start(request); runCurrent()
        first.sender.cancel()
        assertNull(store.load())
        assertFalse(process().sender.resume())
    }

    @Test
    fun `nothing to resume on a clean install`() = runTest {
        assertFalse(process().sender.resume())
    }

    @Test
    fun `resume does nothing while an incident is already running`() = runTest {
        val first = process()
        first.sender.start(request); runCurrent()
        assertFalse(first.sender.resume())
    }

    @Test
    fun `a saved packet that is not ours is discarded`() = runTest {
        val first = process()
        first.sender.start(request); runCurrent()
        val other = UserIdentity(ByteArray(32) { 9 }, Ed25519.keyPairFromSeed(ByteArray(32) { 9 }).publicKey, userSeal.privateKey, userSeal.publicKey)

        assertFalse("another user's key", process(who = other).sender.resume())
        assertNull("and it is erased", store.load())
    }

    @Test
    fun `a damaged saved packet is discarded`() = runTest {
        val first = process()
        first.sender.start(request); runCurrent()
        val saved = store.load()!!
        store.save(IncidentRecord(saved.incidentId, saved.seq, saved.wire.copyOf().also { it[60] = (it[60].toInt() xor 1).toByte() }, null))
        assertFalse(process().sender.resume())
        assertNull(store.load())
    }

    @Test
    fun `a record whose id or seq disagree with the packet is discarded`() = runTest {
        val first = process()
        first.sender.start(request); runCurrent()
        val saved = store.load()!!
        store.save(IncidentRecord(ByteArray(8) { 1 }, saved.seq, saved.wire, null))
        assertFalse(process().sender.resume())
        store.save(IncidentRecord(saved.incidentId, 2, saved.wire, null))
        assertFalse(process().sender.resume())
    }

    @Test
    fun `garbage in the preferences reads as no incident`() = runTest {
        prefs.edit().putString("incident_id", "not base64 !!").putString("wire", "%%%").putInt("seq", 1).commit()
        assertNull(store.load())
        assertFalse(process().sender.resume())
        prefs.edit().clear().putString("incident_id", "AAAAAAAAAAA=").putString("wire", "AAAA").putInt("seq", 1).putString("ack_state", "NOPE").commit()
        assertNotNull(store.load())
        assertNull(store.load()!!.ackState)
    }
}
