package com.baliza.emergency.registration

/** An emergency contact the backend may notify. [index] is the short number the mesh refers to. */
class EmergencyContact(
    val index: Int,
    val name: String,
    val relation: String = "",
    val lang: String = "es",
    val sms: String? = null,
    val email: String? = null,
    val voice: String? = null
) {
    val hasChannel: Boolean get() = !sms.isNullOrBlank() || !email.isNullOrBlank() || !voice.isNullOrBlank()

    companion object {
        const val MAX_INDEX = 31
        const val MAX_NAME_LENGTH = 40
    }
}

/** Per-contact verification state returned by the backend. */
class ContactStatus(val index: Int, val status: String)
