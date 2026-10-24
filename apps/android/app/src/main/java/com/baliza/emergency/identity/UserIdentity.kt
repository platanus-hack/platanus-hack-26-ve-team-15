package com.baliza.emergency.identity

import com.baliza.emergency.crypto.Ed25519

/**
 * The user's own keys for emergency traffic (docs/contrato.md §3.4): an Ed25519 pair that signs
 * packets and an X25519 pair that servers seal replies to. Independent of bitchat's identity.
 */
class UserIdentity(
    val signSeed: ByteArray,
    val signPublicKey: ByteArray,
    val sealPrivateKey: ByteArray,
    val sealPublicKey: ByteArray
) {
    /** `SHA-256(sign_pk)[0..8]`: what the mesh and the backend call `sender_id`. */
    val senderId: ByteArray get() = Ed25519.senderId(signPublicKey)
    val senderIdHex: String get() = senderId.joinToString("") { "%02x".format(it) }
}

/** What the backend publishes at registration; pinned on first use (docs/contrato.md §6). */
class ServerKeys(
    val keyId: String,
    val signPublicKey: ByteArray,
    val sealPublicKey: ByteArray
) {
    fun sameKeysAs(other: ServerKeys) =
        signPublicKey.contentEquals(other.signPublicKey) && sealPublicKey.contentEquals(other.sealPublicKey)
}
