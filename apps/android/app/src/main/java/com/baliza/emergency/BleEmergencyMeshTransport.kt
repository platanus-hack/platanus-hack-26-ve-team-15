package com.baliza.emergency

import com.bitchat.android.mesh.BluetoothMeshService
import com.bitchat.android.mesh.EmergencyPacketSink
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

/**
 * [EmergencyMeshTransport] over bitchat's BLE mesh.
 *
 * Takes the two hooks of the mesh as functions so it can be tested without Bluetooth. Use
 * [BleEmergencyMeshTransport.over] in the app.
 */
class BleEmergencyMeshTransport(
    private val attachSink: (EmergencyPacketSink?) -> Unit,
    private val sendRaw: suspend (payload: ByteArray, ttl: UByte) -> Boolean
) : EmergencyMeshTransport, AutoCloseable {

    private val _incoming = MutableSharedFlow<ReceivedEmergencyPacket>(
        extraBufferCapacity = INCOMING_BUFFER,
        onBufferOverflow = BufferOverflow.DROP_OLDEST
    )
    override val incoming: SharedFlow<ReceivedEmergencyPacket> = _incoming

    init {
        // Runs on a per-peer mesh worker: tryEmit never suspends, so it cannot stall the mesh.
        attachSink(EmergencyPacketSink { routed ->
            _incoming.tryEmit(
                ReceivedEmergencyPacket(
                    payload = routed.packet.payload,
                    envelopeTtl = routed.packet.ttl.toInt(),
                    senderPeerId = routed.peerID,
                    linkAddress = routed.relayAddress
                )
            )
        })
    }

    override suspend fun send(payload: ByteArray, ttl: Int): SendResult {
        if (payload.isEmpty() || payload.size > EmergencyMeshTransport.MAX_PAYLOAD_BYTES) {
            return SendResult.REJECTED_INVALID
        }
        val accepted = sendRaw(payload, ttl.coerceIn(1, MAX_ENVELOPE_TTL).toUByte())
        return if (accepted) SendResult.SENT else SendResult.NO_NEIGHBOR_ACCEPTED
    }

    override fun close() = attachSink(null)

    companion object {
        private const val INCOMING_BUFFER = 64
        private const val MAX_ENVELOPE_TTL = 255

        fun over(mesh: BluetoothMeshService) = BleEmergencyMeshTransport(
            attachSink = mesh::setEmergencySink,
            sendRaw = mesh::sendEmergencyPacket
        )
    }
}
