package com.baliza.emergency.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.baliza.emergency.pay.PayKind
import com.baliza.emergency.pay.PayState
import com.baliza.emergency.pay.PayStatus
import com.baliza.emergency.pay.PaymentArgs
import com.baliza.emergency.pay.PaymentRequest

private val OPERATORS = listOf("Movistar", "Digitel", "Movilnet")

/**
 * Pay with no internet: Pago Móvil or a top-up, advanced against a microcredit line. SIMULATED end to end; the
 * receipt says so. Only offered once the server acknowledged the SOS, because the command travels inside that
 * incident. The receipt is plain text from the server and is never acted on.
 */
@Composable
fun PayCard(pay: PayStatus, error: String?, onPay: (PaymentRequest) -> Unit, onReset: () -> Unit) {
    var kind by rememberSaveable { mutableStateOf(PayKind.PAGO_MOVIL) }
    var bank by rememberSaveable { mutableStateOf("") }
    var idNumber by rememberSaveable { mutableStateOf("") }
    var phone by rememberSaveable { mutableStateOf("") }
    var amount by rememberSaveable { mutableStateOf("") }
    var concept by rememberSaveable { mutableStateOf("") }
    var carrier by rememberSaveable { mutableStateOf(OPERATORS.first()) }

    val request = PaymentRequest(kind, phone, amount, bank, idNumber, concept, carrier)
    val clearForm = { bank = ""; idNumber = ""; phone = ""; amount = ""; concept = "" }

    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Pago Móvil y recargas sin saldo", style = MaterialTheme.typography.titleMedium)
            when (pay.state) {
                PayState.IDLE -> {
                    Text(
                        "Sin internet ni saldo: te adelantamos el pago con un microcrédito de emergencia y lo devuelves en 3 cuotas. " +
                            "Es una simulación: no se mueve dinero real.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(selected = kind == PayKind.PAGO_MOVIL, onClick = { kind = PayKind.PAGO_MOVIL }, label = { Text("Pago Móvil") })
                        FilterChip(selected = kind == PayKind.RECARGA, onClick = { kind = PayKind.RECARGA }, label = { Text("Recarga") })
                    }
                    if (kind == PayKind.PAGO_MOVIL) {
                        Field(bank, "Banco", PaymentArgs.MAX_BANK_CHARS) { bank = it }
                        Field(idNumber, "Cédula (opcional)", 12) { idNumber = it }
                    } else {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            for (name in OPERATORS) FilterChip(selected = carrier == name, onClick = { carrier = name }, label = { Text(name) })
                        }
                    }
                    Field(phone, if (kind == PayKind.PAGO_MOVIL) "Teléfono de destino" else "Teléfono a recargar", 17, KeyboardType.Phone) { phone = it }
                    Field(amount, "Monto en US$", 9, KeyboardType.Decimal) { amount = it }
                    if (kind == PayKind.PAGO_MOVIL) Field(concept, "Concepto", PaymentArgs.MAX_CONCEPT_CHARS) { concept = it }
                    if (error != null) Text(error, color = MaterialTheme.colorScheme.error)
                    Button(onClick = { onPay(request) }, enabled = phone.isNotBlank() && amount.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
                        Text(if (kind == PayKind.PAGO_MOVIL) "Pagar con microcrédito" else "Recargar con microcrédito")
                    }
                }
                PayState.SENDING -> Waiting(pay.summary, "Enviando por Bluetooth… intentos: ${pay.attempts}")
                PayState.ACCEPTED -> Waiting(pay.summary, "El servidor recibió el pago. Esperando el recibo.")
                PayState.APPROVED -> {
                    Summary(pay.summary)
                    Text("Pago adelantado", style = MaterialTheme.typography.titleMedium, color = BalizaColors.Good)
                    Text(pay.text, style = MaterialTheme.typography.bodyLarge)
                    pay.remainingCredit?.let { Text("Cupo restante: $it", style = MaterialTheme.typography.titleMedium, color = BalizaColors.Good) }
                    Text(
                        "Simulación de demostración: no se movió dinero real.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    OutlinedButton(onClick = { clearForm(); onReset() }, modifier = Modifier.fillMaxWidth()) { Text("Otro pago") }
                }
                PayState.REJECTED -> Final(pay, "No se pudo pagar", pay.text.ifBlank { "El servidor rechazó el pago." }, canRetry = false, onPay = { onPay(request) }, onReset = { clearForm(); onReset() })
                PayState.FAILED -> Final(pay, "El pago falló", pay.text.ifBlank { "Inténtalo de nuevo." }, canRetry = true, onPay = { onPay(request) }, onReset = { clearForm(); onReset() })
                PayState.DISABLED -> Final(pay, "Función desactivada", "El servidor tiene apagados los pagos.", canRetry = false, onPay = { onPay(request) }, onReset = { clearForm(); onReset() })
                PayState.STOPPED -> Final(pay, "Sin respuesta", "Ningún teléfono con conexión recibió el pago. Acércate a otros teléfonos e inténtalo de nuevo.", canRetry = true, onPay = { onPay(request) }, onReset = { clearForm(); onReset() })
            }
        }
    }
}

@Composable
private fun Field(value: String, label: String, maxChars: Int, type: KeyboardType = KeyboardType.Text, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = { if (it.length <= maxChars) onChange(it) },
        label = { Text(label) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = type),
        modifier = Modifier.fillMaxWidth()
    )
}

@Composable
private fun Summary(text: String) {
    Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun Waiting(summary: String, detail: String) {
    Summary(summary)
    Text(detail)
    LinearProgressIndicator(Modifier.fillMaxWidth(), color = BalizaColors.Waiting)
}

@Composable
private fun Final(pay: PayStatus, title: String, detail: String, canRetry: Boolean, onPay: () -> Unit, onReset: () -> Unit) {
    Summary(pay.summary)
    Text(title, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.error)
    Text(detail)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (canRetry) Button(onClick = onPay) { Text("Reintentar") }
        OutlinedButton(onClick = onReset) { Text("Otro pago") }
    }
}
