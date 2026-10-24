package com.baliza.emergency.crypto

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Ed25519 signatures for emergency packets (docs/contrato.md §3.4).
 *
 * These keys belong to the app and are independent of bitchat's identity. BouncyCastle's
 * lightweight API is used because java.security Ed25519 needs API 33 and this app supports API 26.
 */
object Ed25519 {
    const val KEY_BYTES = 32
    const val SIGNATURE_BYTES = 64
    const val SENDER_ID_BYTES = 8

    class KeyPair(val seed: ByteArray, val publicKey: ByteArray) {
        init {
            require(seed.size == KEY_BYTES) { "seed must be $KEY_BYTES bytes" }
            require(publicKey.size == KEY_BYTES) { "public key must be $KEY_BYTES bytes" }
        }
    }

    fun generate(random: SecureRandom = SecureRandom()): KeyPair =
        keyPairFromSeed(ByteArray(KEY_BYTES).also(random::nextBytes))

    fun keyPairFromSeed(seed: ByteArray): KeyPair {
        require(seed.size == KEY_BYTES) { "seed must be $KEY_BYTES bytes" }
        val priv = Ed25519PrivateKeyParameters(seed, 0)
        return KeyPair(seed.copyOf(), priv.generatePublicKey().encoded)
    }

    fun sign(seed: ByteArray, message: ByteArray): ByteArray {
        val signer = Ed25519Signer()
        signer.init(true, Ed25519PrivateKeyParameters(seed, 0))
        signer.update(message, 0, message.size)
        return signer.generateSignature()
    }

    /** False for any malformed key or signature instead of throwing: callers drop the packet. */
    fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean {
        if (publicKey.size != KEY_BYTES || signature.size != SIGNATURE_BYTES) return false
        return try {
            val verifier = Ed25519Signer()
            verifier.init(false, Ed25519PublicKeyParameters(publicKey, 0))
            verifier.update(message, 0, message.size)
            verifier.verifySignature(signature)
        } catch (_: RuntimeException) {
            false
        }
    }

    /** `sender_id = SHA-256(ed25519_pk)[0..8]`. */
    fun senderId(publicKey: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(publicKey).copyOf(SENDER_ID_BYTES)
}
