package com.baliza.emergency.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.os.SystemClock
import androidx.core.content.ContextCompat
import com.baliza.emergency.sos.SosLocation
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/**
 * One location fix for an SOS. A missing fix is not an error: the SOS goes out without a location.
 * This ignores bitchat's "live location" privacy switch on purpose; the user just asked for help.
 */
class SosLocationProvider(private val context: Context) {

    suspend fun current(): SosLocation? {
        if (!hasPermission()) return null
        val fresh = withTimeoutOrNull(FRESH_FIX_TIMEOUT_MS) { freshFix() }
        return (fresh ?: lastKnown())?.let(::toSosLocation)
    }

    private fun hasPermission() =
        listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION).any {
            ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
        }

    @SuppressLint("MissingPermission")
    private suspend fun freshFix(): Location? = suspendCancellableCoroutine { cont ->
        val token = CancellationTokenSource()
        cont.invokeOnCancellation { token.cancel() }
        try {
            LocationServices.getFusedLocationProviderClient(context)
                .getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, token.token)
                .addOnSuccessListener { if (cont.isActive) cont.resume(it) }
                .addOnFailureListener { if (cont.isActive) cont.resume(null) }
        } catch (_: Exception) {
            if (cont.isActive) cont.resume(null)
        }
    }

    @SuppressLint("MissingPermission")
    private suspend fun lastKnown(): Location? = suspendCancellableCoroutine { cont ->
        try {
            LocationServices.getFusedLocationProviderClient(context).lastLocation
                .addOnSuccessListener { if (cont.isActive) cont.resume(it) }
                .addOnFailureListener { if (cont.isActive) cont.resume(null) }
        } catch (_: Exception) {
            if (cont.isActive) cont.resume(null)
        }
    }

    internal companion object {
        const val FRESH_FIX_TIMEOUT_MS = 8_000L

        /** Fix age comes from the monotonic clock, not from `Location.time`, which can be wrong or zero. */
        fun toSosLocation(loc: Location, nowElapsedNanos: Long = SystemClock.elapsedRealtimeNanos()) = SosLocation(
            latitude = loc.latitude,
            longitude = loc.longitude,
            accuracyM = if (loc.hasAccuracy()) loc.accuracy.toInt().coerceIn(0, 0xFFFF) else 0,
            fixAgeSeconds = ((nowElapsedNanos - loc.elapsedRealtimeNanos) / 1_000_000_000L).toInt().coerceIn(0, 0xFFFF)
        )
    }
}
