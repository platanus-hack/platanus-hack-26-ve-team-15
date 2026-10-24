package com.baliza.emergency.egress

import com.baliza.emergency.egress.EgressFixtures.ack
import com.baliza.emergency.egress.EgressFixtures.sos
import com.google.gson.JsonParser
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.Base64

@RunWith(RobolectricTestRunner::class)
class EgressClientTest {
    private val server = MockWebServer()
    private lateinit var client: EgressClient
    private var baseUrl = ""

    @Before fun setUp() { server.start(); baseUrl = server.url("/").toString(); client = EgressClient({ baseUrl }, OkHttpClient()) }
    @After fun tearDown() = server.close()

    private fun reply(code: Int, body: String = "{}") = server.enqueue(MockResponse.Builder().code(code).body(body).build())

    // --- POST /v1/egress ---

    @Test
    fun `upload sends what the backend parses`() = runBlocking {
        reply(200, """{"status":"accepted","incident_id":"x","seq":1,"ack_packet_b64":""}""")
        val packet = sos()
        client.upload(packet, "egress-abc", envelopeTtl = 4, rxAtSeconds = 1_798_200_042L)

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v1/egress", request.url.encodedPath)
        val body = JsonParser.parseString(request.body!!.utf8()).asJsonObject
        assertArrayEquals(packet, Base64.getDecoder().decode(body["packet_b64"].asString))
        val rx = body["rx"].asJsonObject
        assertEquals("egress-abc", rx["egress_id"].asString)
        assertEquals(4, rx["envelope_ttl"].asInt)
        assertEquals(1_798_200_042L, rx["rx_at"].asLong)
    }

    @Test
    fun `200 returns the signed ack`() = runBlocking {
        val ack = ack()
        reply(200, """{"status":"duplicate","incident_id":"x","seq":1,"ack_packet_b64":"${Base64.getEncoder().encodeToString(ack)}"}""")
        val result = client.upload(sos(), "e", 3, 1) as UploadResult.Accepted
        assertEquals("duplicate", result.status)
        assertArrayEquals(ack, result.ackPacket)
    }

    @Test
    fun `a 200 in an unexpected shape still counts as accepted but has no ack`() = runBlocking {
        for (body in listOf("", "not json", "[]", """{"status":"accepted"}""")) {
            reply(200, body)
            val result = client.upload(sos(), "e", 3, 1) as UploadResult.Accepted
            assertNull("body <$body>", result.ackPacket)
        }
    }

    @Test
    fun `limits and server errors are retried, other 4xx are final`() = runBlocking {
        for (code in listOf(429, 500, 502, 503)) { reply(code); assertTrue("$code", client.upload(sos(), "e", 3, 1) is UploadResult.Retry) }
        for (code in listOf(400, 401, 404, 422)) {
            reply(code)
            assertEquals(code, (client.upload(sos(), "e", 3, 1) as UploadResult.Discard).httpCode)
        }
    }

    @Test
    fun `no connection and no server are retried`() = runBlocking {
        server.close()
        assertTrue(client.upload(sos(), "e", 3, 1) is UploadResult.Retry)
        baseUrl = ""
        assertTrue(client.upload(sos(), "e", 3, 1) is UploadResult.Retry)
        baseUrl = "not a url"
        assertTrue(client.upload(sos(), "e", 3, 1) is UploadResult.Retry)
    }

    @Test
    fun `the base url is read on every call so the debug panel can change it`() = runBlocking {
        val other = MockWebServer().also { it.start() }
        try {
            other.enqueue(MockResponse.Builder().code(200).body("{}").build())
            baseUrl = other.url("/").toString().trimEnd('/') + "/"
            client.upload(sos(), "e", 3, 1)
            assertEquals(1, other.requestCount)
            assertEquals(0, server.requestCount)
        } finally { other.close() }
    }

    // --- POST /v1/mailbox/poll ---

    @Test
    fun `poll sends the queries with a null cursor`() = runBlocking {
        reply(200, """{"messages":[],"next_cursor":"c_0000"}""")
        client.pollMailbox(listOf(MailboxQuery("930bda7e20b63bb9", listOf("0a68279fb49bde12", "1111111111111111"))))

        val request = server.takeRequest()
        assertEquals("/v1/mailbox/poll", request.url.encodedPath)
        val body = JsonParser.parseString(request.body!!.utf8()).asJsonObject
        assertTrue("a global cursor would skip old messages", body["cursor"].isJsonNull)
        val q = body["queries"].asJsonArray[0].asJsonObject
        assertEquals("930bda7e20b63bb9", q["sender_id"].asString)
        assertEquals(listOf("0a68279fb49bde12", "1111111111111111"), q["incident_ids"].asJsonArray.map { it.asString })
    }

    @Test
    fun `poll parses the messages`() = runBlocking {
        val packet = ack()
        reply(200, """{"messages":[{"id":"m_0001","msg_type":3,"incident_id":"0303030303030303","created_at":1,"packet_b64":"${Base64.getEncoder().encodeToString(packet)}"}],"next_cursor":"c_0001"}""")
        val result = client.pollMailbox(listOf(MailboxQuery("a", listOf("b")))) as PollResult.Messages
        val m = result.messages.single()
        assertEquals("m_0001", m.id)
        assertEquals(3, m.msgType)
        assertEquals("0303030303030303", m.incidentIdHex)
        assertArrayEquals(packet, m.packet)
    }

    @Test
    fun `poll failures never throw`() = runBlocking {
        reply(500); assertTrue(client.pollMailbox(emptyList()) is PollResult.Failed)
        reply(200, "garbage"); assertTrue(client.pollMailbox(emptyList()) is PollResult.Failed)
        reply(200, """{"messages":[{"id":"m"}]}"""); assertTrue(client.pollMailbox(emptyList()) is PollResult.Failed)
        server.close(); assertTrue(client.pollMailbox(emptyList()) is PollResult.Failed)
    }
}
