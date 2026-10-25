package com.baliza.emergency.ask

/** Where a question to the AI is, in the words the user needs (docs/contrato.md §7.1). */
enum class AskState {
    /** Nothing in flight. */
    IDLE,

    /** Handed to the mesh, no ACK from the server yet. */
    SENDING,

    /** The server has it ("Recibido. Consultando a la IA"); the answer comes later. */
    ACCEPTED,

    /** CMD_RESULT status 0. */
    ANSWERED,

    /** Status 1, or an ACK refusing to read the question. Final; the text says why. */
    REJECTED,

    /** Status 2: the AI failed, took over 15 s or the server restarted. Worth asking again. */
    FAILED,

    /** Status 3: the feature is switched off on the server. */
    DISABLED,

    /** Gave up resending without ever getting an ACK. */
    STOPPED
}

class AskStatus(
    val state: AskState = AskState.IDLE,
    val question: String = "",
    /** The AI's answer, or the server's reason when [state] is a refusal. Plain text from the server. */
    val text: String = "",
    /** Times the packet was handed to the mesh. */
    val attempts: Int = 0
) {
    /** A question is on its way: no other one may start. */
    val busy: Boolean get() = state == AskState.SENDING || state == AskState.ACCEPTED
}

sealed interface AskStart {
    object Started : AskStart

    /** One question at a time. */
    object Busy : AskStart

    /** Nothing to seal to: the user has not registered with a server yet. */
    object NotRegistered : AskStart

    /** CMD belongs to an incident the server has acknowledged. */
    object NoIncident : AskStart

    class Invalid(val reason: String) : AskStart
}

/** What must survive a restart so a question never reuses a `seq` or a `ref` the server already saw. */
class AskCounters(
    /** Highest `seq` used per incident (hex). The SOS itself is 1. */
    val lastSeq: Map<String, Int> = emptyMap(),
    /** `ref`s already spent, newest last. The server never answers the same `(sender, ref)` twice. */
    val usedRefs: List<Int> = emptyList()
)

interface AskStore {
    fun load(): AskCounters
    fun save(counters: AskCounters)
}

object NoAskStore : AskStore {
    private var kept = AskCounters()
    override fun load() = kept
    override fun save(counters: AskCounters) { kept = counters }
}
