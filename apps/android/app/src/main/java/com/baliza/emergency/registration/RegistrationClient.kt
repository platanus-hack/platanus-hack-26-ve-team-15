package com.baliza.emergency.registration

import com.baliza.emergency.identity.ServerKeys
import com.baliza.emergency.identity.UserIdentity
import com.baliza.emergency.crypto.Ed25519
import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.TimeUnit

sealed interface RegistrationResult {
    class Success(
        val senderIdHex: String,
        val server: ServerKeys,
        val contacts: List<ContactStatus>
    ) : RegistrationResult

    /** The server answered with an error status. */
    class Rejected(val httpCode: Int, val detail: String) : RegistrationResult

    /** No answer (offline, timeout, DNS). Safe to retry later. */
    class Network(val cause: IOException) : RegistrationResult

    /** The server answered 201 but not with what the contract says. Do not trust it. */
    class BadResponse(val reason: String) : RegistrationResult

    /** Checked before sending anything. */
    class InvalidInput(val reason: String) : RegistrationResult

    /** The server's keys differ from the ones pinned at the first registration. */
    class ServerKeyChanged : RegistrationResult
}

/**
 * Online registration, `POST /v1/users` (docs/contrato.md §6): proves possession of the signing key
 * with `X-Baliza-Signature = base64(Ed25519(sk, SHA-256(body)))` over the exact bytes sent.
 */
class RegistrationClient(
    baseUrl: String,
    private val http: OkHttpClient = defaultClient()
) {
    private val url = baseUrl.trimEnd('/') + "/v1/users"
    private val gson = GsonBuilder().disableHtmlEscaping().create()
    private val b64 = Base64.getEncoder()

    /**
     * @param pinnedServer keys saved by an earlier registration; the response must match them.
     */
    suspend fun register(
        identity: UserIdentity,
        displayName: String,
        contacts: List<EmergencyContact>,
        pinnedServer: ServerKeys? = null
    ): RegistrationResult {
        validate(displayName, contacts)?.let { return RegistrationResult.InvalidInput(it) }

        val body = buildBody(identity, displayName, contacts).toByteArray(Charsets.UTF_8)
        val digest = MessageDigest.getInstance("SHA-256").digest(body)
        val request = Request.Builder()
            .url(url)
            .header("X-Baliza-Pubkey", b64.encodeToString(identity.signPublicKey))
            .header("X-Baliza-Signature", b64.encodeToString(Ed25519.sign(identity.signSeed, digest)))
            .post(body.toRequestBody(JSON))
            .build()

        return withContext(Dispatchers.IO) {
            try {
                http.newCall(request).execute().use { response ->
                    val text = response.body?.string().orEmpty()
                    if (response.code != 201) {
                        RegistrationResult.Rejected(response.code, text.take(MAX_DETAIL))
                    } else {
                        parse(text, identity, pinnedServer)
                    }
                }
            } catch (e: IOException) {
                RegistrationResult.Network(e)
            }
        }
    }

    private fun validate(displayName: String, contacts: List<EmergencyContact>): String? {
        if (displayName.isBlank()) return "display_name is empty"
        if (contacts.isEmpty()) return "at least one emergency contact is required"
        if (contacts.map { it.index }.toSet().size != contacts.size) return "duplicate contact index"
        for (c in contacts) {
            if (c.index !in 0..EmergencyContact.MAX_INDEX) return "contact index ${c.index} out of 0..${EmergencyContact.MAX_INDEX}"
            if (c.name.isBlank() || c.name.length > EmergencyContact.MAX_NAME_LENGTH) return "contact ${c.index} has an invalid name"
            if (!c.hasChannel) return "contact ${c.index} has no channel"
        }
        return null
    }

    private fun buildBody(identity: UserIdentity, displayName: String, contacts: List<EmergencyContact>): String {
        val root = JsonObject()
        root.addProperty("display_name", displayName)
        root.addProperty("sign_pk_b64", b64.encodeToString(identity.signPublicKey))
        root.addProperty("seal_pk_b64", b64.encodeToString(identity.sealPublicKey))
        val array = JsonArray()
        for (c in contacts) {
            val channels = JsonObject()
            c.sms?.takeIf { it.isNotBlank() }?.let { channels.addProperty("sms", it) }
            c.email?.takeIf { it.isNotBlank() }?.let { channels.addProperty("email", it) }
            c.voice?.takeIf { it.isNotBlank() }?.let { channels.addProperty("voice", it) }
            val contact = JsonObject()
            contact.addProperty("index", c.index)
            contact.addProperty("name", c.name)
            contact.addProperty("relation", c.relation)
            contact.addProperty("lang", c.lang)
            contact.add("channels", channels)
            array.add(contact)
        }
        root.add("contacts", array)
        return gson.toJson(root)
    }

    private fun parse(text: String, identity: UserIdentity, pinned: ServerKeys?): RegistrationResult {
        val json = try {
            JsonParser.parseString(text).asJsonObject
        } catch (_: RuntimeException) {
            return RegistrationResult.BadResponse("body is not a JSON object")
        }
        return try {
            val senderId = json.get("sender_id").asString
            if (senderId != identity.senderIdHex) {
                return RegistrationResult.BadResponse("sender_id does not match our key")
            }
            val server = json.getAsJsonObject("server")
            val keys = ServerKeys(
                keyId = server.get("key_id").asString,
                signPublicKey = key(server, "sign_pk_b64") ?: return RegistrationResult.BadResponse("bad server sign_pk"),
                sealPublicKey = key(server, "seal_pk_b64") ?: return RegistrationResult.BadResponse("bad server seal_pk")
            )
            if (pinned != null && !pinned.sameKeysAs(keys)) return RegistrationResult.ServerKeyChanged()
            val statuses = json.getAsJsonArray("contacts").map {
                val o = it.asJsonObject
                ContactStatus(o.get("index").asInt, o.get("status").asString)
            }
            RegistrationResult.Success(senderId, keys, statuses)
        } catch (_: RuntimeException) {
            // Missing field, wrong type, bad number...
            RegistrationResult.BadResponse("response does not follow the contract")
        }
    }

    private fun key(obj: JsonObject, field: String): ByteArray? = try {
        Base64.getDecoder().decode(obj.get(field).asString).takeIf { it.size == Ed25519.KEY_BYTES }
    } catch (_: RuntimeException) {
        null
    }

    companion object {
        private val JSON = "application/json".toMediaType()
        private const val MAX_DETAIL = 300

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .callTimeout(25, TimeUnit.SECONDS)
            .build()
    }
}
