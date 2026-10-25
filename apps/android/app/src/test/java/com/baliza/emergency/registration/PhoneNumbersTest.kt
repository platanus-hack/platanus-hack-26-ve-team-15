package com.baliza.emergency.registration

import org.junit.Assert.assertEquals
import org.junit.Test

class PhoneNumbersTest {
    // Same rows as backend/test/phones.test.js: the phone and the server must agree.
    private val cases = listOf(
        "04148539491" to "584148539491",
        "0414-853-9491" to "584148539491",
        "(0414) 853.94.91" to "584148539491",
        "4148539491" to "584148539491",
        "+584148539491" to "584148539491",
        "+58 414 853 9491" to "584148539491",
        "584148539491" to "584148539491",
        "+580414 8539491" to "584148539491",
        "5804148539491" to "584148539491",
        "0058 414 853 9491" to "584148539491",
        "00580414 853 9491" to "584148539491",
        "0212-555-1234" to "582125551234",
        "+56 9 2040 3095" to "56920403095",
        "56920403095" to "56920403095",
        "+1 205-855-3931" to "12058553931",
        "+58 000-0000001" to "580000000001",
        "" to "",
        "sin número" to ""
    )

    @Test
    fun `phones become the international digits WhatsApp accepts, with the formats of Venezuela`() {
        for ((raw, expected) in cases) assertEquals("«$raw»", expected, PhoneNumbers.digits(raw))
    }

    @Test
    fun `the stored form carries a plus, and nothing when there are no digits`() {
        assertEquals("+584148539491", PhoneNumbers.international("0414 853 9491"))
        assertEquals("", PhoneNumbers.international("  "))
    }
}
