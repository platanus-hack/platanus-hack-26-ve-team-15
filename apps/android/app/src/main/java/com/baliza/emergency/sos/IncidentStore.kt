package com.baliza.emergency.sos

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import com.baliza.emergency.identity.SecurePrefs
import java.util.Base64

/**
 * What is needed to keep resending an SOS after Android kills the process: the signed packet exactly
 * as it was first sent, and the last acknowledgement seen (null while unacknowledged).
 */
class IncidentRecord(
    val incidentId: ByteArray,
    val seq: Int,
    val wire: ByteArray,
    val ackState: SosState?
)

interface IncidentStore {
    fun save(record: IncidentRecord)
    fun load(): IncidentRecord?
    fun clear()
}

/** For callers that do not persist (and for tests). */
object NoIncidentStore : IncidentStore {
    override fun save(record: IncidentRecord) = Unit
    override fun load(): IncidentRecord? = null
    override fun clear() = Unit
}

/** One incident at a time, in encrypted preferences. A damaged record reads as "no incident". */
class PrefsIncidentStore private constructor(private val prefs: SharedPreferences) : IncidentStore {

    override fun save(record: IncidentRecord) = prefs.edit {
        putString(KEY_ID, b64(record.incidentId))
        putInt(KEY_SEQ, record.seq)
        putString(KEY_WIRE, b64(record.wire))
        if (record.ackState == null) remove(KEY_ACK) else putString(KEY_ACK, record.ackState.name)
    }

    override fun load(): IncidentRecord? = try {
        val id = prefs.getString(KEY_ID, null)?.let(Base64.getDecoder()::decode)
        val wire = prefs.getString(KEY_WIRE, null)?.let(Base64.getDecoder()::decode)
        val seq = prefs.getInt(KEY_SEQ, 0)
        if (id == null || wire == null || id.size != 8 || seq < 1) null
        else IncidentRecord(id, seq, wire, prefs.getString(KEY_ACK, null)?.let { runCatching { SosState.valueOf(it) }.getOrNull() })
    } catch (_: RuntimeException) {
        null
    }

    override fun clear() = prefs.edit { clear() }

    private fun b64(b: ByteArray) = Base64.getEncoder().encodeToString(b)

    companion object {
        private const val KEY_ID = "incident_id"
        private const val KEY_SEQ = "seq"
        private const val KEY_WIRE = "wire"
        private const val KEY_ACK = "ack_state"

        fun create(context: Context) = PrefsIncidentStore(SecurePrefs.create(context, "baliza_incident"))

        /** Test-only: plain preferences are not encrypted. */
        internal fun forTesting(prefs: SharedPreferences) = PrefsIncidentStore(prefs)
    }
}
