package com.baliza.emergency.egress

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.baliza.emergency.egress.EgressFixtures.MemoryStore
import com.baliza.emergency.egress.EgressFixtures.incident
import com.baliza.emergency.egress.EgressFixtures.sos
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class OutboxTest {
    private var now = 1_000_000_000L
    private val store = MemoryStore()
    private fun outbox(max: Int = 200) = Outbox(store, { now }, maxEntries = max)
    private fun entry(n: Int, at: Long = now) = OutboxEntry(sos(incident(n)), 4, 1_798_200_000L, at)

    @Test
    fun `oldest first`() {
        val box = outbox()
        box.add(entry(1)); box.add(entry(2)); box.add(entry(3))
        assertArrayEquals(entry(1).wire, box.peek()!!.wire)
        box.remove(box.peek()!!)
        assertArrayEquals(entry(2).wire, box.peek()!!.wire)
        assertEquals(2, box.size)
    }

    @Test
    fun `the same packet is kept once`() {
        val box = outbox()
        assertTrue(box.add(entry(1)))
        assertFalse(box.add(entry(1)))
        assertEquals(1, box.size)
    }

    @Test
    fun `when full the oldest goes`() {
        val box = outbox(max = 3)
        for (n in 1..5) box.add(entry(n))
        assertEquals(3, box.size)
        assertArrayEquals(entry(3).wire, box.peek()!!.wire)
    }

    @Test
    fun `two hundred is the default cap`() {
        val box = outbox()
        for (n in 0 until 250) box.add(OutboxEntry(sos(incident(1), seq = n), 3, 1, now))
        assertEquals(200, box.size)
    }

    @Test
    fun `entries older than a day are dropped`() {
        val box = outbox()
        box.add(entry(1)); box.add(entry(2, at = now + 3_600_000))
        now += 24 * 3_600_000L + 1
        assertEquals(1, box.size)
        assertArrayEquals(entry(2).wire, box.peek()!!.wire)
        now += 3_600_000L
        assertTrue(box.isEmpty())
    }

    @Test
    fun `a new instance sees what was saved`() {
        outbox().apply { add(entry(1)); add(entry(2)) }
        val again = outbox()
        assertEquals(2, again.size)
        again.remove(again.peek()!!)
        assertEquals(1, outbox().size)
    }

    @Test
    fun `prefs store round trips and a damaged value reads as empty`() {
        val prefs = ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("test_outbox", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        val disk = PrefsOutboxStore.forTesting(prefs)
        disk.save(listOf(entry(1), entry(2)))
        val loaded = PrefsOutboxStore.forTesting(prefs).load()
        assertEquals(2, loaded.size)
        assertArrayEquals(entry(2).wire, loaded[1].wire)
        assertEquals(4, loaded[0].envelopeTtl)
        assertEquals(1_798_200_000L, loaded[0].rxAtSeconds)

        prefs.edit().putString("entries", "{not json").commit()
        assertTrue(disk.load().isEmpty())
        prefs.edit().putString("entries", """[{"w":"!!!","t":1,"r":1,"a":1}]""").commit()
        assertTrue(disk.load().isEmpty())
        prefs.edit().clear().commit()
        assertNull(disk.load().firstOrNull())
    }
}
