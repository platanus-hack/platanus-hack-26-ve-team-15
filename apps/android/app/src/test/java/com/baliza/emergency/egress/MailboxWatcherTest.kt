package com.baliza.emergency.egress

import com.baliza.emergency.egress.EgressFixtures.FakeApi
import com.baliza.emergency.egress.EgressFixtures.ack
import com.baliza.emergency.egress.EgressFixtures.hex
import com.baliza.emergency.egress.EgressFixtures.incident
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class MailboxWatcherTest {
    private val epochMs = 1_798_200_000_000L
    private val me = "930bda7e20b63bb9"
    private val other = "1122334455667788"

    private class Rig(val watcher: MailboxWatcher, val api: FakeApi, val delivered: MutableList<Pair<String, Boolean>>)

    private fun TestScope.rig(): Rig {
        val api = FakeApi()
        val delivered = mutableListOf<Pair<String, Boolean>>()
        val watcher = MailboxWatcher(api, backgroundScope, me, { epochMs + currentTime }, { p, own -> delivered += hex(p) to own })
        watcher.start()
        return Rig(watcher, api, delivered)
    }

    private fun message(id: String, incident: ByteArray, code: Int = 1) =
        MailboxMessage(id, 3, hex(incident), ack(incident, code))

    @Test
    fun `an own incident is polled every 20 s with our sender id`() = runTest {
        val r = rig()
        r.watcher.trackOwn(hex(incident(3)))
        advanceTimeBy(65_000); runCurrent()
        assertEquals(3, r.api.polls.size)
        val q = r.api.polls[0].single()
        assertEquals(me, q.senderIdHex)
        assertEquals(listOf(hex(incident(3))), q.incidentIdsHex)
    }

    @Test
    fun `nothing is asked when nothing is tracked`() = runTest {
        val r = rig()
        advanceTimeBy(100_000); runCurrent()
        assertTrue(r.api.polls.isEmpty())
    }

    @Test
    fun `a message for our incident reaches us once, however often it is listed`() = runTest {
        val r = rig()
        r.watcher.trackOwn(hex(incident(3)))
        r.api.onPoll = { PollResult.Messages(listOf(message("m_0001", incident(3)))) }
        advanceTimeBy(65_000); runCurrent()
        assertEquals(1, r.delivered.size)
        assertTrue("for our own incident", r.delivered[0].second)
    }

    @Test
    fun `a new message is delivered when it appears`() = runTest {
        val r = rig()
        r.watcher.trackOwn(hex(incident(3)))
        r.api.onPoll = { PollResult.Messages(listOf(message("m_0001", incident(3), code = 2))) }
        advanceTimeBy(25_000); runCurrent()
        r.api.onPoll = { PollResult.Messages(listOf(message("m_0001", incident(3), code = 2), message("m_0002", incident(3), code = 1))) }
        advanceTimeBy(20_000); runCurrent()
        assertEquals(2, r.delivered.size)
    }

    @Test
    fun `cancelling stops the polling`() = runTest {
        val r = rig()
        r.watcher.trackOwn(hex(incident(3)))
        advanceTimeBy(25_000); runCurrent()
        val n = r.api.polls.size
        r.watcher.untrackOwn(hex(incident(3)))
        advanceTimeBy(120_000); runCurrent()
        assertEquals(n, r.api.polls.size)
    }

    @Test
    fun `a heard incident is polled under its own sender and its replies go to the mesh`() = runTest {
        val r = rig()
        r.watcher.noteHeard(other, hex(incident(5)))
        r.api.onPoll = { PollResult.Messages(listOf(message("m_0009", incident(5)))) }
        advanceTimeBy(25_000); runCurrent()
        assertEquals(other, r.api.polls[0].single().senderIdHex)
        val (_, forOwn) = r.delivered.single()
        assertTrue("someone else's incident: put it on the mesh", !forOwn)
    }

    @Test
    fun `hearing the incident again re-injects the reply, but not before the cooldown`() = runTest {
        val r = rig()
        r.watcher.noteHeard(other, hex(incident(5)))
        r.api.onPoll = { PollResult.Messages(listOf(message("m_0009", incident(5)))) }
        advanceTimeBy(25_000); runCurrent()
        assertEquals(1, r.delivered.size)

        advanceTimeBy(20_000)
        r.watcher.noteHeard(other, hex(incident(5)))
        assertEquals("only 20 s since the injection", 1, r.delivered.size)

        advanceTimeBy(50_000)
        r.watcher.noteHeard(other, hex(incident(5)))
        assertEquals("a minute has passed and the origin is still around", 2, r.delivered.size)
    }

    @Test
    fun `a heard incident is forgotten after half an hour of silence`() = runTest {
        val r = rig()
        r.watcher.noteHeard(other, hex(incident(5)))
        advanceTimeBy(25_000); runCurrent()
        assertEquals(1, r.api.polls.size)
        advanceTimeBy(31 * 60_000); runCurrent()
        val n = r.api.polls.size
        advanceTimeBy(5 * 60_000); runCurrent()
        assertEquals(n, r.api.polls.size)
    }

    @Test
    fun `a failed poll is simply tried again at the next interval`() = runTest {
        val r = rig()
        r.watcher.trackOwn(hex(incident(3)))
        r.api.onPoll = { PollResult.Failed("network") }
        advanceTimeBy(45_000); runCurrent()
        r.api.onPoll = { PollResult.Messages(listOf(message("m_0001", incident(3)))) }
        advanceTimeBy(20_000); runCurrent()
        assertEquals(1, r.delivered.size)
    }

    @Test
    fun `an exception from the api does not end the polling`() = runTest {
        val r = rig()
        r.watcher.trackOwn(hex(incident(3)))
        r.api.onPoll = { throw IllegalStateException("boom") }
        advanceTimeBy(45_000); runCurrent()
        r.api.onPoll = { PollResult.Messages(listOf(message("m_0001", incident(3)))) }
        advanceTimeBy(20_000); runCurrent()
        assertEquals(1, r.delivered.size)
    }

    @Test
    fun `queries stay within the backend limits`() = runTest {
        val r = rig()
        for (n in 1..120) r.watcher.noteHeard(other, hex(ByteArray(8) { n.toByte() }))
        advanceTimeBy(25_000); runCurrent()
        val queries = r.api.polls.single()
        assertTrue(queries.size <= MailboxWatcher.MAX_QUERIES)
        assertTrue(queries.all { it.incidentIdsHex.size <= MailboxWatcher.MAX_IDS })
        assertEquals(120, queries.sumOf { it.incidentIdsHex.size })
    }
}
