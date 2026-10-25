package com.baliza.emergency.app

/** Turns what the phone's address book returns into what the registration form accepts. */
object ContactBook {
    private const val MAX_NAME_CHARS = 40

    /** "+58 (412) 555-1234" → "+584125551234": digits only, keeping a leading plus. */
    fun cleanPhone(raw: String): String {
        val trimmed = raw.trim()
        val digits = trimmed.filter { it.isDigit() }
        return if (trimmed.startsWith("+")) "+$digits" else digits
    }

    fun cleanName(raw: String): String = raw.replace(Regex("\\s+"), " ").trim().take(MAX_NAME_CHARS)
}
