package com.baliza.emergency.ask

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrefsAskStoreTest {
    private val prefs = ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("test_ask", Context.MODE_PRIVATE)

    @Test
    fun `counters round trip`() {
        prefs.edit().clear().commit()
        PrefsAskStore.forTesting(prefs).save(AskCounters(mapOf("0303030303030303" to 5, "aa" to 2), listOf(7, 65535, 12)))
        val loaded = PrefsAskStore.forTesting(prefs).load()
        assertEquals(mapOf("0303030303030303" to 5, "aa" to 2), loaded.lastSeq)
        assertEquals(listOf(7, 65535, 12), loaded.usedRefs)
    }

    @Test
    fun `nothing saved or damaged reads as empty`() {
        prefs.edit().clear().commit()
        assertTrue(PrefsAskStore.forTesting(prefs).load().usedRefs.isEmpty())
        prefs.edit().putString("counters", "{not json").commit()
        val loaded = PrefsAskStore.forTesting(prefs).load()
        assertTrue(loaded.lastSeq.isEmpty() && loaded.usedRefs.isEmpty())
    }
}
