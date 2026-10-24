package com.baliza.emergency.ui

import com.baliza.emergency.registration.RegistrationResult
import com.baliza.emergency.sos.StartResult
import com.baliza.emergency.identity.ServerKeys
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class BalizaViewModelMessagesTest {

    @Test
    fun `registration failures say what happened and whether the data was kept`() {
        val network = BalizaViewModel.registrationMessage(RegistrationResult.Network(IOException("boom")))
        assertTrue(network.contains("guardados"))
        assertTrue(BalizaViewModel.registrationMessage(RegistrationResult.Rejected(503, "x")).contains("503"))
        assertTrue(BalizaViewModel.registrationMessage(RegistrationResult.ServerKeyChanged()).contains("llaves"))
        assertTrue(BalizaViewModel.registrationMessage(RegistrationResult.BadResponse("x")).contains("inesperado"))
        assertEquals("Falta algo.", BalizaViewModel.registrationMessage(RegistrationResult.InvalidInput("Falta algo.")))
    }

    @Test
    fun `server detail is never shown to the user`() {
        val msg = BalizaViewModel.registrationMessage(RegistrationResult.Rejected(500, "SELECT * FROM secrets"))
        assertTrue(!msg.contains("SELECT"))
    }

    @Test
    fun `sos start results map to messages, success to none`() {
        assertNull(BalizaViewModel.sosMessage(StartResult.Started("ab")))
        assertTrue(BalizaViewModel.sosMessage(StartResult.NotRegistered())!!.contains("registro"))
        assertTrue(BalizaViewModel.sosMessage(StartResult.AlreadyActive("ab"))!!.contains("en curso"))
        assertTrue(BalizaViewModel.sosMessage(StartResult.Invalid("category must be 1..7"))!!.contains("category"))
    }
}
