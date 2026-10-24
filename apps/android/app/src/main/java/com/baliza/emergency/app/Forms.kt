package com.baliza.emergency.app

import com.baliza.emergency.registration.EmergencyContact
import com.baliza.emergency.sos.Channels

/** One contact as typed in. Blank drafts are ignored. */
class ContactDraft(val name: String = "", val phone: String = "", val email: String = "") {
    val isBlank: Boolean get() = name.isBlank() && phone.isBlank() && email.isBlank()
}

sealed interface FormResult<out T> {
    class Ok<T>(val value: T) : FormResult<T>
    class Error(val message: String) : FormResult<Nothing>
}

/** Turns what the registration screen collected into the profile the backend expects. */
object RegistrationForm {
    const val MAX_CONTACTS = 5
    private const val MIN_PHONE_DIGITS = 7
    private const val MAX_PHONE_DIGITS = 15

    fun build(displayName: String, drafts: List<ContactDraft>): FormResult<ContactProfile> {
        if (displayName.isBlank()) return FormResult.Error("Escribe tu nombre.")
        val filled = drafts.filterNot { it.isBlank }
        if (filled.isEmpty()) return FormResult.Error("Agrega al menos un contacto de emergencia.")
        if (filled.size > MAX_CONTACTS) return FormResult.Error("Máximo $MAX_CONTACTS contactos.")

        val contacts = filled.mapIndexed { i, d ->
            val label = d.name.ifBlank { "El contacto ${i + 1}" }
            if (d.name.isBlank()) return FormResult.Error("Falta el nombre del contacto ${i + 1}.")
            if (d.name.trim().length > EmergencyContact.MAX_NAME_LENGTH) return FormResult.Error("$label: nombre demasiado largo.")
            val phone = d.phone.trim()
            val email = d.email.trim()
            if (phone.isEmpty() && email.isEmpty()) return FormResult.Error("$label necesita un teléfono o un correo.")
            if (phone.isNotEmpty() && !validPhone(phone)) return FormResult.Error("$label: el teléfono no parece válido.")
            if (email.isNotEmpty() && !validEmail(email)) return FormResult.Error("$label: el correo no parece válido.")
            EmergencyContact(
                index = i,
                name = d.name.trim(),
                sms = phone.ifEmpty { null },
                voice = phone.ifEmpty { null },
                email = email.ifEmpty { null }
            )
        }
        return FormResult.Ok(ContactProfile(displayName.trim(), contacts))
    }

    internal fun validPhone(phone: String): Boolean {
        if (!phone.all { it.isDigit() || it in "+ -()" }) return false
        return phone.count { it.isDigit() } in MIN_PHONE_DIGITS..MAX_PHONE_DIGITS
    }

    internal fun validEmail(email: String): Boolean {
        val at = email.indexOf('@')
        return at > 0 && at == email.lastIndexOf('@') && email.indexOf('.', at) > at + 1 &&
            !email.endsWith(".") && email.none { it.isWhitespace() }
    }
}

/** What to tell the SOS sender about who to notify and how. */
object SosContacts {
    fun mask(selected: Set<Int>): Int = selected.fold(0) { acc, i -> acc or (1 shl i) }

    /** Channels that at least one selected contact can actually receive. */
    fun channels(contacts: List<EmergencyContact>, selected: Set<Int>): Int {
        var mask = 0
        for (c in contacts.filter { it.index in selected }) {
            if (!c.sms.isNullOrBlank()) mask = mask or Channels.SMS
            if (!c.email.isNullOrBlank()) mask = mask or Channels.EMAIL
            if (!c.voice.isNullOrBlank()) mask = mask or Channels.VOICE
        }
        return mask
    }
}
