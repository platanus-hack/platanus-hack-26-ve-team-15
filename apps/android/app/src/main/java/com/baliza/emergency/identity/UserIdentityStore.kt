package com.baliza.emergency.identity

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import com.baliza.emergency.crypto.Ed25519
import com.baliza.emergency.crypto.SealedBox
import java.util.Base64

/**
 * Persists the user's keys and the pinned server keys in encrypted preferences (the same scheme
 * bitchat uses for its own identity). Plain [SharedPreferences] are accepted only for tests.
 *
 * Keys are created together or not at all: a half-written or corrupted set is replaced by a fresh
 * one, which means a new identity that must register again. Call [wipe] on panic mode.
 */
class UserIdentityStore private constructor(private val prefs: SharedPreferences) {

    private val lock = Any()

    /** The existing identity, or a new one persisted before it is returned. */
    fun loadOrCreate(): UserIdentity = synchronized(lock) { load() ?: generateAndStore() }

    fun load(): UserIdentity? = synchronized(lock) {
        val seed = bytes(KEY_SIGN_SEED, Ed25519.KEY_BYTES) ?: return null
        val signPk = bytes(KEY_SIGN_PUBLIC, Ed25519.KEY_BYTES) ?: return null
        val sealSk = bytes(KEY_SEAL_PRIVATE, SealedBox.KEY_BYTES) ?: return null
        val sealPk = bytes(KEY_SEAL_PUBLIC, SealedBox.KEY_BYTES) ?: return null
        // The stored public keys must belong to the stored private keys, or the set is unusable.
        if (!Ed25519.keyPairFromSeed(seed).publicKey.contentEquals(signPk)) return null
        if (!SealedBox.keyPairFromPrivate(sealSk).publicKey.contentEquals(sealPk)) return null
        UserIdentity(seed, signPk, sealSk, sealPk)
    }

    fun serverKeys(): ServerKeys? = synchronized(lock) {
        val keyId = prefs.getString(KEY_SERVER_ID, null) ?: return null
        val sign = bytes(KEY_SERVER_SIGN, Ed25519.KEY_BYTES) ?: return null
        val seal = bytes(KEY_SERVER_SEAL, SealedBox.KEY_BYTES) ?: return null
        ServerKeys(keyId, sign, seal)
    }

    fun saveServerKeys(keys: ServerKeys) = synchronized(lock) {
        prefs.edit {
            putString(KEY_SERVER_ID, keys.keyId)
            putString(KEY_SERVER_SIGN, b64(keys.signPublicKey))
            putString(KEY_SERVER_SEAL, b64(keys.sealPublicKey))
        }
    }

    /** Erases the identity and everything learned from the server. */
    fun wipe() = synchronized(lock) { prefs.edit { clear() } }

    private fun generateAndStore(): UserIdentity {
        val signing = Ed25519.generate()
        val sealing = SealedBox.generateKeyPair()
        prefs.edit {
            putString(KEY_SIGN_SEED, b64(signing.seed))
            putString(KEY_SIGN_PUBLIC, b64(signing.publicKey))
            putString(KEY_SEAL_PRIVATE, b64(sealing.privateKey))
            putString(KEY_SEAL_PUBLIC, b64(sealing.publicKey))
            // A new identity is not registered with any server, so forget the old pin.
            remove(KEY_SERVER_ID); remove(KEY_SERVER_SIGN); remove(KEY_SERVER_SEAL)
        }
        return UserIdentity(signing.seed, signing.publicKey, sealing.privateKey, sealing.publicKey)
    }

    private fun bytes(key: String, size: Int): ByteArray? = try {
        prefs.getString(key, null)?.let(Base64.getDecoder()::decode)?.takeIf { it.size == size }
    } catch (_: IllegalArgumentException) {
        null
    }

    private fun b64(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)

    companion object {
        private const val PREFS_NAME = "baliza_identity"
        private const val KEY_SIGN_SEED = "sign_seed"
        private const val KEY_SIGN_PUBLIC = "sign_public"
        private const val KEY_SEAL_PRIVATE = "seal_private"
        private const val KEY_SEAL_PUBLIC = "seal_public"
        private const val KEY_SERVER_ID = "server_key_id"
        private const val KEY_SERVER_SIGN = "server_sign_public"
        private const val KEY_SERVER_SEAL = "server_seal_public"

        fun create(context: Context): UserIdentityStore =
            UserIdentityStore(SecurePrefs.create(context, PREFS_NAME))

        /** Test-only: plain preferences are not encrypted. */
        internal fun forTesting(prefs: SharedPreferences) = UserIdentityStore(prefs)
    }
}
