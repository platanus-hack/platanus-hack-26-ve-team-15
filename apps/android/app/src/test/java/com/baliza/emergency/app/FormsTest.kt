package com.baliza.emergency.app

import com.baliza.emergency.registration.EmergencyContact
import com.baliza.emergency.sos.Channels
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FormsTest {

    private fun ok(name: String, drafts: List<ContactDraft>) =
        (RegistrationForm.build(name, drafts) as FormResult.Ok).value

    private fun error(name: String, drafts: List<ContactDraft>) =
        (RegistrationForm.build(name, drafts) as FormResult.Error).message

    private val good = ContactDraft("Contacto Demo Uno", "+58 000-0000001", "uno@example.com")

    @Test
    fun `a complete form becomes a profile with sms, voice and email`() {
        val profile = ok(" Usuario Demo ", listOf(good))
        assertEquals("Usuario Demo", profile.displayName)
        val c = profile.contacts.single()
        assertEquals(0, c.index)
        assertEquals("+58 000-0000001", c.sms)
        assertEquals("+58 000-0000001", c.voice)
        assertEquals("uno@example.com", c.email)
    }

    @Test
    fun `blank rows are skipped and indexes stay consecutive`() {
        val profile = ok("Usuario Demo", listOf(ContactDraft(), good, ContactDraft(), ContactDraft("Dos", "0000000002", "")))
        assertEquals(listOf(0, 1), profile.contacts.map { it.index })
        assertEquals(listOf("Contacto Demo Uno", "Dos"), profile.contacts.map { it.name })
        assertNull(profile.contacts[1].email)
    }

    @Test
    fun `an email alone is enough`() {
        val c = ok("Usuario Demo", listOf(ContactDraft("Solo correo", "", "a@example.com"))).contacts.single()
        assertNull(c.sms); assertNull(c.voice)
        assertEquals("a@example.com", c.email)
    }

    @Test
    fun `rejects what the backend would reject, with a reason the user can act on`() {
        assertTrue(error("", listOf(good)).contains("nombre"))
        assertTrue(error("Usuario Demo", emptyList()).contains("al menos un contacto"))
        assertTrue(error("Usuario Demo", listOf(ContactDraft("", "0000000001", ""))).contains("Falta el nombre"))
        assertTrue(error("Usuario Demo", listOf(ContactDraft("Sin medios", "", ""))).contains("teléfono o un correo"))
        assertTrue(error("Usuario Demo", listOf(ContactDraft("Mal tel", "12", ""))).contains("teléfono"))
        assertTrue(error("Usuario Demo", listOf(ContactDraft("Mal tel", "abc1234567", ""))).contains("teléfono"))
        assertTrue(error("Usuario Demo", listOf(ContactDraft("Mal correo", "", "no-es-correo"))).contains("correo"))
        assertTrue(error("Usuario Demo", listOf(ContactDraft("x".repeat(41), "0000000001", ""))).contains("demasiado largo"))
        assertTrue(error("Usuario Demo", List(6) { good }).contains("Máximo"))
    }

    @Test
    fun `phone and email validators`() {
        assertTrue(RegistrationForm.validPhone("+58 (000) 000-0001"))
        assertTrue(RegistrationForm.validPhone("0000000"))
        assertFalse(RegistrationForm.validPhone("000000"))
        assertFalse(RegistrationForm.validPhone("1".repeat(16)))
        assertFalse(RegistrationForm.validPhone("123456x7"))
        assertTrue(RegistrationForm.validEmail("a@b.co"))
        for (bad in listOf("a@b", "@b.co", "a@@b.co", "a b@c.co", "a@b.", "a@.co")) assertFalse(bad, RegistrationForm.validEmail(bad))
    }

    // --- who to notify ---

    private val contacts = listOf(
        EmergencyContact(0, "Uno", sms = "1", voice = "1"),
        EmergencyContact(1, "Dos", email = "d@example.com"),
        EmergencyContact(2, "Tres", sms = "3")
    )

    @Test
    fun `contact mask has one bit per selected index`() {
        assertEquals(0, SosContacts.mask(emptySet()))
        assertEquals(0b101, SosContacts.mask(setOf(0, 2)))
        assertEquals(1 shl 31, SosContacts.mask(setOf(31)))
    }

    @Test
    fun `channels are those some selected contact can receive`() {
        assertEquals(Channels.SMS or Channels.VOICE, SosContacts.channels(contacts, setOf(0)))
        assertEquals(Channels.EMAIL, SosContacts.channels(contacts, setOf(1)))
        assertEquals(Channels.SMS or Channels.EMAIL or Channels.VOICE, SosContacts.channels(contacts, setOf(0, 1, 2)))
        assertEquals(0, SosContacts.channels(contacts, emptySet()))
        assertEquals(Channels.SMS, SosContacts.channels(contacts, setOf(2, 99)))
    }
}
