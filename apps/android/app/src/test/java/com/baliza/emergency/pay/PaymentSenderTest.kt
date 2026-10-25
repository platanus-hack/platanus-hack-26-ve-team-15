package com.baliza.emergency.pay

import com.baliza.emergency.EmergencyMeshTransport
import com.baliza.emergency.ReceivedEmergencyPacket
import com.baliza.emergency.SendResult
import com.baliza.emergency.ask.AskCounters
import com.baliza.emergency.ask.AskStart
import com.baliza.emergency.ask.AskStore
import com.baliza.emergency.ask.QuestionSender
import com.baliza.emergency.codec.EmergencyCodec
import com.baliza.emergency.codec.EmergencyPacket
import com.baliza.emergency.codec.EmergencyType
import com.baliza.emergency.crypto.Ed25519
import com.baliza.emergency.crypto.SealedBox
import com.baliza.emergency.identity.ServerKeys
import com.baliza.emergency.identity.UserIdentity
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PaymentSenderTest {

    private val userSign = Ed25519.keyPairFromSeed(ByteArray(32) { 1 })
    private val userSeal = SealedBox.generateKeyPair()
    private val identity = UserIdentity(userSign.seed, userSign.publicKey, userSeal.privateKey, userSeal.publicKey)
    private val serverSign = Ed25519.keyPairFromSeed(ByteArray(32) { 5 })
    private val serverSeal = SealedBox.generateKeyPair()
    private val server = ServerKeys("k1", serverSign.publicKey, serverSeal.publicKey)
    private val incident = ByteArray(8) { 3 }
    private val epochMs = 1_798_200_000_000L

    private class FakeTransport(private val clock: () -> Long) : EmergencyMeshTransport {
        val sent = mutableListOf<ByteArray>()
        val sentAt = mutableListOf<Long>()
        private val flow = MutableSharedFlow<ReceivedEmergencyPacket>(extraBufferCapacity = 16)
        override val incoming = flow
        override val newNeighbors = kotlinx.coroutines.flow.emptyFlow<Unit>()
        override suspend fun send(payload: ByteArray, ttl: Int): SendResult {
            sent += payload.copyOf(); sentAt += clock()
            return SendResult.SENT
        }
        fun hear(payload: ByteArray) = flow.tryEmit(ReceivedEmergencyPacket(payload, 5, "00", "AA"))
    }

    private class MemoryStore(var counters: AskCounters = AskCounters()) : AskStore {
        override fun load() = counters
        override fun save(counters: AskCounters) { this.counters = counters }
    }

    private class Rig(val sender: PaymentSender, val transport: FakeTransport, val store: MemoryStore, val finished: MutableList<PayStatus>)

    private fun TestScope.rig(
        keys: ServerKeys? = server,
        incidentId: ByteArray? = incident,
        store: MemoryStore = MemoryStore()
    ): Rig {
        val clock = { epochMs + currentTime }
        val transport = FakeTransport(clock)
        val finished = mutableListOf<PayStatus>()
        val sender = PaymentSender(
            transport, identity, { keys }, { incidentId }, backgroundScope,
            newNeighbors = kotlinx.coroutines.flow.emptyFlow(), store = store, nowMillis = clock,
            onFinished = { finished += it }
        )
        runCurrent()
        return Rig(sender, transport, store, finished)
    }

    private fun pago(
        phone: String = "0412 123 4567", amount: String = "25", bank: String = "Banesco",
        id: String = "V-12345678", concept: String = "medicinas"
    ) = PaymentRequest(PayKind.PAGO_MOVIL, phone, amount, bank = bank, idNumber = id, concept = concept)

    private fun recarga(phone: String = "0414-7654321", amount: String = "10", carrier: String = "Movistar") =
        PaymentRequest(PayKind.RECARGA, phone, amount, carrier = carrier)

    private fun ack(seq: Int, code: Int, signer: Ed25519.KeyPair = serverSign, incidentId: ByteArray = incident): ByteArray =
        EmergencyCodec.encode(EmergencyCodec.sign(EmergencyPacket(
            EmergencyType.ACK, 7, incidentId, seq, category = code, timestamp = 1_798_200_040L,
            senderId = Ed25519.senderId(signer.publicKey), publicText = "Recibido"
        ), signer.seed))

    private fun result(
        ref: Int, status: Int, text: String, signer: Ed25519.KeyPair = serverSign, sealTo: ByteArray = userSeal.publicKey,
        incidentId: ByteArray = incident
    ): ByteArray {
        val plain = byteArrayOf((ref shr 8).toByte(), ref.toByte(), status.toByte()) + text.toByteArray(Charsets.UTF_8)
        return EmergencyCodec.encode(EmergencyCodec.sign(EmergencyPacket(
            EmergencyType.CMD_RESULT, 7, incidentId, 1, timestamp = 1_798_200_090L,
            senderId = Ed25519.senderId(signer.publicKey), sealedBlob = SealedBox.seal(plain, sealTo)
        ), signer.seed))
    }

    private fun opened(wire: ByteArray): String =
        String(SealedBox.open(EmergencyCodec.decode(wire).sealedBlob, server.sealPublicKey, serverSeal.privateKey)!!, Charsets.UTF_8)

    private fun json(wire: ByteArray): JsonObject = JsonParser.parseString(opened(wire)).asJsonObject

    private fun TestScope.paid(r: Rig, request: PaymentRequest = pago()): Int {
        assertTrue(r.sender.pay(request) is PayStart.Started)
        runCurrent()
        return json(r.transport.sent.last())["ref"].asInt
    }

    private val receipt = "[MOCK] Pago Móvil adelantado US\$25.00 a +58412***4567. 3 cuotas de US\$8.75 (com. 5%). Cupo restante US\$25.00. Ref MOCK-1A2B3C4D"

    // --- the packet ---

    @Test
    fun `pagar builds a signed CMD sealed to the server with the Pago Movil fields the backend parses`() = runTest {
        val r = rig()
        r.sender.pay(pago()); runCurrent()

        val wire = r.transport.sent.single()
        assertTrue(wire.size <= EmergencyMeshTransport.MAX_PAYLOAD_BYTES)
        val packet = EmergencyCodec.decode(wire)
        assertEquals(EmergencyType.CMD, packet.type)
        assertTrue(EmergencyCodec.verify(packet, userSign.publicKey))
        assertArrayEquals(identity.senderId, packet.senderId)
        assertArrayEquals(incident, packet.incidentId)
        assertEquals(2, packet.seq)
        assertEquals(epochMs / 1000, packet.timestamp)

        val cmd = json(wire)
        assertEquals("pagar", cmd["cmd"].asString)
        assertTrue(cmd["ref"].asInt in 1..65535)
        val args = cmd["args"].asJsonObject
        assertEquals(setOf("banco", "cedula", "telefono", "monto", "concepto"), args.keySet())
        assertEquals("Banesco", args["banco"].asString)
        assertEquals("V-12345678", args["cedula"].asString)
        assertEquals("04121234567", args["telefono"].asString)
        assertEquals("a whole amount goes as a plain 25", "25", args["monto"].toString())
        assertEquals("medicinas", args["concepto"].asString)
        assertEquals(PayState.SENDING, r.sender.status.value.state)
        assertEquals("Pago Móvil · US\$25.00 · 0412-1234567", r.sender.status.value.summary)
        assertEquals(1, r.sender.status.value.attempts)
    }

    @Test
    fun `recargar_saldo carries the operator and phone, and a cedula is optional for Pago Movil`() = runTest {
        val r = rig()
        r.sender.pay(recarga(amount = "12,5")); runCurrent()
        val args = json(r.transport.sent.single())["args"].asJsonObject
        assertEquals("recargar_saldo", json(r.transport.sent.single())["cmd"].asString)
        assertEquals(setOf("operador", "telefono", "monto"), args.keySet())
        assertEquals("Movistar", args["operador"].asString)
        assertEquals("04147654321", args["telefono"].asString)
        assertEquals("12.5", args["monto"].toString())
        assertEquals("Recarga Movistar · US\$12.50 · 0414-7654321", r.sender.status.value.summary)

        val noId = rig()
        noId.sender.pay(pago(id = "  ")); runCurrent()
        assertFalse(json(noId.transport.sent.single())["args"].asJsonObject.has("cedula"))
    }

    @Test
    fun `quotes and angle brackets are not turned into unicode escapes`() = runTest {
        val r = rig()
        r.sender.pay(pago(concept = "agua <mineral> \"fría\" & sal/pimienta")); runCurrent()
        val text = opened(r.transport.sent.single())
        assertTrue(text, text.contains("<mineral>") && text.contains("&") && text.contains("sal/pimienta"))
        assertFalse(text, text.contains("\\u00"))
        assertEquals("agua <mineral> \"fría\" & sal/pimienta", json(r.transport.sent.single())["args"].asJsonObject["concepto"].asString)
    }

    // --- what the user may type ---

    @Test
    fun `phones are normalised to the local mobile form and anything else is refused unsent`() = runTest {
        for (ok in listOf("0412 123 4567", "+58 412 123-4567", "584121234567", "(0412) 1234567")) {
            val r = rig()
            assertTrue(ok, r.sender.pay(pago(phone = ok)) is PayStart.Started)
            runCurrent()
            assertEquals(ok, "04121234567", json(r.transport.sent.single())["args"].asJsonObject["telefono"].asString)
        }
        val r = rig()
        for (bad in listOf("", "12345", "0212 1234567", "+1 305 555 0100", "04121234", "0412 12345678", "abcd")) {
            val result = r.sender.pay(pago(phone = bad))
            assertTrue(bad, result is PayStart.Invalid)
            assertTrue((result as PayStart.Invalid).reason.contains("teléfono"))
        }
        runCurrent()
        assertTrue(r.transport.sent.isEmpty())
        assertEquals(PayState.IDLE, r.sender.status.value.state)
        assertEquals("nothing was spent", AskCounters().lastSeq, r.store.counters.lastSeq)
    }

    @Test
    fun `amounts need to be positive, with two decimals at most and under the cap`() = runTest {
        for ((typed, cents) in listOf("25" to 25_00L, "0.07" to 7L, "12,5" to 12_50L, " 100000 " to 100_000_00L, "3.10" to 3_10L)) {
            val args = PaymentArgs.parse(pago(amount = typed)).getOrThrow()
            assertEquals(typed, cents, args.cents)
        }
        val r = rig()
        for (bad in listOf("", "0", "-5", "abc", "1.234", "100000.01", "1e3", "∞")) {
            assertTrue("«$bad»", r.sender.pay(pago(amount = bad)) is PayStart.Invalid)
        }
    }

    @Test
    fun `bank, concept, operator and cedula are checked`() = runTest {
        val r = rig()
        val reasons = listOf(
            pago(bank = "  ") to "banco",
            pago(bank = "x".repeat(31)) to "banco",
            pago(concept = "") to "concepto",
            pago(concept = "x".repeat(61)) to "concepto",
            pago(id = "abc") to "cédula",
            recarga(carrier = " ") to "operador",
            recarga(carrier = "x".repeat(41)) to "operador"
        )
        for ((request, word) in reasons) {
            val result = r.sender.pay(request)
            assertTrue(result is PayStart.Invalid)
            assertTrue("${(result as PayStart.Invalid).reason} should mention $word", result.reason.contains(word))
        }
        assertTrue(r.sender.pay(pago(bank = "x".repeat(30), concept = "y".repeat(60), id = "E-1234567")) is PayStart.Started)
    }

    @Test
    fun `the worst case still fits the CMD and one mesh frame, and what does not is refused`() = runTest {
        val store = MemoryStore(AskCounters(usedRefs = (1..65534).toList())) // the only free ref is 65535
        val r = rig(store = store)
        val worst = pago(bank = "é".repeat(30), concept = "n".repeat(60), id = "V-1234567890", amount = "100000", phone = "0426 1234567")
        assertTrue(r.sender.pay(worst) is PayStart.Started)
        runCurrent()
        val wire = r.transport.sent.single()
        assertEquals(65535, json(wire)["ref"].asInt)
        assertTrue(opened(wire).toByteArray(Charsets.UTF_8).size <= PaymentSender.MAX_CMD_BYTES)
        assertTrue(wire.size <= EmergencyMeshTransport.MAX_PAYLOAD_BYTES)

        val tooBig = rig()
        val emoji = pago(bank = "🏦".repeat(15), concept = "🚑".repeat(30), id = "V-1234567890") // 30 and 60 chars, 180 B
        assertTrue(tooBig.sender.pay(emoji) is PayStart.Invalid) // does not fit the 264 B
        runCurrent()
        assertTrue(tooBig.transport.sent.isEmpty())
    }

    // --- when it may be paid ---

    @Test
    fun `needs a registration and an acknowledged incident, and one payment at a time`() = runTest {
        assertTrue(rig(keys = null).sender.pay(pago()) is PayStart.NotRegistered)
        assertTrue(rig(incidentId = null).sender.pay(pago()) is PayStart.NoIncident)

        val r = rig()
        assertTrue(r.sender.pay(pago()) is PayStart.Started)
        assertTrue(r.sender.pay(recarga()) is PayStart.Busy)
        runCurrent()
        assertEquals(1, r.transport.sent.size)
    }

    // --- seq and ref, shared with the questions ---

    @Test
    fun `payments and questions draw seq and ref from the same counters`() = runTest {
        val store = MemoryStore()
        val clock = { epochMs + currentTime }
        val transport = FakeTransport(clock)
        val asker = QuestionSender(transport, identity, { server }, { incident }, backgroundScope,
            newNeighbors = kotlinx.coroutines.flow.emptyFlow(), store = store, nowMillis = clock)
        val payer = PaymentSender(transport, identity, { server }, { incident }, backgroundScope,
            newNeighbors = kotlinx.coroutines.flow.emptyFlow(), store = store, nowMillis = clock)
        runCurrent()

        assertTrue(asker.ask("¿Cómo hago un torniquete?") is AskStart.Started); runCurrent()
        assertTrue(payer.pay(pago()) is PayStart.Started); runCurrent()
        asker.reset(); payer.reset()
        assertTrue(payer.pay(recarga()) is PayStart.Started); runCurrent()
        assertTrue(asker.ask("otra") is AskStart.Started); runCurrent()

        val seqs = transport.sent.map { EmergencyCodec.decode(it).seq }
        assertEquals("a repeated seq is dropped by the server", listOf(2, 3, 4, 5), seqs)
        val refs = transport.sent.map { json(it)["ref"].asInt }
        assertEquals(4, refs.toSet().size)
        assertEquals(refs.toSet(), store.counters.usedRefs.toSet())
    }

    @Test
    fun `the counters are spent before the first send and survive a restart`() = runTest {
        val store = MemoryStore()
        val first = rig(store = store)
        first.sender.pay(pago()) // not run yet: nothing has been sent
        assertTrue(first.transport.sent.isEmpty())
        assertEquals(2, store.counters.lastSeq.values.single())
        assertEquals(1, store.counters.usedRefs.size)

        val afterRestart = rig(store = store)
        afterRestart.sender.pay(recarga()); runCurrent()
        assertEquals(3, EmergencyCodec.decode(afterRestart.transport.sent.last()).seq)
        assertEquals(2, store.counters.usedRefs.size)
    }

    // --- resending and the ACK ---

    @Test
    fun `resends the same bytes every 15 s until the ACK of its own seq`() = runTest {
        val r = rig()
        r.sender.pay(pago()); runCurrent()
        advanceTimeBy(15_000); runCurrent()
        advanceTimeBy(15_000); runCurrent()
        assertEquals(3, r.transport.sent.size)
        assertEquals(listOf(0L, 15_000L, 30_000L), r.transport.sentAt.map { it - epochMs })
        assertTrue(r.transport.sent.all { it.contentEquals(r.transport.sent[0]) })

        r.transport.hear(ack(seq = 2, code = 0)); runCurrent()
        assertEquals(PayState.ACCEPTED, r.sender.status.value.state)
        advanceTimeBy(5 * 60_000); runCurrent()
        assertEquals("no more resending once accepted", 3, r.transport.sent.size)
    }

    @Test
    fun `an ACK of another seq, another incident or not signed by the server changes nothing`() = runTest {
        val r = rig()
        r.sender.pay(pago()); runCurrent()
        val impostor = Ed25519.keyPairFromSeed(ByteArray(32) { 9 })
        r.transport.hear(ack(seq = 1, code = 0)); runCurrent()                       // the SOS's ACK
        r.transport.hear(ack(seq = 3, code = 0)); runCurrent()                       // another command
        r.transport.hear(ack(seq = 2, code = 0, signer = impostor)); runCurrent()    // not the server
        r.transport.hear(ack(seq = 2, code = 0, incidentId = ByteArray(8) { 7 })); runCurrent()
        r.transport.hear(ByteArray(0)); r.transport.hear(ByteArray(120) { 4 }); runCurrent()
        assertEquals(PayState.SENDING, r.sender.status.value.state)
    }

    @Test
    fun `an ACK that refuses to read the command is final and a new payment can start`() = runTest {
        val r = rig()
        r.sender.pay(pago()); runCurrent()
        r.transport.hear(ack(seq = 2, code = 3)); runCurrent()
        assertEquals(PayState.REJECTED, r.sender.status.value.state)
        assertEquals(1, r.finished.size)
        val n = r.transport.sent.size
        advanceTimeBy(60_000); runCurrent()
        assertEquals(n, r.transport.sent.size)
        assertTrue(r.sender.pay(pago()) is PayStart.Started)
    }

    @Test
    fun `gives up after 30 minutes without an ACK and allows a new payment`() = runTest {
        val r = rig()
        r.sender.pay(pago()); runCurrent()
        advanceTimeBy(31 * 60_000); runCurrent()
        assertEquals(PayState.STOPPED, r.sender.status.value.state)
        val n = r.transport.sent.size
        advanceTimeBy(10 * 60_000); runCurrent()
        assertEquals(n, r.transport.sent.size)
        assertTrue(r.sender.pay(recarga()) is PayStart.Started)
        runCurrent()
        assertEquals(3, EmergencyCodec.decode(r.transport.sent.last()).seq)
    }

    // --- the receipt ---

    @Test
    fun `the receipt arrives with the credit left and the payment is done`() = runTest {
        val r = rig()
        val ref = paid(r)
        r.transport.hear(ack(seq = 2, code = 0)); runCurrent()
        r.transport.hear(result(ref, 0, receipt)); runCurrent()

        val s = r.sender.status.value
        assertEquals(PayState.APPROVED, s.state)
        assertEquals(receipt, s.text)
        assertEquals("US\$25.00", s.remainingCredit)
        assertEquals("Pago Móvil · US\$25.00 · 0412-1234567", s.summary)
        assertEquals(1, r.finished.size)
    }

    @Test
    fun `a receipt can beat its own ACK, and then nothing is resent`() = runTest {
        val r = rig()
        val ref = paid(r)
        r.transport.hear(result(ref, 0, receipt)); runCurrent()
        assertEquals(PayState.APPROVED, r.sender.status.value.state)
        val n = r.transport.sent.size
        advanceTimeBy(60_000); runCurrent()
        assertEquals(n, r.transport.sent.size)
    }

    @Test
    fun `each status maps to its state and keeps the server's words`() = runTest {
        val cases = listOf(1 to PayState.REJECTED, 2 to PayState.FAILED, 3 to PayState.DISABLED)
        for ((status, expected) in cases) {
            val r = rig()
            val ref = paid(r, recarga())
            r.transport.hear(result(ref, status, "Cupo insuficiente: disponible US\$10.00 ($status)")); runCurrent()
            assertEquals(expected, r.sender.status.value.state)
            assertEquals("Cupo insuficiente: disponible US\$10.00 ($status)", r.sender.status.value.text)
            assertNull("a refusal has no receipt", r.sender.status.value.remainingCredit)
        }
    }

    @Test
    fun `a result for another ref, from another signer or sealed to somebody else is ignored`() = runTest {
        val r = rig()
        val ref = paid(r)
        val impostor = Ed25519.keyPairFromSeed(ByteArray(32) { 9 })
        r.transport.hear(result((ref % 65535) + 1, 0, receipt)); runCurrent()
        r.transport.hear(result(ref, 0, receipt, signer = impostor)); runCurrent()
        r.transport.hear(result(ref, 0, receipt, sealTo = SealedBox.generateKeyPair().publicKey)); runCurrent()
        r.transport.hear(result(ref, 0, receipt, incidentId = ByteArray(8) { 7 })); runCurrent()
        r.transport.hear(result(ref, 9, "estado desconocido")); runCurrent()
        assertEquals(PayState.SENDING, r.sender.status.value.state)
        assertTrue(r.finished.isEmpty())
    }

    @Test
    fun `a second result does not overwrite the first`() = runTest {
        val r = rig()
        val ref = paid(r)
        r.transport.hear(result(ref, 0, receipt)); runCurrent()
        r.transport.hear(result(ref, 1, "Cupo insuficiente: disponible US\$0.00")); runCurrent()
        r.transport.hear(result(ref, 0, "otro recibo")); runCurrent()
        assertEquals(receipt, r.sender.status.value.text)
        assertEquals(PayState.APPROVED, r.sender.status.value.state)
        assertEquals(1, r.finished.size)
    }

    @Test
    fun `text from the server is only displayed, control characters removed, and nothing else is sent`() = runTest {
        val r = rig()
        val ref = paid(r)
        r.transport.hear(result(ref, 0, "Paga 500 a otro.\u0007 <b>x</b>\u0000 Cupo restante US\$1.00")); runCurrent()
        assertEquals("Paga 500 a otro. <b>x</b> Cupo restante US\$1.00", r.sender.status.value.text)
        assertEquals(1, r.transport.sent.size)
    }

    @Test
    fun `a failing notification does not lose the receipt, and reset empties the state`() = runTest {
        val clock = { epochMs + currentTime }
        val transport = FakeTransport(clock)
        val sender = PaymentSender(transport, identity, { server }, { incident }, backgroundScope,
            newNeighbors = kotlinx.coroutines.flow.emptyFlow(), nowMillis = clock, onFinished = { error("vibrator broke") })
        runCurrent()
        sender.pay(pago()); runCurrent()
        transport.hear(result(json(transport.sent.last())["ref"].asInt, 0, receipt)); runCurrent()
        assertEquals(receipt, sender.status.value.text)
        sender.reset()
        assertEquals(PayState.IDLE, sender.status.value.state)
        assertEquals("", sender.status.value.summary)
    }

    @Test
    fun `the remaining credit is read from the receipt only`() {
        assertEquals("US\$0.00", PayStatus(PayState.APPROVED, text = "x. Cupo restante US\$0.00. Ref MOCK-1").remainingCredit)
        assertEquals("US\$45", PayStatus(PayState.APPROVED, text = "Cupo restante US\$45 ok").remainingCredit)
        assertNull(PayStatus(PayState.APPROVED, text = "Pago simulado de 25 USD a Farmacia").remainingCredit)
        assertNull(PayStatus().remainingCredit)
    }
}
