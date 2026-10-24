package com.baliza.emergency.egress

import com.baliza.emergency.EmergencyMeshTransport
import com.baliza.emergency.ReceivedEmergencyPacket
import com.baliza.emergency.SendResult
import com.baliza.emergency.codec.EmergencyCodec
import com.baliza.emergency.codec.EmergencyPacket
import com.baliza.emergency.codec.EmergencyType
import com.baliza.emergency.crypto.Ed25519
import com.baliza.emergency.crypto.SealedBox
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.emptyFlow

/** Synthetic packets and fakes shared by the egress tests. */
object EgressFixtures {
    val user = Ed25519.keyPairFromSeed(ByteArray(32) { 1 })
    val server = Ed25519.keyPairFromSeed(ByteArray(32) { 5 })
    val serverSeal = SealedBox.generateKeyPair()
    val userSenderHex = hex(Ed25519.senderId(user.publicKey))
    val serverSenderId = Ed25519.senderId(server.publicKey)

    fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
    fun incident(n: Int) = ByteArray(8) { n.toByte() }

    // Sealing uses a random ephemeral key, so the same call would give different bytes; tests compare bytes.
    private val made = HashMap<String, ByteArray>()

    fun sos(incident: ByteArray = incident(3), seq: Int = 1, ttl: Int = 7, type: EmergencyType = EmergencyType.SOS): ByteArray =
        made.getOrPut("${hex(incident)}/$seq/$ttl/$type") { buildSos(incident, seq, ttl, type) }.copyOf()

    private fun buildSos(incident: ByteArray, seq: Int, ttl: Int, type: EmergencyType): ByteArray {
        val packet = EmergencyPacket(
            type = type, ttl = ttl, incidentId = incident, seq = seq, category = 1, severity = 3, timestamp = 1_798_200_000L,
            senderId = Ed25519.senderId(user.publicKey), publicText = "SOS medico",
            sealedBlob = SealedBox.seal(ByteArray(20), serverSeal.publicKey)
        )
        return EmergencyCodec.encode(EmergencyCodec.sign(packet, user.seed))
    }

    fun ack(incident: ByteArray = incident(3), code: Int = 2, seq: Int = 1, signer: Ed25519.KeyPair = server): ByteArray =
        EmergencyCodec.encode(EmergencyCodec.sign(
            EmergencyPacket(EmergencyType.ACK, 7, incident, seq, category = code, timestamp = 1_798_200_040L,
                senderId = Ed25519.senderId(signer.publicKey), publicText = "ok"),
            signer.seed))

    /** A mesh that records what is sent and lets the test "hear" packets. */
    class FakeMesh : EmergencyMeshTransport {
        val sent = mutableListOf<Pair<ByteArray, Int>>()
        var result = SendResult.SENT
        private val flow = MutableSharedFlow<ReceivedEmergencyPacket>(extraBufferCapacity = 32)
        override val incoming = flow
        override val newNeighbors = emptyFlow<Unit>()
        override suspend fun send(payload: ByteArray, ttl: Int): SendResult { sent += payload.copyOf() to ttl; return result }
        fun hear(payload: ByteArray, envelopeTtl: Int = 5) = flow.tryEmit(ReceivedEmergencyPacket(payload, envelopeTtl, "00", "AA"))
    }

    class Upload(val packet: ByteArray, val egressId: String, val envelopeTtl: Int, val rxAt: Long)

    /** A backend that answers what the test says and remembers what it was asked. */
    class FakeApi : EgressApi {
        val uploads = mutableListOf<Upload>()
        val polls = mutableListOf<List<MailboxQuery>>()
        var onUpload: (ByteArray) -> UploadResult = { UploadResult.Accepted("accepted", ack(EmergencyCodec.decode(it).incidentId)) }
        var onPoll: (List<MailboxQuery>) -> PollResult = { PollResult.Messages(emptyList()) }
        override suspend fun upload(packet: ByteArray, egressId: String, envelopeTtl: Int, rxAtSeconds: Long): UploadResult {
            uploads += Upload(packet.copyOf(), egressId, envelopeTtl, rxAtSeconds)
            return onUpload(packet)
        }
        override suspend fun pollMailbox(queries: List<MailboxQuery>): PollResult { polls += queries; return onPoll(queries) }
    }

    class MemoryStore : OutboxStore {
        var saved: List<OutboxEntry> = emptyList()
        override fun load() = saved
        override fun save(entries: List<OutboxEntry>) { saved = entries.toList() }
    }
}
