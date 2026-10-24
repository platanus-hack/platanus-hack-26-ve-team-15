package com.baliza.emergency.app

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import com.baliza.emergency.identity.SecurePrefs
import com.baliza.emergency.registration.EmergencyContact
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** The user's name and emergency contacts as typed in, kept on the phone even if registering failed. */
class ContactProfile(val displayName: String, val contacts: List<EmergencyContact>)

/**
 * Local copy of the contacts, in encrypted preferences (phone numbers and emails are personal data).
 * The SOS screen needs it to turn "tell Mamá" into a contact index, and registration retries need it
 * because the first attempt often happens without internet.
 */
class ContactStore private constructor(private val prefs: SharedPreferences) {

    fun save(profile: ContactProfile) = prefs.edit {
        val array = JSONArray()
        for (c in profile.contacts) {
            array.put(
                JSONObject()
                    .put("index", c.index).put("name", c.name).put("relation", c.relation).put("lang", c.lang)
                    .put("sms", c.sms ?: JSONObject.NULL).put("email", c.email ?: JSONObject.NULL).put("voice", c.voice ?: JSONObject.NULL)
            )
        }
        putString(KEY, JSONObject().put("name", profile.displayName).put("contacts", array).toString())
    }

    /** Null when nothing was saved or what is stored cannot be read. */
    fun load(): ContactProfile? = try {
        val root = JSONObject(prefs.getString(KEY, null) ?: return null)
        val array = root.getJSONArray("contacts")
        val contacts = (0 until array.length()).map {
            val o = array.getJSONObject(it)
            EmergencyContact(
                index = o.getInt("index"),
                name = o.getString("name"),
                relation = o.optString("relation", ""),
                lang = o.optString("lang", "es"),
                sms = o.optString("sms").takeIf { v -> v.isNotBlank() && !o.isNull("sms") },
                email = o.optString("email").takeIf { v -> v.isNotBlank() && !o.isNull("email") },
                voice = o.optString("voice").takeIf { v -> v.isNotBlank() && !o.isNull("voice") }
            )
        }
        ContactProfile(root.getString("name"), contacts)
    } catch (_: JSONException) {
        null
    }

    fun clear() = prefs.edit { clear() }

    companion object {
        private const val KEY = "profile"
        fun create(context: Context) = ContactStore(SecurePrefs.create(context, "baliza_contacts"))
        internal fun forTesting(prefs: SharedPreferences) = ContactStore(prefs)
    }
}
