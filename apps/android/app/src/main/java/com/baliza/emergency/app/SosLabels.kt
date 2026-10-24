package com.baliza.emergency.app

import com.baliza.emergency.sos.SosState

/** What the user is told, in Spanish. Nothing says "avisados" or "recibido" without a server ACK. */
object SosLabels {

    enum class Tone { NEUTRAL, WAITING, GOOD, BAD }

    val categories: List<Pair<Int, String>> = listOf(
        1 to "Médica", 2 to "Incendio", 3 to "Seguridad", 4 to "Accidente",
        5 to "Desastre natural", 6 to "Atrapado o perdido", 7 to "Otra"
    )

    val severities: List<Pair<Int, String>> = listOf(1 to "Moderada", 2 to "Grave", 3 to "Crítica")

    fun title(state: SosState): String = when (state) {
        SosState.IDLE -> ""
        SosState.UNSENT -> "Buscando a alguien cerca"
        SosState.SENT -> "Enviado a la red"
        SosState.UNCONFIRMED -> "Sin confirmación todavía"
        SosState.RECEIVED -> "Recibido por el servidor"
        SosState.IN_PROGRESS -> "Tu aviso se está gestionando"
        SosState.CONTACTS_NOTIFIED -> "Tus contactos fueron avisados"
        SosState.REJECTED -> "El servidor rechazó el aviso"
        SosState.STOPPED -> "Dejé de reintentar"
    }

    fun detail(state: SosState): String = when (state) {
        SosState.IDLE -> ""
        SosState.UNSENT -> "No hay nadie en rango todavía. Sigo intentándolo."
        SosState.SENT -> "Salió por Bluetooth. Espero la confirmación del servidor."
        SosState.UNCONFIRMED -> "Nadie ha confirmado aún. Sigo reintentando."
        SosState.RECEIVED -> "El servidor tiene tu aviso."
        SosState.IN_PROGRESS -> "El agente está avisando a tus contactos."
        SosState.CONTACTS_NOTIFIED -> "Mantente en un lugar seguro. Si llega una respuesta, aparecerá aquí."
        SosState.REJECTED -> "Intenta de nuevo o pide ayuda por otro medio."
        SosState.STOPPED -> "Volveré a intentarlo en cuanto detecte a alguien cerca."
    }

    fun tone(state: SosState): Tone = when (state) {
        SosState.IDLE -> Tone.NEUTRAL
        SosState.UNSENT, SosState.SENT, SosState.UNCONFIRMED, SosState.STOPPED -> Tone.WAITING
        SosState.RECEIVED, SosState.IN_PROGRESS, SosState.CONTACTS_NOTIFIED -> Tone.GOOD
        SosState.REJECTED -> Tone.BAD
    }

    /** One line for the debug panel about the mesh test packet. */
    fun testLine(state: SosState, attempts: Int): String = when (state) {
        SosState.IDLE -> "Prueba: sin enviar"
        SosState.UNSENT -> "Prueba: ningún vecino la aceptó (intentos $attempts)"
        SosState.SENT -> "Prueba: aceptada por un vecino (intentos $attempts)"
        SosState.UNCONFIRMED -> "Prueba: enviada, sin respuesta, como se espera (intentos $attempts)"
        SosState.STOPPED -> "Prueba: dejó de reintentar (intentos $attempts)"
        else -> "Prueba: ${title(state)} (intentos $attempts)"
    }

    /** True while the phone is still resending, so the screen should offer to cancel. */
    fun active(state: SosState): Boolean = state != SosState.IDLE
}
