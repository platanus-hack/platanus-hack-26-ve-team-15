package com.baliza.emergency.app

import android.content.Context
import com.baliza.emergency.BleEmergencyMeshTransport
import com.baliza.emergency.EmergencyMeshTransport
import com.baliza.emergency.codec.EmergencyCodec
import com.baliza.emergency.codec.EmergencyPacket
import com.baliza.emergency.crypto.Ed25519
import com.baliza.emergency.egress.EgressClient
import com.baliza.emergency.egress.EgressTransport
import com.baliza.emergency.egress.NetworkMonitor
import com.baliza.emergency.egress.Outbox
import com.baliza.emergency.egress.PrefsOutboxStore
import com.baliza.emergency.identity.UserIdentity
import com.baliza.emergency.crypto.SealedBox
import com.baliza.emergency.identity.ServerKeys
import com.baliza.emergency.identity.UserIdentityStore
import com.baliza.emergency.registration.RegistrationClient
import com.baliza.emergency.registration.RegistrationRepository
import com.baliza.emergency.registration.RegistrationResult
import com.baliza.emergency.sos.Channels
import com.baliza.emergency.sos.PrefsIncidentStore
import com.baliza.emergency.sos.IncidentStore
import com.baliza.emergency.sos.NoIncidentStore
import com.baliza.emergency.sos.SosLocation
import com.baliza.emergency.sos.SosRequest
import com.baliza.emergency.sos.SosSender
import com.baliza.emergency.sos.SosStatus
import com.baliza.emergency.sos.StartResult
import com.bitchat.android.mesh.BluetoothMeshService
import com.bitchat.android.service.MeshServiceHolder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** A packet this phone heard on the mesh, for the debug list. */
class HeardPacket(
    val atMillis: Long,
    /** Decoded type name, or null if it is not a valid emergency packet. */
    val type: String?,
    val incidentIdHex: String?,
    val hops: Int,
    val envelopeTtl: Int,
    val link: String?
)

/**
 * The emergency stack, one per process (docs: retries must outlive any screen). It owns the keys, the
 * contacts, the mesh transport and the [SosSender]; screens only observe it and call into it.
 *
 * Built once, off the main thread (the encrypted preferences touch the keystore): observe [boot].
 */
class EmergencyApp private constructor(context: Context) {

    sealed interface Boot {
        object Loading : Boot
        class Ready(val engine: Engine) : Boot
        class Failed(val message: String) : Boot
    }

    private val appContext = context.applicationContext

    @OptIn(ExperimentalCoroutinesApi::class)
    private val dispatcher = Dispatchers.Default.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)

    val settings = ApiSettings.create(appContext)
    private val locationProvider = SosLocationProvider(appContext)

    private val _boot = MutableStateFlow<Boot>(Boot.Loading)
    val boot: StateFlow<Boot> = _boot.asStateFlow()

    init {
        scope.launch(Dispatchers.IO) {
            _boot.value = try {
                Boot.Ready(Engine())
            } catch (e: Exception) {
                Boot.Failed(e.message ?: e.javaClass.simpleName)
            }
        }
    }

    inner class Engine internal constructor() {
        private val identityStore = UserIdentityStore.create(appContext)
        private val contactStore = ContactStore.create(appContext)
        private val incidentStore: IncidentStore = PrefsIncidentStore.create(appContext)
        private val identity = identityStore.loadOrCreate()

        private var attachedMesh: BluetoothMeshService? = null

        /** The live mesh instance; re-attaches our hooks if MeshServiceHolder replaced it. */
        private fun mesh(): BluetoothMeshService {
            val current = MeshServiceHolder.getOrCreate(appContext)
            if (current !== attachedMesh) {
                val first = attachedMesh == null
                attachedMesh = current
                if (!first) bleTransport.rebind()
            }
            return current
        }

        /** The raw mesh. */
        private val bleTransport: BleEmergencyMeshTransport = BleEmergencyMeshTransport.over(::mesh)

        /**
         * The mesh plus egress: a phone with internet uploads what it sends and what it hears, and the
         * server's answers come back to the SOS sender even though a phone never hears itself.
         */
        val transport: EgressTransport = EgressTransport(
            mesh = bleTransport,
            api = EgressClient({ settings.baseUrl }, RegistrationClient.defaultClient()),
            outbox = Outbox(PrefsOutboxStore.create(appContext), System::currentTimeMillis),
            scope = scope,
            online = NetworkMonitor(appContext).online,
            ownSenderIdHex = identity.senderIdHex,
            serverSignKey = { identityStore.serverKeys()?.signPublicKey }
        )

        val sender = SosSender(
            transport = transport,
            identity = identity,
            serverKeys = identityStore::serverKeys,
            scope = scope,
            store = incidentStore
        )

        val sosStatus: StateFlow<SosStatus> = sender.status

        private val _registered = MutableStateFlow(identityStore.serverKeys() != null)
        val registered: StateFlow<Boolean> = _registered.asStateFlow()

        private val _profile = MutableStateFlow(contactStore.load())
        val profile: StateFlow<ContactProfile?> = _profile.asStateFlow()

        private val _heard = MutableStateFlow<List<HeardPacket>>(emptyList())
        val heard: StateFlow<List<HeardPacket>> = _heard.asStateFlow()

        private var testSender: SosSender? = null
        private var testWatcher: kotlinx.coroutines.Job? = null
        private val _testStatus = MutableStateFlow(SosStatus(com.baliza.emergency.sos.SosState.IDLE))

        /** State of the mesh test packet, so the debug panel can say whether any neighbour took it. */
        val testStatus: StateFlow<SosStatus> = _testStatus.asStateFlow()

        init {
            scope.launch { bleTransport.incoming.collect(::remember) }
            // MeshServiceHolder may swap the instance at any time; notice within seconds.
            scope.launch { while (true) { delay(MESH_CHECK_MS); mesh() } }
            scope.launch {
                // Keep asking the server about an incident that survived a restart.
                if (sender.resume()) sender.status.value.incidentIdHex?.let(transport::trackOwn)
            }
        }

        /** Saves the contacts locally first, so a failed attempt (no internet) is not lost. */
        suspend fun register(profile: ContactProfile): RegistrationResult {
            contactStore.save(profile)
            _profile.value = profile
            val url = settings.baseUrl
            if (url.isBlank()) {
                return RegistrationResult.InvalidInput("El servidor no está configurado en esta versión.")
            }
            val result = RegistrationRepository(identityStore, RegistrationClient(url))
                .register(profile.displayName, profile.contacts)
            if (result is RegistrationResult.Success) _registered.value = true
            return result
        }

        suspend fun startSos(
            category: Int,
            severity: Int,
            publicText: String,
            note: String,
            selectedContacts: Set<Int>
        ): StartResult {
            val contacts = _profile.value?.contacts.orEmpty()
            val channels = SosContacts.channels(contacts, selectedContacts)
            val location = locationProvider.current()
            val request = SosRequest(category, severity, publicText, location, note, SosContacts.mask(selectedContacts), channels)
            return withContext(dispatcher) { sender.start(request) }
        }

        suspend fun cancelSos() = withContext(dispatcher) {
            sender.status.value.incidentIdHex?.let(transport::forgetOwn)
            sender.cancel()
        }

        /**
         * Debug: a real signed SOS sealed to a throwaway key, so the mesh can be exercised before any
         * backend exists. Nothing reaches a server; a hop count appears in the heard list on other phones.
         */
        suspend fun sendTestPacket(): StartResult = withContext(dispatcher) {
            testSender?.cancel()
            // Everything here is throwaway, the signer included: signed with the real identity, a test packet
            // would be accepted by the backend as a genuine SOS and alert the user's real contacts.
            val sealing = SealedBox.generateKeyPair()
            val signing = Ed25519.generate()
            val server = ServerKeys("test", signing.publicKey, sealing.publicKey)
            val throwawayIdentity = UserIdentity(signing.seed, signing.publicKey, sealing.privateKey, sealing.publicKey)
            val test = SosSender(bleTransport, throwawayIdentity, { server }, scope, store = NoIncidentStore)
            testSender = test
            testWatcher?.cancel()
            testWatcher = scope.launch { test.status.collect { _testStatus.value = it } }
            test.start(
                SosRequest(
                    category = 7, severity = 1, publicText = "PRUEBA Baliza",
                    location = null, note = "paquete de prueba", contactMask = 1, channels = Channels.SMS
                )
            )
        }

        fun stopTestPacket() {
            testSender?.cancel(); testSender = null
            testWatcher?.cancel(); testWatcher = null
            _testStatus.value = SosStatus(com.baliza.emergency.sos.SosState.IDLE)
        }

        /**
         * Debug: forgets the keys, the contacts, the pinned server and the current incident, as on a fresh
         * install. The sender keeps the old identity in memory, so the app must be closed and reopened.
         */
        suspend fun resetForTesting() = withContext(dispatcher) {
            testSender?.cancel(); testSender = null
            sender.status.value.incidentIdHex?.let(transport::forgetOwn)
            sender.cancel()
            identityStore.wipe()
            contactStore.clear()
            _registered.value = false
            _profile.value = null
        }

        private fun remember(received: com.baliza.emergency.ReceivedEmergencyPacket) {
            val packet = EmergencyCodec.decodeOrNull(received.payload)
            val entry = HeardPacket(
                atMillis = System.currentTimeMillis(),
                type = packet?.type?.name,
                incidentIdHex = packet?.incidentId?.joinToString("") { "%02x".format(it) },
                hops = packet?.let { EmergencyPacket.hops(it.ttl, received.envelopeTtl) } ?: 0,
                envelopeTtl = received.envelopeTtl,
                link = received.linkAddress
            )
            _heard.update { (listOf(entry) + it).take(MAX_HEARD) }
        }
    }

    companion object {
        private const val MESH_CHECK_MS = 5_000L
        private const val MAX_HEARD = 30

        @Volatile private var instance: EmergencyApp? = null

        fun get(context: Context): EmergencyApp =
            instance ?: synchronized(this) { instance ?: EmergencyApp(context).also { instance = it } }
    }
}
