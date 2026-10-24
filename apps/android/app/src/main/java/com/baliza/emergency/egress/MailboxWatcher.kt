package com.baliza.emergency.egress

import com.baliza.emergency.codec.EmergencyPacket
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Asks the backend for what is waiting for the incidents this phone knows about (`POST /v1/mailbox/poll`,
 * docs/contrato.md §5 and §5.1 R2) and passes it on.
 *
 *  - **Own incident:** the only way "contactos avisados" ever reaches the origin, since the server's
 *    immediate ACK says "en gestión" and the later one waits in the mailbox.
 *  - **Heard incidents:** replies for someone who is out of the server's reach; they are put on the mesh.
 *
 * The cursor is global to the mailbox, so it is not used: every poll asks for everything pending and a local
 * set of message ids removes what was already handed over.
 */
class MailboxWatcher(
    private val api: EgressApi,
    private val scope: CoroutineScope,
    private val ownSenderIdHex: String,
    private val nowMillis: () -> Long,
    private val deliver: (packet: ByteArray, forOwnIncident: Boolean) -> Unit,
    private val intervalMs: Long = 20_000,
    private val heardTrackedMs: Long = 30 * 60_000L,
    private val reinjectCooldownMs: Long = 60_000
) {
    private class Heard(val senderIdHex: String, var lastHeardAt: Long)

    private val own = LinkedHashSet<String>()
    private val heard = LinkedHashMap<String, Heard>()
    private val delivered = LinkedHashSet<String>()
    private val cache = HashMap<String, MutableList<MailboxMessage>>()
    private val lastInject = HashMap<String, Long>()
    private var job: kotlinx.coroutines.Job? = null

    fun start() {
        if (job?.isActive == true) return
        job = scope.launch {
            while (true) {
                delay(intervalMs)
                pollOnce()
            }
        }
    }

    fun trackOwn(incidentIdHex: String) { own.add(incidentIdHex) }

    fun untrackOwn(incidentIdHex: String) { own.remove(incidentIdHex) }

    /** A retry or beacon from [incidentIdHex] was heard: it is still around, and may now be reachable. */
    fun noteHeard(senderIdHex: String, incidentIdHex: String) {
        if (incidentIdHex in own) return
        val now = nowMillis()
        heard.getOrPut(incidentIdHex) { Heard(senderIdHex, now) }.lastHeardAt = now
        val waiting = cache[incidentIdHex] ?: return
        if (waiting.isNotEmpty() && now - (lastInject[incidentIdHex] ?: 0) >= reinjectCooldownMs) {
            lastInject[incidentIdHex] = now
            waiting.forEach { deliver(it.packet, false) }
        }
    }

    internal suspend fun pollOnce() {
        val now = nowMillis()
        heard.entries.removeAll { now - it.value.lastHeardAt > heardTrackedMs }
        val queries = buildQueries()
        if (queries.isEmpty()) return
        val result = try {
            api.pollMailbox(queries) as? PollResult.Messages ?: return
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            return // whatever went wrong, the next interval tries again; the loop must not die
        }
        for (m in result.messages) {
            if (!delivered.add(m.id)) continue
            if (delivered.size > MAX_REMEMBERED) delivered.remove(delivered.first())
            val isOwn = m.incidentIdHex in own
            if (!isOwn) {
                cache.getOrPut(m.incidentIdHex) { mutableListOf() }.let { it.add(m); if (it.size > MAX_CACHED) it.removeAt(0) }
                lastInject[m.incidentIdHex] = now
            }
            deliver(m.packet, isOwn)
        }
    }

    private fun buildQueries(): List<MailboxQuery> {
        val queries = mutableListOf<MailboxQuery>()
        if (own.isNotEmpty()) queries += MailboxQuery(ownSenderIdHex, own.take(MAX_IDS))
        heard.entries.groupBy({ it.value.senderIdHex }, { it.key }).forEach { (sender, ids) ->
            ids.chunked(MAX_IDS).forEach { queries += MailboxQuery(sender, it) }
        }
        return queries.take(MAX_QUERIES)
    }

    companion object {
        const val MAX_QUERIES = 50
        const val MAX_IDS = 50
        private const val MAX_REMEMBERED = 1_000
        private const val MAX_CACHED = 5
        /** For callers that only have the decoded packet. */
        fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
        fun senderHex(p: EmergencyPacket) = hex(p.senderId)
    }
}
