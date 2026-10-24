package com.baliza.emergency.egress

import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.Base64

sealed interface UploadResult {
    /** The server took the packet (or already had it). [ackPacket] is the signed ACK, null if absent. */
    class Accepted(val status: String, val ackPacket: ByteArray?) : UploadResult

    /** Nothing was decided: no connection, a 5xx, or 429. Keep the packet and try again later. */
    class Retry(val reason: String) : UploadResult

    /** The server will never take this packet (any other 4xx, e.g. 404 unknown sender, 401 bad signature). */
    class Discard(val httpCode: Int) : UploadResult
}

class MailboxQuery(val senderIdHex: String, val incidentIdsHex: List<String>)

class MailboxMessage(val id: String, val msgType: Int, val incidentIdHex: String, val packet: ByteArray)

sealed interface PollResult {
    class Messages(val messages: List<MailboxMessage>) : PollResult
    class Failed(val reason: String) : PollResult
}

/** The two backend calls of docs/contrato.md §4 and §5 that a phone makes while it acts as an egress. */
interface EgressApi {
    suspend fun upload(packet: ByteArray, egressId: String, envelopeTtl: Int, rxAtSeconds: Long): UploadResult
    suspend fun pollMailbox(queries: List<MailboxQuery>): PollResult
}

/** HTTP implementation. [baseUrl] is asked every time, so the debug panel can change it while running. */
class EgressClient(
    private val baseUrl: () -> String,
    private val http: OkHttpClient
) : EgressApi {
    private val gson = GsonBuilder().disableHtmlEscaping().serializeNulls().create()
    private val json = "application/json".toMediaType()

    override suspend fun upload(packet: ByteArray, egressId: String, envelopeTtl: Int, rxAtSeconds: Long): UploadResult {
        val url = endpoint("/v1/egress") ?: return UploadResult.Retry("no server configured")
        val body = JsonObject().apply {
            addProperty("packet_b64", Base64.getEncoder().encodeToString(packet))
            add("rx", JsonObject().apply {
                addProperty("egress_id", egressId)
                addProperty("envelope_ttl", envelopeTtl.coerceIn(0, 255))
                addProperty("rx_at", rxAtSeconds)
            })
        }
        return post(url, body) { code, text ->
            when {
                code == 200 -> accepted(text)
                // 429 is a limit, not a verdict on the packet: R3 says other 4xx discard, this one waits.
                code == 429 || code >= 500 -> UploadResult.Retry("http $code")
                else -> UploadResult.Discard(code)
            }
        } ?: UploadResult.Retry("network")
    }

    override suspend fun pollMailbox(queries: List<MailboxQuery>): PollResult {
        val url = endpoint("/v1/mailbox/poll") ?: return PollResult.Failed("no server configured")
        val body = JsonObject().apply {
            add("queries", JsonArray().also { array ->
                for (q in queries) array.add(JsonObject().apply {
                    addProperty("sender_id", q.senderIdHex)
                    add("incident_ids", JsonArray().also { ids -> q.incidentIdsHex.forEach(ids::add) })
                })
            })
            add("cursor", JsonNull.INSTANCE) // the cursor is global, so tracking new incidents later would skip old messages
            addProperty("limit", 200)
        }
        return post(url, body) { code, text ->
            if (code == 200) parseMessages(text) else PollResult.Failed("http $code")
        } ?: PollResult.Failed("network")
    }

    private fun endpoint(path: String): String? = baseUrl().trim().trimEnd('/').takeIf { it.isNotEmpty() }?.plus(path)

    private suspend fun <T> post(url: String, body: JsonObject, handle: (code: Int, text: String) -> T): T? {
        return withContext(Dispatchers.IO) {
            try {
                // Built inside the try: a malformed base URL makes Request.Builder throw.
                val request = Request.Builder().url(url).post(gson.toJson(body).toRequestBody(json)).build()
                http.newCall(request).execute().use { handle(it.code, it.body?.string().orEmpty()) }
            } catch (_: IOException) {
                null
            } catch (_: IllegalArgumentException) {
                null // a malformed base URL
            }
        }
    }

    private fun accepted(text: String): UploadResult = try {
        val o = JsonParser.parseString(text).asJsonObject
        val ack = o.get("ack_packet_b64")?.takeIf { !it.isJsonNull }?.asString?.let { Base64.getDecoder().decode(it) }
        UploadResult.Accepted(o.get("status")?.asString ?: "accepted", ack)
    } catch (_: RuntimeException) {
        // The server said 200 but not in the agreed shape; it still has the packet.
        UploadResult.Accepted("accepted", null)
    }

    private fun parseMessages(text: String): PollResult = try {
        val array = JsonParser.parseString(text).asJsonObject.getAsJsonArray("messages")
        PollResult.Messages(array.map {
            val m = it.asJsonObject
            MailboxMessage(
                id = m.get("id").asString,
                msgType = m.get("msg_type").asInt,
                incidentIdHex = m.get("incident_id").asString,
                packet = Base64.getDecoder().decode(m.get("packet_b64").asString)
            )
        })
    } catch (_: RuntimeException) {
        PollResult.Failed("bad response")
    }
}
