package com.baliza.emergency.app

import com.baliza.emergency.sos.SosState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SosLabelsTest {

    @Test
    fun `every state has a title and detail except idle`() {
        for (state in SosState.entries) {
            if (state == SosState.IDLE) continue
            assertTrue("$state title", SosLabels.title(state).isNotBlank())
            assertTrue("$state detail", SosLabels.detail(state).isNotBlank())
        }
    }

    @Test
    fun `nothing claims delivery before the server acknowledged`() {
        val unacknowledged = listOf(SosState.UNSENT, SosState.SENT, SosState.UNCONFIRMED, SosState.STOPPED)
        for (state in unacknowledged) {
            val text = (SosLabels.title(state) + " " + SosLabels.detail(state)).lowercase()
            assertFalse("$state must not say 'avisados'", text.contains("avisados"))
            assertFalse("$state must not say 'recibido'", text.contains("recibido"))
            assertFalse("$state must not say 'gestion'", text.contains("gestiona"))
            assertEquals("$state is still waiting", SosLabels.Tone.WAITING, SosLabels.tone(state))
        }
    }

    @Test
    fun `tones follow the state`() {
        assertEquals(SosLabels.Tone.GOOD, SosLabels.tone(SosState.RECEIVED))
        assertEquals(SosLabels.Tone.GOOD, SosLabels.tone(SosState.IN_PROGRESS))
        assertEquals(SosLabels.Tone.GOOD, SosLabels.tone(SosState.CONTACTS_NOTIFIED))
        assertEquals(SosLabels.Tone.BAD, SosLabels.tone(SosState.REJECTED))
        assertEquals(SosLabels.Tone.NEUTRAL, SosLabels.tone(SosState.IDLE))
    }

    @Test
    fun `only idle is not active`() {
        assertFalse(SosLabels.active(SosState.IDLE))
        for (state in SosState.entries.filter { it != SosState.IDLE }) assertTrue(SosLabels.active(state))
    }

    @Test
    fun `categories and severities match the contract ranges`() {
        assertEquals((1..7).toList(), SosLabels.categories.map { it.first })
        assertEquals((1..3).toList(), SosLabels.severities.map { it.first })
        assertEquals(7, SosLabels.categories.map { it.second }.toSet().size)
    }
}
