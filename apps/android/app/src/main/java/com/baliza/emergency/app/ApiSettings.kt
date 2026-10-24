package com.baliza.emergency.app

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit

/**
 * Where the backend lives. The default comes from the build (`-PBALIZA_API_URL=...`); debug builds
 * can override it at runtime so a phone can be pointed at a laptop on the LAN without rebuilding.
 */
class ApiSettings(private val prefs: SharedPreferences, private val buildDefault: String) {

    val baseUrl: String
        get() = prefs.getString(KEY_URL, null)?.takeIf { it.isNotBlank() } ?: buildDefault

    /** @return false (and keeps the old value) if [url] is not an http(s) address. */
    fun setBaseUrl(url: String): Boolean {
        val clean = url.trim().trimEnd('/')
        if (clean.isEmpty()) {
            prefs.edit { remove(KEY_URL) }
            return true
        }
        if (!clean.startsWith("http://") && !clean.startsWith("https://")) return false
        prefs.edit { putString(KEY_URL, clean) }
        return true
    }

    companion object {
        private const val KEY_URL = "api_base_url"
        fun create(context: Context) = ApiSettings(
            context.getSharedPreferences("baliza_settings", Context.MODE_PRIVATE),
            com.bitchat.android.BuildConfig.BALIZA_API_URL
        )
    }
}
