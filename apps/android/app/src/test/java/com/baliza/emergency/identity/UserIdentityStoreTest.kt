package com.baliza.emergency.identity

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.baliza.emergency.crypto.Ed25519
import com.baliza.emergency.crypto.SealedBox
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class UserIdentityStoreTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val prefs = context.getSharedPreferences("test_identity", Context.MODE_PRIVATE)
    private lateinit var store: UserIdentityStore

    @Before
    fun setUp() {
        prefs.edit().clear().commit()
        store = UserIdentityStore.forTesting(prefs)
    }

    @Test
    fun `first call creates an identity and later calls return the same one`() {
        assertNull(store.load())
        val first = store.loadOrCreate()
        val again = UserIdentityStore.forTesting(prefs).loadOrCreate() // a fresh instance: survives restarts
        assertArrayEquals(first.signSeed, again.signSeed)
        assertArrayEquals(first.signPublicKey, again.signPublicKey)
        assertArrayEquals(first.sealPrivateKey, again.sealPrivateKey)
        assertArrayEquals(first.sealPublicKey, again.sealPublicKey)
    }

    @Test
    fun `stored keys really work`() {
        val identity = store.loadOrCreate()
        val signature = Ed25519.sign(identity.signSeed, "hola".toByteArray())
        assertTrue(Ed25519.verify(identity.signPublicKey, "hola".toByteArray(), signature))
        val sealed = SealedBox.seal("hola".toByteArray(), identity.sealPublicKey)
        assertArrayEquals("hola".toByteArray(), SealedBox.open(sealed, identity.sealPublicKey, identity.sealPrivateKey))
    }

    @Test
    fun `sender id is derived from the signing key`() {
        val identity = store.loadOrCreate()
        assertEquals(16, identity.senderIdHex.length)
        assertArrayEquals(Ed25519.senderId(identity.signPublicKey), identity.senderId)
    }

    @Test
    fun `two installs get different identities`() {
        val a = store.loadOrCreate()
        prefs.edit().clear().commit()
        val b = UserIdentityStore.forTesting(prefs).loadOrCreate()
        assertFalse(a.signPublicKey.contentEquals(b.signPublicKey))
    }

    @Test
    fun `a corrupted or inconsistent set is replaced as a whole`() {
        val original = store.loadOrCreate()
        prefs.edit().putString("sign_seed", "AAAA").commit() // wrong length
        assertNull(store.load())
        val replaced = store.loadOrCreate()
        assertFalse(original.signPublicKey.contentEquals(replaced.signPublicKey))
        assertNotNull(store.load())
    }

    @Test
    fun `public keys that do not belong to the private keys are rejected`() {
        val a = store.loadOrCreate()
        val other = Ed25519.generate()
        prefs.edit().putString("sign_public", java.util.Base64.getEncoder().encodeToString(other.publicKey)).commit()
        assertNull(store.load())
        assertFalse(store.loadOrCreate().signPublicKey.contentEquals(a.signPublicKey))
    }

    @Test
    fun `server keys are saved and a new identity forgets them`() {
        store.loadOrCreate()
        assertNull(store.serverKeys())
        val keys = ServerKeys("k1", ByteArray(32) { 1 }, ByteArray(32) { 2 })
        store.saveServerKeys(keys)
        val loaded = store.serverKeys()!!
        assertEquals("k1", loaded.keyId)
        assertTrue(loaded.sameKeysAs(keys))

        prefs.edit().putString("sign_seed", "AAAA").commit() // force a new identity
        store.loadOrCreate()
        assertNull(store.serverKeys())
    }

    @Test
    fun `wipe erases everything`() {
        store.loadOrCreate()
        store.saveServerKeys(ServerKeys("k1", ByteArray(32), ByteArray(32)))
        store.wipe()
        assertNull(store.load())
        assertNull(store.serverKeys())
    }
}
