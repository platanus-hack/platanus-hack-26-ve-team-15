package com.baliza.emergency.registration

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import com.baliza.emergency.identity.SecurePrefs
import org.json.JSONException
import org.json.JSONObject

/** The invite code of each contact, as the last registration returned them. Index → code. */
interface InviteStore {
    fun load(): Map<Int, String>
    fun save(codes: Map<Int, String>)
}

class PrefsInviteStore private constructor(private val prefs: SharedPreferences) : InviteStore {
    override fun load(): Map<Int, String> = try {
        val o = JSONObject(prefs.getString(KEY, null) ?: return emptyMap())
        o.keys().asSequence().associate { it.toInt() to o.getString(it) }
    } catch (_: JSONException) {
        emptyMap()
    } catch (_: NumberFormatException) {
        emptyMap()
    }

    override fun save(codes: Map<Int, String>) = prefs.edit {
        putString(KEY, JSONObject().also { o -> codes.forEach { (i, c) -> o.put(i.toString(), c) } }.toString())
    }

    companion object {
        private const val KEY = "codes"
        fun create(context: Context) = PrefsInviteStore(SecurePrefs.create(context, "baliza_invites"))
        internal fun forTesting(prefs: SharedPreferences) = PrefsInviteStore(prefs)
    }
}
