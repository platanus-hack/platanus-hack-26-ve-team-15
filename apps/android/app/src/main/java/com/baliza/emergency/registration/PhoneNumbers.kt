package com.baliza.emergency.registration

/**
 * Phone numbers in the international form WhatsApp (Kapso) accepts. The address book in Venezuela usually holds the
 * local number: 0414 853 9491, +58 414…, 58414…, +58 0414…, 0058 414… all become +584148539491. A number of another
 * country with '+' (or already with its code) is kept. Same rules and test rows as backend/src/phones.js.
 */
object PhoneNumbers {
    private const val VENEZUELA = "58"
    private const val NATIONAL_DIGITS = 10 // 414 853 9491, 212 555 1234

    /** "+584148539491", or "" if there are no digits. */
    fun international(raw: String, countryCode: String = VENEZUELA): String =
        digits(raw, countryCode).let { if (it.isEmpty()) "" else "+$it" }

    fun digits(raw: String, countryCode: String = VENEZUELA): String {
        val text = raw.trim()
        val d = text.filter(Char::isDigit)
        if (d.startsWith("00")) return dropTrunkZero(d.drop(2), countryCode)
        if (text.startsWith("+")) return dropTrunkZero(d, countryCode)
        return fromNational(d, countryCode) ?: dropTrunkZero(d, countryCode)
    }

    /** Without '+' or 00, "0414 853 9491" and "414 853 9491" are numbers of the country; any other length, null. */
    private fun fromNational(d: String, countryCode: String): String? = when {
        d.length == NATIONAL_DIGITS + 1 && d.startsWith("0") -> countryCode + d.drop(1)
        d.length == NATIONAL_DIGITS -> countryCode + d
        else -> null
    }

    /** "+58 0414…": the national 0 typed after the country code. Only with the length of a real number. */
    private fun dropTrunkZero(d: String, countryCode: String): String =
        if (d.length == countryCode.length + NATIONAL_DIGITS + 1 && d.startsWith(countryCode + "0")) countryCode + d.drop(countryCode.length + 1) else d
}
