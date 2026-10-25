package com.baliza.emergency.pay

import java.math.BigDecimal
import java.util.Locale

/** Where a payment is, in the words the user needs (docs/contrato.md §7, `pagar` and `recargar_saldo`). */
enum class PayState {
    /** Nothing in flight. */
    IDLE,

    /** Handed to the mesh, no ACK from the server yet. */
    SENDING,

    /** The server has the command ("Recibido"); its receipt comes as a CMD_RESULT. */
    ACCEPTED,

    /** CMD_RESULT status 0: advanced against the credit line. The text is the `[MOCK]` receipt. */
    APPROVED,

    /** Status 1 (no credit left, daily cap, bad data), or an ACK refusing to read the command. Final. */
    REJECTED,

    /** Status 2: the server failed while running it. */
    FAILED,

    /** Status 3: payments are switched off on the server. */
    DISABLED,

    /** Gave up resending without ever getting an ACK. */
    STOPPED
}

enum class PayKind(val cmd: String) {
    /** `pagar` with Pago Móvil fields: bank, phone, amount, concept. */
    PAGO_MOVIL("pagar"),

    /** `recargar_saldo` of a Movistar, Digitel or Movilnet line. */
    RECARGA("recargar_saldo")
}

/** What the user typed, as typed. [PaymentSender] checks it and decides what goes on the wire. */
class PaymentRequest(
    val kind: PayKind,
    val phone: String,
    val amount: String,
    val bank: String = "",
    val idNumber: String = "",
    val concept: String = "",
    val carrier: String = ""
)

class PayStatus(
    val state: PayState = PayState.IDLE,
    /** One line about what is being paid, for the card ("Pago Móvil · US$25.00 · 0412-1234567"). */
    val summary: String = "",
    /** The server's receipt, or its reason when [state] is a refusal. Plain text from the server. */
    val text: String = "",
    /** Times the packet was handed to the mesh. */
    val attempts: Int = 0
) {
    /** A payment is on its way: no other one may start. */
    val busy: Boolean get() = state == PayState.SENDING || state == PayState.ACCEPTED

    /** "US$25.00" taken from the receipt's "Cupo restante …", or null if the text has none. */
    val remainingCredit: String? get() = REMAINING.find(text)?.groupValues?.get(1)

    private companion object {
        val REMAINING = Regex("""Cupo restante (US\$\d+(?:\.\d{2})?)""")
    }
}

sealed interface PayStart {
    object Started : PayStart

    /** One payment at a time. */
    object Busy : PayStart

    /** Nothing to seal to: the user has not registered with a server yet. */
    object NotRegistered : PayStart

    /** CMD belongs to an incident the server has acknowledged. */
    object NoIncident : PayStart

    class Invalid(val reason: String) : PayStart
}

/** The user's input, checked and normalised, ready to become the `args` of the command. */
internal class PaymentArgs(
    val kind: PayKind,
    /** Venezuelan mobile in local form, `04121234567`. */
    val phone: String,
    val cents: Long,
    val bank: String?,
    val idNumber: String?,
    val concept: String?,
    val carrier: String?
) {
    /** `25` or `25.5`: a plain JSON number, the way the server expects `monto`. */
    val amountJson: Number get() = if (cents % 100 == 0L) cents / 100 else cents / 100.0

    fun usd(): String = String.format(Locale.ROOT, "US\$%d.%02d", cents / 100, cents % 100)

    fun summary(): String {
        val to = "${phone.take(4)}-${phone.drop(4)}"
        return if (kind == PayKind.PAGO_MOVIL) "Pago Móvil · ${usd()} · $to" else "Recarga ${carrier.orEmpty()} · ${usd()} · $to"
    }

    companion object {
        // Tighter than the server's 40 and 80: the whole command must fit the 264 B sealed plaintext.
        const val MAX_BANK_CHARS = 30
        const val MAX_CONCEPT_CHARS = 60
        const val MAX_OPERATOR_CHARS = 40
        private val MOBILE = Regex("""^(?:0|58)(412|414|416|424|426)(\d{7})$""")
        private val ID_NUMBER = Regex("""^[VEJGPvejgp]?-?\d{5,10}$""")
        private val AMOUNT = Regex("""^\d{1,9}(?:[.,]\d{1,2})?$""")
        private val MAX_AMOUNT = BigDecimal(100_000)

        /** Returns the checked args, or the reason in Spanish. */
        fun parse(r: PaymentRequest): Result<PaymentArgs> = try {
            Result.success(validated(r))
        } catch (e: IllegalArgumentException) {
            Result.failure(e)
        }

        private fun validated(r: PaymentRequest): PaymentArgs {
            val phone = normalizePhone(r.phone)
            val cents = cents(r.amount)
            return when (r.kind) {
                PayKind.PAGO_MOVIL -> {
                    val bank = bounded(r.bank, MAX_BANK_CHARS, "el banco")
                    val concept = bounded(r.concept, MAX_CONCEPT_CHARS, "el concepto")
                    val id = r.idNumber.trim().takeIf { it.isNotEmpty() }
                    require(id == null || ID_NUMBER.matches(id)) { "La cédula no es válida." }
                    PaymentArgs(r.kind, phone, cents, bank, id, concept, null)
                }
                PayKind.RECARGA -> PaymentArgs(r.kind, phone, cents, null, null, null, bounded(r.carrier, MAX_OPERATOR_CHARS, "el operador"))
            }
        }

        private fun bounded(value: String, max: Int, what: String): String {
            val v = value.trim().replace(Regex("""\s+"""), " ")
            require(v.isNotEmpty()) { "Falta $what." }
            require(v.length <= max) { "${what.replaceFirstChar { it.uppercase() }} es demasiado largo (máximo $max)." }
            return v
        }

        private fun normalizePhone(raw: String): String {
            val m = MOBILE.matchEntire(raw.filter { it.isDigit() })
            require(m != null) { "El teléfono debe ser un móvil venezolano, como 0412 1234567." }
            return "0${m.groupValues[1]}${m.groupValues[2]}"
        }

        private fun cents(raw: String): Long {
            val text = raw.trim()
            require(AMOUNT.matches(text)) { "Escribe un monto válido, con dos decimales como máximo." }
            val amount = BigDecimal(text.replace(',', '.'))
            require(amount.signum() > 0) { "Escribe un monto mayor que cero." }
            require(amount <= MAX_AMOUNT) { "El monto es demasiado alto." }
            return amount.movePointRight(2).longValueExact()
        }
    }
}
