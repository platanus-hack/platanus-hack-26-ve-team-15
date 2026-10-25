package com.baliza.emergency.ask

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import com.baliza.emergency.identity.SecurePrefs
import org.json.JSONException
import org.json.JSONObject

/** The question counters in encrypted preferences. A damaged value reads as empty: the next `ref` is random anyway. */
class PrefsAskStore private constructor(private val prefs: SharedPreferences) : AskStore {
    override fun load(): AskCounters = try {
        val root = JSONObject(prefs.getString(KEY, null) ?: return AskCounters())
        val seqs = root.optJSONObject("s")
        val refs = root.optJSONArray("r")
        AskCounters(
            lastSeq = seqs?.keys()?.asSequence()?.associateWith { seqs.getInt(it) } ?: emptyMap(),
            usedRefs = (0 until (refs?.length() ?: 0)).map { refs!!.getInt(it) }
        )
    } catch (_: JSONException) {
        AskCounters()
    }

    override fun save(counters: AskCounters) = prefs.edit {
        val seqs = JSONObject().also { o -> counters.lastSeq.forEach { (k, v) -> o.put(k, v) } }
        putString(KEY, JSONObject().put("s", seqs).put("r", org.json.JSONArray(counters.usedRefs)).toString())
    }

    companion object {
        private const val KEY = "counters"
        fun create(context: Context) = PrefsAskStore(SecurePrefs.create(context, "baliza_ask"))
        internal fun forTesting(prefs: SharedPreferences) = PrefsAskStore(prefs)
    }
}
