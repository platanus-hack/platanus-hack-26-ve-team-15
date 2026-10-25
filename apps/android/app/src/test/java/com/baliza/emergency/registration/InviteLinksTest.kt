package com.baliza.emergency.registration

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URLDecoder

class InviteLinksTest {
    private fun textOf(link: String) = URLDecoder.decode(link.substringAfter("?text="), "UTF-8")

    @Test
    fun `the accept link writes ACEPTO and the code to Baliza's number`() {
        val link = InviteLinks.acceptLink("+56 9 2040-3095", "K7M2QX9P")
        assertEquals("https://wa.me/56920403095?text=ACEPTO%20K7M2QX9P", link)
        assertEquals("ACEPTO K7M2QX9P", textOf(link))
    }

    @Test
    fun `the invitation goes to the contact and carries the accept link intact after decoding`() {
        val accept = InviteLinks.acceptLink("+56920403095", "K7M2QX9P")
        val share = InviteLinks.shareLink("+58 (412) 555-0001", InviteLinks.message("José & Ana Pérez", accept))!!
        assertTrue(share, share.startsWith("https://wa.me/584125550001?text="))
        assertFalse("spaces are %20, not +", share.contains("+"))
        val message = textOf(share)
        assertTrue(message, message.startsWith("Hola, soy José & Ana Pérez."))
        assertTrue("the inner link survives one decoding", message.endsWith(accept))
        assertEquals("ACEPTO K7M2QX9P", textOf(message.substringAfter("toca este enlace y envía el mensaje que aparece: ")))
    }

    @Test
    fun `a phone without digits cannot be invited`() {
        assertNull(InviteLinks.shareLink("sin número", "hola"))
        assertNull(InviteLinks.shareLink("", "hola"))
    }
}
