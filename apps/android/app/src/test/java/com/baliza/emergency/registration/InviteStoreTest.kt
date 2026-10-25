package com.baliza.emergency.registration

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class InviteStoreTest {
    private val prefs = ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("test_invites", Context.MODE_PRIVATE)

    @Test
    fun `codes round trip and garbage reads as none`() {
        prefs.edit().clear().commit()
        assertTrue(PrefsInviteStore.forTesting(prefs).load().isEmpty())
        PrefsInviteStore.forTesting(prefs).save(mapOf(0 to "K7M2QX9P", 31 to "23456789"))
        assertEquals(mapOf(0 to "K7M2QX9P", 31 to "23456789"), PrefsInviteStore.forTesting(prefs).load())
        prefs.edit().putString("codes", "{not json").commit()
        assertTrue(PrefsInviteStore.forTesting(prefs).load().isEmpty())
        prefs.edit().putString("codes", """{"x":"K7M2QX9P"}""").commit()
        assertTrue(PrefsInviteStore.forTesting(prefs).load().isEmpty())
    }
}
