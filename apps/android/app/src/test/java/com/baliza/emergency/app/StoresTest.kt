package com.baliza.emergency.app

import android.content.Context
import android.location.Location
import androidx.test.core.app.ApplicationProvider
import com.baliza.emergency.registration.EmergencyContact
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class StoresTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val prefs = context.getSharedPreferences("test_contacts", Context.MODE_PRIVATE)

    @Before
    fun setUp() { prefs.edit().clear().commit() }

    @Test
    fun `contacts survive a restart exactly as typed`() {
        val profile = ContactProfile("Usuario Demo", listOf(
            EmergencyContact(0, "Contacto Demo Uno", "familiar", "es", sms = "+58 000-0000001", email = "uno@example.com", voice = "+58 000-0000001"),
            EmergencyContact(1, "Solo SMS", sms = "0000000002")
        ))
        ContactStore.forTesting(prefs).save(profile)

        val loaded = ContactStore.forTesting(prefs).load()!!
        assertEquals("Usuario Demo", loaded.displayName)
        val (one, two) = loaded.contacts
        assertEquals(0, one.index); assertEquals("familiar", one.relation)
        assertEquals("uno@example.com", one.email); assertEquals("+58 000-0000001", one.voice)
        assertEquals(1, two.index)
        assertEquals("0000000002", two.sms)
        assertNull("a missing channel stays missing, not the string \"null\"", two.email)
        assertNull(two.voice)
    }

    @Test
    fun `nothing saved or garbage reads as no profile`() {
        val store = ContactStore.forTesting(prefs)
        assertNull(store.load())
        prefs.edit().putString("profile", "{not json").commit()
        assertNull(store.load())
        prefs.edit().putString("profile", """{"name":"x"}""").commit()
        assertNull(store.load())
    }

    @Test
    fun `clear forgets the contacts`() {
        val store = ContactStore.forTesting(prefs)
        store.save(ContactProfile("U", listOf(EmergencyContact(0, "A", sms = "1234567"))))
        assertNotNull(store.load())
        store.clear()
        assertNull(store.load())
    }

    // --- backend address ---

    private val settingsPrefs get() = context.getSharedPreferences("test_settings", Context.MODE_PRIVATE)

    @Test
    fun `the build default is used until the user overrides it`() {
        settingsPrefs.edit().clear().commit()
        val settings = ApiSettings(settingsPrefs, "https://api.example.test")
        assertEquals("https://api.example.test", settings.baseUrl)
        assertTrue(settings.setBaseUrl(" http://192.168.1.10:3000/ "))
        assertEquals("http://192.168.1.10:3000", settings.baseUrl)
        assertTrue(settings.setBaseUrl(""))
        assertEquals("https://api.example.test", settings.baseUrl)
    }

    @Test
    fun `an address that is not http or https is refused and the old one stays`() {
        settingsPrefs.edit().clear().commit()
        val settings = ApiSettings(settingsPrefs, "")
        assertTrue(settings.setBaseUrl("https://ok.example.test"))
        assertFalse(settings.setBaseUrl("ftp://nope"))
        assertFalse(settings.setBaseUrl("192.168.1.10"))
        assertEquals("https://ok.example.test", settings.baseUrl)
        assertEquals("", ApiSettings(context.getSharedPreferences("empty_settings", Context.MODE_PRIVATE).also { it.edit().clear().commit() }, "").baseUrl)
    }

    // --- location ---

    @Test
    fun `fix age comes from the monotonic clock`() {
        val fix = Location("test").apply {
            latitude = 10.497; longitude = -66.853; accuracy = 12.6f
            elapsedRealtimeNanos = 100_000_000_000L // 100 s since boot
            time = 0 // wrong wall clock must not matter
        }
        val loc = SosLocationProvider.toSosLocation(fix, nowElapsedNanos = 104_900_000_000L)
        assertEquals(12, loc.accuracyM)
        assertEquals(4, loc.fixAgeSeconds)
        assertEquals(10.497, loc.latitude, 1e-9)
    }

    @Test
    fun `missing accuracy and clock skew are clamped`() {
        val noAccuracy = Location("test").apply { latitude = 1.0; longitude = 2.0; elapsedRealtimeNanos = 50_000_000_000L }
        assertEquals(0, SosLocationProvider.toSosLocation(noAccuracy, 40_000_000_000L).fixAgeSeconds) // "future" fix
        assertEquals(0, SosLocationProvider.toSosLocation(noAccuracy, 50_000_000_000L).accuracyM)
        val old = Location("test").apply { latitude = 1.0; longitude = 2.0; accuracy = 70000f; elapsedRealtimeNanos = 0 }
        val clamped = SosLocationProvider.toSosLocation(old, nowElapsedNanos = 70_000_000_000_000L) // 70000 s
        assertEquals(0xFFFF, clamped.fixAgeSeconds)
        assertEquals(0xFFFF, clamped.accuracyM)
    }
}
