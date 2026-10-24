package com.baliza.emergency.registration

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.baliza.emergency.crypto.Ed25519
import com.baliza.emergency.identity.ServerKeys
import com.baliza.emergency.identity.UserIdentity
import com.baliza.emergency.identity.UserIdentityStore
import com.google.gson.JsonParser
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.security.MessageDigest
import java.util.Base64

@RunWith(RobolectricTestRunner::class)
class RegistrationClientTest {

    private val server = MockWebServer()
    private lateinit var identity: UserIdentity
    private lateinit var client: RegistrationClient
    private val b64 = Base64.getEncoder()
    private val serverSign = ByteArray(32) { 7 }
    private val serverSeal = ByteArray(32) { 9 }

    private val contacts = listOf(
        EmergencyContact(0, "Contacto Demo Uno", "familiar", sms = "+58 000-0000001", email = "contacto1@example.com", voice = "+58 000-0000001"),
        EmergencyContact(1, "Contacto Demo Dos", "amigo", sms = "+58 000-0000002")
    )

    @Before
    fun setUp() {
        val context: Context = ApplicationProvider.getApplicationContext()
        val prefs = context.getSharedPreferences("test_registration", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        identity = UserIdentityStore.forTesting(prefs).loadOrCreate()
        server.start()
        client = RegistrationClient(server.url("/").toString())
    }

    @After
    fun tearDown() = server.close()

    private fun created(senderId: String = identity.senderIdHex, serverSignPk: ByteArray = serverSign) = MockResponse.Builder()
        .code(201)
        .body(
            """{"sender_id":"$senderId","server":{"key_id":"k1","sign_pk_b64":"${b64.encodeToString(serverSignPk)}",
               "seal_pk_b64":"${b64.encodeToString(serverSeal)}"},
               "contacts":[{"index":0,"status":"pending_verification"},{"index":1,"status":"pending_verification"}]}"""
        ).build()

    @Test
    fun `sends a signed request that the backend can verify`() = runBlocking {
        server.enqueue(created())
        client.register(identity, "Usuario Demo", contacts)

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v1/users", request.url.encodedPath)
        val body = request.body!!.toByteArray()
        assertEquals(b64.encodeToString(identity.signPublicKey), request.headers["X-Baliza-Pubkey"])

        val signature = Base64.getDecoder().decode(request.headers["X-Baliza-Signature"])
        val digest = MessageDigest.getInstance("SHA-256").digest(body)
        assertTrue("signature must cover SHA-256 of the exact body", Ed25519.verify(identity.signPublicKey, digest, signature))
    }

    @Test
    fun `body follows contrato 6`() = runBlocking {
        server.enqueue(created())
        client.register(identity, "Usuario Demo", contacts)

        val json = JsonParser.parseString(server.takeRequest().body!!.utf8()).asJsonObject
        assertEquals("Usuario Demo", json["display_name"].asString)
        assertEquals(b64.encodeToString(identity.signPublicKey), json["sign_pk_b64"].asString)
        assertEquals(b64.encodeToString(identity.sealPublicKey), json["seal_pk_b64"].asString)
        val first = json["contacts"].asJsonArray[0].asJsonObject
        assertEquals(0, first["index"].asInt)
        assertEquals("Contacto Demo Uno", first["name"].asString)
        assertEquals("+58 000-0000001", first["channels"].asJsonObject["sms"].asString)
        assertEquals("contacto1@example.com", first["channels"].asJsonObject["email"].asString)
        assertEquals("+58 000-0000001", first["channels"].asJsonObject["voice"].asString)
        // a contact without email must not send an empty email channel
        assertFalse(json["contacts"].asJsonArray[1].asJsonObject["channels"].asJsonObject.has("email"))
    }

    @Test
    fun `201 returns the server keys and contact states`() = runBlocking {
        server.enqueue(created())
        val result = client.register(identity, "Usuario Demo", contacts)
        result as RegistrationResult.Success
        assertEquals(identity.senderIdHex, result.senderIdHex)
        assertEquals("k1", result.server.keyId)
        assertTrue(result.server.signPublicKey.contentEquals(serverSign))
        assertEquals(listOf(0 to "pending_verification", 1 to "pending_verification"), result.contacts.map { it.index to it.status })
    }

    @Test
    fun `a sender id that is not ours is not trusted`() = runBlocking {
        server.enqueue(created(senderId = "0000000000000000"))
        assertTrue(client.register(identity, "Usuario Demo", contacts) is RegistrationResult.BadResponse)
    }

    @Test
    fun `server keys that differ from the pinned ones are refused`() = runBlocking {
        server.enqueue(created(serverSignPk = ByteArray(32) { 1 }))
        val pinned = ServerKeys("k1", serverSign, serverSeal)
        assertTrue(client.register(identity, "Usuario Demo", contacts, pinned) is RegistrationResult.ServerKeyChanged)
    }

    @Test
    fun `same pinned keys are accepted`() = runBlocking {
        server.enqueue(created())
        val pinned = ServerKeys("k1", serverSign, serverSeal)
        assertTrue(client.register(identity, "Usuario Demo", contacts, pinned) is RegistrationResult.Success)
    }

    @Test
    fun `error statuses are reported with their code`() = runBlocking {
        for (code in listOf(400, 401, 409, 500)) {
            server.enqueue(MockResponse.Builder().code(code).body("nope").build())
            val result = client.register(identity, "Usuario Demo", contacts)
            assertEquals(code, (result as RegistrationResult.Rejected).httpCode)
        }
    }

    @Test
    fun `malformed 201 bodies are bad responses`() = runBlocking {
        for (body in listOf("", "not json", "[]", "{}", """{"sender_id":"${identity.senderIdHex}"}""")) {
            server.enqueue(MockResponse.Builder().code(201).body(body).build())
            val result = client.register(identity, "Usuario Demo", contacts)
            assertTrue("body <$body> gave $result", result is RegistrationResult.BadResponse)
        }
    }

    @Test
    fun `no connection is a network failure`() = runBlocking {
        server.close()
        assertTrue(client.register(identity, "Usuario Demo", contacts) is RegistrationResult.Network)
    }

    @Test
    fun `bad input never reaches the network`() = runBlocking {
        val bad = listOf(
            "" to contacts,
            "Usuario Demo" to emptyList(),
            "Usuario Demo" to listOf(EmergencyContact(32, "Fuera de rango", sms = "1")),
            "Usuario Demo" to listOf(EmergencyContact(0, "Uno", sms = "1"), EmergencyContact(0, "Otro", sms = "2")),
            "Usuario Demo" to listOf(EmergencyContact(0, "Sin canal")),
            "Usuario Demo" to listOf(EmergencyContact(0, " ", sms = "1"))
        )
        for ((name, list) in bad) {
            assertTrue(client.register(identity, name, list) is RegistrationResult.InvalidInput)
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `repository pins the keys on success and refuses a change later`() = runBlocking {
        val context: Context = ApplicationProvider.getApplicationContext()
        val prefs = context.getSharedPreferences("test_repo", Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        val store = UserIdentityStore.forTesting(prefs)
        val repo = RegistrationRepository(store, client)
        val id = store.loadOrCreate()

        assertFalse(repo.isRegistered())
        server.enqueue(created(senderId = id.senderIdHex))
        assertTrue(repo.register("Usuario Demo", contacts) is RegistrationResult.Success)
        assertTrue(repo.isRegistered())
        assertNotNull(store.serverKeys())

        server.enqueue(created(senderId = id.senderIdHex, serverSignPk = ByteArray(32) { 5 }))
        assertTrue(repo.register("Usuario Demo", contacts) is RegistrationResult.ServerKeyChanged)
    }
}
