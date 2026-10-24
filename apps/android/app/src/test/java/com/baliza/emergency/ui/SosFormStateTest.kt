package com.baliza.emergency.ui

import androidx.compose.runtime.saveable.SaverScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SosFormStateTest {

    private val canSave = SaverScope { true }

    @Test
    fun `a new form selects every contact`() {
        val form = SosFormState()
        form.reconcile(listOf(0, 1, 2))
        assertEquals(listOf(0, 1, 2), form.selected.toList())
    }

    @Test
    fun `a contact the user unticked stays unticked when the contact list is read again`() {
        val form = SosFormState()
        form.reconcile(listOf(0, 1))
        form.toggle(1) // untick the second contact on purpose
        form.reconcile(listOf(0, 1)) // e.g. back from another screen
        form.reconcile(listOf(0, 1))
        assertEquals(listOf(0), form.selected.toList())
    }

    @Test
    fun `a new contact is selected by default, the others are left as they were`() {
        val form = SosFormState()
        form.reconcile(listOf(0, 1))
        form.toggle(1)
        form.reconcile(listOf(0, 1, 2))
        assertEquals(listOf(0, 2), form.selected.toList())
    }

    @Test
    fun `a contact that no longer exists is dropped`() {
        val form = SosFormState()
        form.reconcile(listOf(0, 1, 2))
        form.reconcile(listOf(0, 2))
        assertEquals(listOf(0, 2), form.selected.toList())
    }

    @Test
    fun `unticking everyone really leaves nobody selected`() {
        val form = SosFormState()
        form.reconcile(listOf(0, 1))
        form.toggle(0); form.toggle(1)
        form.reconcile(listOf(0, 1))
        assertTrue(form.selected.isEmpty())
    }

    @Test
    fun `toggle selects and unselects`() {
        val form = SosFormState()
        form.reconcile(listOf(4))
        form.toggle(4); assertTrue(form.selected.isEmpty())
        form.toggle(4); assertEquals(listOf(4), form.selected.toList())
    }

    @Test
    fun `everything survives being saved and restored, including which contacts were unticked`() {
        val form = SosFormState()
        form.reconcile(listOf(0, 1, 2))
        form.category = 4; form.severity = 2; form.publicText = "PRUEBA"; form.note = "detalles"
        form.toggle(1)

        val saved = with(SosFormState.Saver) { canSave.save(form) }!!
        val restored = SosFormState.Saver.restore(saved)!!

        assertEquals(4, restored.category)
        assertEquals(2, restored.severity)
        assertEquals("PRUEBA", restored.publicText)
        assertEquals("detalles", restored.note)
        assertEquals(listOf(0, 2), restored.selected.toList())
        restored.reconcile(listOf(0, 1, 2)) // the unticked contact must not come back
        assertEquals(listOf(0, 2), restored.selected.toList())
    }
}
