package com.baliza.emergency.crypto

import org.bouncycastle.crypto.agreement.X25519Agreement
import org.bouncycastle.crypto.digests.Blake2bDigest
import org.bouncycastle.crypto.engines.XSalsa20Engine
import org.bouncycastle.crypto.macs.Poly1305
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.ParametersWithIV
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * libsodium-compatible `crypto_box_seal` / `crypto_box_seal_open`, used for `sealed_blob`
 * (docs/contrato.md §3.5). The backend uses libsodium, so the bytes must match exactly:
 *
 *   sealed = ephemeral_pk(32) || MAC(16) || ciphertext
 *   nonce  = BLAKE2b-192(ephemeral_pk || recipient_pk)
 *   key    = HSalsa20(X25519(ephemeral_sk, recipient_pk), 0^16)
 *   box    = XSalsa20-Poly1305(key, nonce)
 *
 * Interop is checked against libsodium output in SealedBoxTest (docs/examples/sealedbox-vectors.json).
 */
object SealedBox {
    const val KEY_BYTES = 32
    const val OVERHEAD_BYTES = 48 // 32 ephemeral key + 16 MAC
    private const val MAC_BYTES = 16
    private const val NONCE_BYTES = 24

    class KeyPair(val privateKey: ByteArray, val publicKey: ByteArray)

    fun generateKeyPair(random: SecureRandom = SecureRandom()): KeyPair {
        val priv = X25519PrivateKeyParameters(random)
        return KeyPair(priv.encoded, priv.generatePublicKey().encoded)
    }

    fun keyPairFromPrivate(privateKey: ByteArray): KeyPair {
        require(privateKey.size == KEY_BYTES) { "private key must be $KEY_BYTES bytes" }
        val priv = X25519PrivateKeyParameters(privateKey, 0)
        return KeyPair(privateKey.copyOf(), priv.generatePublicKey().encoded)
    }

    fun seal(plaintext: ByteArray, recipientPublicKey: ByteArray, random: SecureRandom = SecureRandom()): ByteArray {
        require(recipientPublicKey.size == KEY_BYTES) { "public key must be $KEY_BYTES bytes" }
        val ephemeral = generateKeyPair(random)
        val nonce = sealNonce(ephemeral.publicKey, recipientPublicKey)
        val key = boxKey(ephemeral.privateKey, recipientPublicKey)
        return ephemeral.publicKey + secretBoxSeal(plaintext, nonce, key)
    }

    /** Returns null when the box is malformed, for another key, or tampered with. Never throws. */
    fun open(sealed: ByteArray, recipientPublicKey: ByteArray, recipientPrivateKey: ByteArray): ByteArray? {
        if (sealed.size < OVERHEAD_BYTES) return null
        if (recipientPublicKey.size != KEY_BYTES || recipientPrivateKey.size != KEY_BYTES) return null
        return try {
            val ephemeralPublic = sealed.copyOfRange(0, KEY_BYTES)
            val nonce = sealNonce(ephemeralPublic, recipientPublicKey)
            val key = boxKey(recipientPrivateKey, ephemeralPublic)
            secretBoxOpen(sealed.copyOfRange(KEY_BYTES, sealed.size), nonce, key)
        } catch (_: RuntimeException) {
            null
        }
    }

    private fun sealNonce(ephemeralPublic: ByteArray, recipientPublic: ByteArray): ByteArray {
        val blake = Blake2bDigest(NONCE_BYTES * 8)
        blake.update(ephemeralPublic, 0, ephemeralPublic.size)
        blake.update(recipientPublic, 0, recipientPublic.size)
        return ByteArray(NONCE_BYTES).also { blake.doFinal(it, 0) }
    }

    /** crypto_box_beforenm: HSalsa20 over the X25519 shared secret. */
    private fun boxKey(privateKey: ByteArray, peerPublicKey: ByteArray): ByteArray {
        val agreement = X25519Agreement()
        agreement.init(X25519PrivateKeyParameters(privateKey, 0))
        val shared = ByteArray(agreement.agreementSize)
        agreement.calculateAgreement(X25519PublicKeyParameters(peerPublicKey, 0), shared, 0)
        return hsalsa20(shared, ByteArray(16))
    }

    private fun secretBoxSeal(plaintext: ByteArray, nonce: ByteArray, key: ByteArray): ByteArray {
        val engine = XSalsa20Engine()
        engine.init(true, ParametersWithIV(KeyParameter(key), nonce))
        val polyKey = ByteArray(KEY_BYTES).also { engine.processBytes(ByteArray(KEY_BYTES), 0, KEY_BYTES, it, 0) }
        val ciphertext = ByteArray(plaintext.size)
        engine.processBytes(plaintext, 0, plaintext.size, ciphertext, 0)
        return poly1305(polyKey, ciphertext) + ciphertext
    }

    private fun secretBoxOpen(box: ByteArray, nonce: ByteArray, key: ByteArray): ByteArray? {
        if (box.size < MAC_BYTES) return null
        val mac = box.copyOfRange(0, MAC_BYTES)
        val ciphertext = box.copyOfRange(MAC_BYTES, box.size)
        val engine = XSalsa20Engine()
        engine.init(false, ParametersWithIV(KeyParameter(key), nonce))
        val polyKey = ByteArray(KEY_BYTES).also { engine.processBytes(ByteArray(KEY_BYTES), 0, KEY_BYTES, it, 0) }
        if (!MessageDigest.isEqual(mac, poly1305(polyKey, ciphertext))) return null
        val plaintext = ByteArray(ciphertext.size)
        engine.processBytes(ciphertext, 0, ciphertext.size, plaintext, 0)
        return plaintext
    }

    private fun poly1305(key: ByteArray, data: ByteArray): ByteArray {
        val poly = Poly1305()
        poly.init(KeyParameter(key))
        poly.update(data, 0, data.size)
        return ByteArray(MAC_BYTES).also { poly.doFinal(it, 0) }
    }

    /** Salsa20 core with 20 rounds, returning words 0,5,10,15,6,7,8,9 (NaCl crypto_core_hsalsa20). */
    private fun hsalsa20(key: ByteArray, input: ByteArray): ByteArray {
        fun le(b: ByteArray, o: Int) =
            (b[o].toInt() and 0xff) or ((b[o + 1].toInt() and 0xff) shl 8) or
                ((b[o + 2].toInt() and 0xff) shl 16) or ((b[o + 3].toInt() and 0xff) shl 24)

        val sigma = "expand 32-byte k".toByteArray(Charsets.US_ASCII)
        val x = IntArray(16)
        x[0] = le(sigma, 0); x[5] = le(sigma, 4); x[10] = le(sigma, 8); x[15] = le(sigma, 12)
        for (i in 0 until 4) { x[1 + i] = le(key, 4 * i); x[11 + i] = le(key, 16 + 4 * i); x[6 + i] = le(input, 4 * i) }

        fun r(v: Int, n: Int) = (v shl n) or (v ushr (32 - n))
        repeat(10) {
            x[4] = x[4] xor r(x[0] + x[12], 7); x[8] = x[8] xor r(x[4] + x[0], 9)
            x[12] = x[12] xor r(x[8] + x[4], 13); x[0] = x[0] xor r(x[12] + x[8], 18)
            x[9] = x[9] xor r(x[5] + x[1], 7); x[13] = x[13] xor r(x[9] + x[5], 9)
            x[1] = x[1] xor r(x[13] + x[9], 13); x[5] = x[5] xor r(x[1] + x[13], 18)
            x[14] = x[14] xor r(x[10] + x[6], 7); x[2] = x[2] xor r(x[14] + x[10], 9)
            x[6] = x[6] xor r(x[2] + x[14], 13); x[10] = x[10] xor r(x[6] + x[2], 18)
            x[3] = x[3] xor r(x[15] + x[11], 7); x[7] = x[7] xor r(x[3] + x[15], 9)
            x[11] = x[11] xor r(x[7] + x[3], 13); x[15] = x[15] xor r(x[11] + x[7], 18)
            x[1] = x[1] xor r(x[0] + x[3], 7); x[2] = x[2] xor r(x[1] + x[0], 9)
            x[3] = x[3] xor r(x[2] + x[1], 13); x[0] = x[0] xor r(x[3] + x[2], 18)
            x[6] = x[6] xor r(x[5] + x[4], 7); x[7] = x[7] xor r(x[6] + x[5], 9)
            x[4] = x[4] xor r(x[7] + x[6], 13); x[5] = x[5] xor r(x[4] + x[7], 18)
            x[11] = x[11] xor r(x[10] + x[9], 7); x[8] = x[8] xor r(x[11] + x[10], 9)
            x[9] = x[9] xor r(x[8] + x[11], 13); x[10] = x[10] xor r(x[9] + x[8], 18)
            x[12] = x[12] xor r(x[15] + x[14], 7); x[13] = x[13] xor r(x[12] + x[15], 9)
            x[14] = x[14] xor r(x[13] + x[12], 13); x[15] = x[15] xor r(x[14] + x[13], 18)
        }
        val out = ByteArray(32)
        intArrayOf(x[0], x[5], x[10], x[15], x[6], x[7], x[8], x[9]).forEachIndexed { i, w ->
            for (b in 0 until 4) out[4 * i + b] = (w ushr (8 * b)).toByte()
        }
        return out
    }
}
