package com.baliza.emergency.crypto

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File
import java.security.SecureRandom

/** Proves our sealed_blob is byte-compatible with libsodium's crypto_box_seal (the backend's). */
@RunWith(RobolectricTestRunner::class)
class SealedBoxTest {

    private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(2 * it, 2 * it + 2).toInt(16).toByte() }
    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    // Working dir is apps/android/app; in Docker /docs is the mounted repo docs/ folder.
    private val vectors = JSONObject(File("../../../docs/examples/sealedbox-vectors.json").readText())
    private val recipientPk = hex(vectors.getString("recipient_pk_hex"))
    private val recipientSk = hex(vectors.getString("recipient_sk_hex"))

    @Test
    fun `opens every box sealed by libsodium`() {
        val boxes = vectors.getJSONArray("boxes")
        assertEquals(5, boxes.length())
        for (i in 0 until boxes.length()) {
            val box = boxes.getJSONObject(i)
            val opened = SealedBox.open(hex(box.getString("sealed_hex")), recipientPk, recipientSk)
            assertNotNull("box $i did not open", opened)
            assertEquals("box $i", box.getString("plaintext_hex"), hex(opened!!))
        }
    }

    @Test
    fun `recipient public key matches the private key of the vectors`() {
        assertArrayEquals(recipientPk, SealedBox.keyPairFromPrivate(recipientSk).publicKey)
    }

    @Test
    fun `seal then open round-trips with the documented overhead`() {
        val keys = SealedBox.generateKeyPair()
        for (size in listOf(0, 1, 204, 264)) {
            val plaintext = ByteArray(size).also(SecureRandom()::nextBytes)
            val sealed = SealedBox.seal(plaintext, keys.publicKey)
            assertEquals(size + SealedBox.OVERHEAD_BYTES, sealed.size)
            assertArrayEquals(plaintext, SealedBox.open(sealed, keys.publicKey, keys.privateKey))
        }
    }

    @Test
    fun `sealing twice gives different boxes`() {
        val keys = SealedBox.generateKeyPair()
        val a = SealedBox.seal(byteArrayOf(1, 2, 3), keys.publicKey)
        val b = SealedBox.seal(byteArrayOf(1, 2, 3), keys.publicKey)
        assertFalse(a.contentEquals(b))
    }

    @Test
    fun `tampering with any part makes open return null`() {
        val keys = SealedBox.generateKeyPair()
        val sealed = SealedBox.seal("hola".toByteArray(), keys.publicKey)
        for (index in listOf(0, 31, 32, 47, 48, sealed.lastIndex)) {
            val bad = sealed.copyOf().also { it[index] = (it[index].toInt() xor 1).toByte() }
            assertNull("flip at $index", SealedBox.open(bad, keys.publicKey, keys.privateKey))
        }
    }

    @Test
    fun `wrong key and malformed input return null without throwing`() {
        val keys = SealedBox.generateKeyPair()
        val other = SealedBox.generateKeyPair()
        val sealed = SealedBox.seal("hola".toByteArray(), keys.publicKey)
        assertNull(SealedBox.open(sealed, other.publicKey, other.privateKey))
        assertNull(SealedBox.open(ByteArray(47), keys.publicKey, keys.privateKey))
        assertNull(SealedBox.open(sealed, ByteArray(5), keys.privateKey))
    }

    /**
     * Writes boxes sealed by this app so docs/examples/sealedbox.mjs can open them with libsodium
     * (the other direction of the interop check). See docs/examples/sealedbox.mjs.
     */
    @Test
    fun `export boxes for the libsodium check`() {
        val boxes = listOf(0, 1, 204, 264).map { size ->
            val plaintext = ByteArray(size) { (it * 7 + 3).toByte() }
            val sealed = SealedBox.seal(plaintext, recipientPk)
            """{"plaintext_hex":"${hex(plaintext)}","sealed_hex":"${hex(sealed)}"}"""
        }
        val out = File("build/interop/sealed-by-app.json")
        out.parentFile.mkdirs()
        out.writeText(
            """{"recipient_pk_hex":"${hex(recipientPk)}","recipient_sk_hex":"${hex(recipientSk)}","boxes":[${boxes.joinToString(",")}]}"""
        )
    }
}
