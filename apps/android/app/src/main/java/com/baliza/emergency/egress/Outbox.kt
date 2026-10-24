package com.baliza.emergency.egress

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import com.baliza.emergency.identity.SecurePrefs
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.util.Base64

/** A packet heard from someone else that could not be uploaded yet (R3). */
class OutboxEntry(
    val wire: ByteArray,
    val envelopeTtl: Int,
    val rxAtSeconds: Long,
    val addedAtMillis: Long
) {
    fun sameAs(other: OutboxEntry) = wire.contentEquals(other.wire)
}

interface OutboxStore {
    fun load(): List<OutboxEntry>
    fun save(entries: List<OutboxEntry>)
}

/** Encrypted preferences. A damaged value reads as an empty outbox. */
class PrefsOutboxStore private constructor(private val prefs: SharedPreferences) : OutboxStore {
    override fun load(): List<OutboxEntry> = try {
        val array = JSONArray(prefs.getString(KEY, null) ?: return emptyList())
        (0 until array.length()).map {
            val o = array.getJSONObject(it)
            OutboxEntry(
                Base64.getDecoder().decode(o.getString("w")), o.getInt("t"), o.getLong("r"), o.getLong("a")
            )
        }
    } catch (_: JSONException) {
        emptyList()
    } catch (_: IllegalArgumentException) {
        emptyList()
    }

    override fun save(entries: List<OutboxEntry>) = prefs.edit {
        val array = JSONArray()
        for (e in entries) {
            array.put(
                JSONObject().put("w", Base64.getEncoder().encodeToString(e.wire))
                    .put("t", e.envelopeTtl).put("r", e.rxAtSeconds).put("a", e.addedAtMillis)
            )
        }
        putString(KEY, array.toString())
    }

    companion object {
        private const val KEY = "entries"
        fun create(context: Context) = PrefsOutboxStore(SecurePrefs.create(context, "baliza_outbox"))
        internal fun forTesting(prefs: SharedPreferences) = PrefsOutboxStore(prefs)
    }
}

/**
 * Packets waiting for internet, oldest first. At most [maxEntries] and [maxAgeMs]: when full, the
 * oldest goes. The same packet is kept once (relays deliver the same retry many times).
 */
class Outbox(
    private val store: OutboxStore,
    private val nowMillis: () -> Long,
    private val maxEntries: Int = 200,
    private val maxAgeMs: Long = 24 * 60 * 60 * 1000L
) {
    private val lock = Any()
    private var entries: MutableList<OutboxEntry> = store.load().toMutableList()

    val size: Int get() = synchronized(lock) { prune(); entries.size }

    fun isEmpty() = size == 0

    fun add(entry: OutboxEntry): Boolean = synchronized(lock) {
        prune()
        if (entries.any { it.sameAs(entry) }) return false
        entries.add(entry)
        while (entries.size > maxEntries) entries.removeAt(0)
        store.save(entries)
        true
    }

    fun peek(): OutboxEntry? = synchronized(lock) { prune(); entries.firstOrNull() }

    fun remove(entry: OutboxEntry) = synchronized(lock) {
        if (entries.removeAll { it.sameAs(entry) }) store.save(entries)
    }

    private fun prune() {
        val oldest = nowMillis() - maxAgeMs
        if (entries.removeAll { it.addedAtMillis < oldest }) store.save(entries)
    }
}
