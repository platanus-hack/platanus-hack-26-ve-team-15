package com.baliza.emergency.registration

import com.baliza.emergency.identity.UserIdentityStore

/**
 * Ties identity, server pinning and the registration call together. Creating the identity is
 * offline and always works; registering needs internet and may be repeated until it succeeds.
 */
class RegistrationRepository(
    private val store: UserIdentityStore,
    private val client: RegistrationClient
) {
    /** Registers the current identity (creating it first if needed) and pins the server's keys. */
    suspend fun register(displayName: String, contacts: List<EmergencyContact>): RegistrationResult {
        val identity = store.loadOrCreate()
        val result = client.register(identity, displayName, contacts, pinnedServer = store.serverKeys())
        if (result is RegistrationResult.Success) store.saveServerKeys(result.server)
        return result
    }

    fun isRegistered(): Boolean = store.load() != null && store.serverKeys() != null
}
