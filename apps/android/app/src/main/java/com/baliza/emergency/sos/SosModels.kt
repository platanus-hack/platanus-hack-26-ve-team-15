package com.baliza.emergency.sos

/** Bits of the `channels` mask inside the sealed SOS plaintext (docs/contrato.md §3.3). */
object Channels {
    const val SMS = 1
    const val EMAIL = 2
    const val VOICE = 4
}

/** Where the phone is. [fixAgeSeconds] is how old the GPS fix is, saturated at 65535. */
class SosLocation(
    val latitude: Double,
    val longitude: Double,
    val accuracyM: Int,
    val fixAgeSeconds: Int = 0
)

/**
 * What the user asked for. [publicText] travels in clear and is limited to 60 bytes; [note] and the
 * contact choice are sealed to the server and share 197 bytes.
 */
class SosRequest(
    /** 1 medica, 2 incendio, 3 seguridad, 4 accidente, 5 desastre natural, 6 atrapado/perdido, 7 otra. */
    val category: Int,
    /** 1..3. */
    val severity: Int,
    val publicText: String,
    val location: SosLocation?,
    val note: String = "",
    /** Bit i set = contact with index i (0..31). */
    val contactMask: Int,
    /** Combination of [Channels]. */
    val channels: Int
)

/** What the user may be told, in the order of docs/contrato.md §5.1 R4. */
enum class SosState {
    /** No incident. */
    IDLE,

    /** Prepared but no neighbor has taken the packet yet. */
    UNSENT,

    /** At least one neighbor accepted it. This is "enviado", not "recibido". */
    SENT,

    /** 30 s passed without an ACK; still retrying. */
    UNCONFIRMED,

    /** A valid ACK from the server arrived. */
    RECEIVED,

    /** ACK code 2: the agent is working on it. */
    IN_PROGRESS,

    /** ACK code 1: contacts were notified. */
    CONTACTS_NOTIFIED,

    /** ACK code 3. Final. */
    REJECTED,

    /** Gave up retrying; resumes when a new neighbor shows up. */
    STOPPED
}

class SosStatus(
    val state: SosState,
    val incidentIdHex: String? = null,
    val seq: Int = 0,
    /** Times the packet was handed to the mesh, accepted or not. */
    val attempts: Int = 0
)

sealed interface StartResult {
    class Started(val incidentIdHex: String) : StartResult

    /** One incident at a time: cancel the current one first. */
    class AlreadyActive(val incidentIdHex: String) : StartResult

    /** Nothing to seal to: the user has not registered with a server yet. */
    class NotRegistered : StartResult

    class Invalid(val reason: String) : StartResult
}

/** Retry timing of docs/contrato.md §5.1 R1. */
class RetrySchedule(
    val fastIntervalMs: Long = 15_000,
    val fastWindowMs: Long = 120_000,
    val slowIntervalMs: Long = 60_000,
    val giveUpAfterMs: Long = 30 * 60_000,
    val unconfirmedAfterMs: Long = 30_000,
    /** Wait after a new neighbor appears before writing, so its link can finish connecting. */
    val neighborSettleMs: Long = 1_000
)
