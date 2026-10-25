package com.baliza.emergency.registration

import java.net.URLEncoder

/**
 * The WhatsApp links of an invitation. The user sends [message] to the contact from their own WhatsApp; it carries
 * [acceptLink], which opens a chat with Baliza with "ACEPTO <code>" already written, so the contact only taps send.
 */
object InviteLinks {
    fun acceptLink(balizaNumber: String, code: String): String = waMe(balizaNumber, "ACEPTO $code")

    fun message(userName: String, acceptLink: String): String =
        "Hola, soy $userName. Te agregué como contacto de emergencia en Baliza Vital: si algún día pido ayuda, " +
            "incluso sin internet, te avisarán por aquí. Si aceptas, toca este enlace y envía el mensaje que aparece: $acceptLink"

    /**
     * Opens a chat with [contactPhone] with [text] written, when the number is international ("+58 412…"). A local
     * one ("0412…", common in an address book) cannot be turned into a WhatsApp chat without guessing the country,
     * so WhatsApp's own chat picker opens instead and the user chooses the contact.
     */
    fun shareLink(contactPhone: String, text: String): String {
        val international = contactPhone.trim().startsWith("+") && digits(contactPhone).isNotEmpty()
        return if (international) waMe(contactPhone, text) else "https://wa.me/?text=${encode(text)}"
    }

    private fun waMe(phone: String, text: String) = "https://wa.me/${digits(phone)}?text=${encode(text)}"

    /** wa.me wants %20, not the + that URLEncoder writes for a space. */
    private fun encode(text: String) = URLEncoder.encode(text, Charsets.UTF_8.name()).replace("+", "%20")

    private fun digits(phone: String) = phone.filter(Char::isDigit)
}
