package com.baliza.emergency.replies

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import com.baliza.emergency.ReceivedEmergencyPacket
import com.baliza.emergency.codec.EmergencyCodec
import com.baliza.emergency.codec.EmergencyType
import com.baliza.emergency.crypto.Ed25519
import com.baliza.emergency.crypto.SealedBox
import com.baliza.emergency.identity.SecurePrefs
import com.baliza.emergency.identity.ServerKeys
import com.baliza.emergency.identity.UserIdentity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/** What a contact answered, as the phone shows it. [channel] is the code of docs/contrato.md §3.3: 1 sms, 2 email, 4 voice. */
class Reply(
    val incidentIdHex: String,
    val seq: Int,
    val contactIndex: Int,
    val channel: Int,
    val text: String,
    val receivedAtMillis: Long
) {
    val key: String get() = "$incidentIdHex/$seq"
}

interface ReplyStore {
    fun load(): List<Reply>
    fun save(replies: List<Reply>)
}

/** Encrypted preferences: what contacts write is personal. A damaged value reads as no replies. */
class PrefsReplyStore private constructor(private val prefs: SharedPreferences) : ReplyStore {
    override fun load(): List<Reply> = try {
        val array = JSONArray(prefs.getString(KEY, null) ?: return emptyList())
        (0 until array.length()).map {
            val o = array.getJSONObject(it)
            Reply(o.getString("i"), o.getInt("s"), o.getInt("c"), o.getInt("h"), o.getString("t"), o.getLong("a"))
        }
    } catch (_: JSONException) {
        emptyList()
    }

    override fun save(replies: List<Reply>) = prefs.edit {
        val array = JSONArray()
        for (r in replies) {
            array.put(JSONObject().put("i", r.incidentIdHex).put("s", r.seq).put("c", r.contactIndex)
                .put("h", r.channel).put("t", r.text).put("a", r.receivedAtMillis))
        }
        putString(KEY, array.toString())
    }

    companion object {
        private const val KEY = "replies"
        fun create(context: Context) = PrefsReplyStore(SecurePrefs.create(context, "baliza_replies"))
        internal fun forTesting(prefs: SharedPreferences) = PrefsReplyStore(prefs)
    }
}

/**
 * Receives the answers of the user's contacts (`MSG_IN`, docs/contrato.md §3.3), wherever they come from: the
 * mesh, when an egress carried them, or the server directly when this phone has internet.
 *
 * A reply is shown only if the server signed it, it was sealed to *this* user, and it is well formed. Its text
 * is written by a third party, so it is shown as plain text and never interpreted.
 */
class ReplyInbox(
    incoming: Flow<ReceivedEmergencyPacket>,
    private val identity: UserIdentity,
    private val serverKeys: () -> ServerKeys?,
    private val store: ReplyStore,
    scope: CoroutineScope,
    private val nowMillis: () -> Long = System::currentTimeMillis,
    private val onNew: (Reply) -> Unit = {}
) {
    private val _replies = MutableStateFlow(store.load())

    /** Newest first. */
    val replies: StateFlow<List<Reply>> = _replies.asStateFlow()

    init {
        scope.launch { incoming.collect(::onReceived) }
    }

    fun clear() {
        _replies.value = emptyList()
        store.save(emptyList())
    }

    private fun onReceived(received: ReceivedEmergencyPacket) {
        val packet = EmergencyCodec.decodeOrNull(received.payload) ?: return
        if (packet.type != EmergencyType.MSG_IN) return
        val server = serverKeys() ?: return
        if (!packet.senderId.contentEquals(Ed25519.senderId(server.signPublicKey))) return
        if (!EmergencyCodec.verify(packet, server.signPublicKey)) return
        val plain = SealedBox.open(packet.sealedBlob, identity.sealPublicKey, identity.sealPrivateKey) ?: return
        val reply = parse(packet.incidentId.joinToString("") { "%02x".format(it) }, packet.seq, plain) ?: return
        if (_replies.value.any { it.key == reply.key }) return // the same message arrives by several routes
        val updated = (listOf(reply) + _replies.value).take(MAX_KEPT)
        store.save(updated)
        _replies.value = updated
        try { onNew(reply) } catch (_: Exception) { /* a failing vibration must not lose the message */ }
    }

    /** contact_idx(1) · channel(1) · UTF-8 text. Anything else is dropped. */
    private fun parse(incidentHex: String, seq: Int, plain: ByteArray): Reply? {
        if (plain.size < 3) return null
        val contact = plain[0].toInt() and 0xFF
        val channel = plain[1].toInt() and 0xFF
        if (contact > MAX_CONTACT || channel !in VALID_CHANNELS) return null
        val text = decodeUtf8(plain, 2) ?: return null
        val clean = clean(text)
        if (clean.isEmpty()) return null
        return Reply(incidentHex, seq, contact, channel, clean, nowMillis())
    }

    companion object {
        const val MAX_KEPT = 50
        const val MAX_CHARS = 240
        private const val MAX_CONTACT = 31
        private val VALID_CHANNELS = setOf(1, 2, 4)

        /** Control characters (except new lines and tabs) removed, trimmed, capped. */
        fun clean(text: String, max: Int = MAX_CHARS): String =
            text.filter { it == '\n' || it == '\t' || it.code >= 0x20 && it.code != 0x7F }.trim().take(max)

        /** The bytes from [from] on as UTF-8, or null if they are not valid UTF-8. */
        fun decodeUtf8(bytes: ByteArray, from: Int): String? = try {
            Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes, from, bytes.size - from)).toString()
        } catch (_: CharacterCodingException) {
            null
        }
    }
}
