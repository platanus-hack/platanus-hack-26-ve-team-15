package com.baliza.emergency.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ContactBookTest {
    @Test
    fun `phone keeps only digits and a leading plus`() {
        assertEquals("+58412555123", ContactBook.cleanPhone(" +58 (412) 555-1.23 "))
        assertEquals("04125551234", ContactBook.cleanPhone("0412-555 1234"))
        assertEquals("5551234", ContactBook.cleanPhone("555+1234"))
    }

    @Test
    fun `cleaned phones pass the registration check`() {
        assertTrue(RegistrationForm.validPhone(ContactBook.cleanPhone("+58 (412) 555-1234")))
    }

    @Test
    fun `name collapses spaces and is cut to the form limit`() {
        assertEquals("Ana María", ContactBook.cleanName("  Ana \n María "))
        assertEquals(40, ContactBook.cleanName("x".repeat(60)).length)
    }
}
