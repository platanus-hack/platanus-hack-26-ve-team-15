package com.baliza.emergency.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
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
import androidx.compose.ui.unit.dp
import com.baliza.emergency.ask.AskState
import com.baliza.emergency.ask.AskStatus
import com.baliza.emergency.ask.QuestionSender

/**
 * Ask an AI a question with no internet. Only offered once the server acknowledged the SOS, because the question
 * travels inside that incident. The answer is shown as plain text and is never acted on.
 */
@Composable
fun AskCard(ask: AskStatus, error: String?, onAsk: (String) -> Unit, onReset: () -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    val bytes = text.toByteArray(Charsets.UTF_8).size

    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Pregúntale a una IA", style = MaterialTheme.typography.titleMedium)
            when (ask.state) {
                AskState.IDLE -> {
                    Text(
                        "Sin internet, tu pregunta viaja por Bluetooth hasta un teléfono con conexión. Puede tardar un minuto.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    OutlinedTextField(
                        value = text,
                        onValueChange = {
                            if (it.length <= QuestionSender.MAX_QUESTION_CHARS && it.toByteArray(Charsets.UTF_8).size <= QuestionSender.MAX_QUESTION_BYTES) text = it
                        },
                        label = { Text("Tu pregunta") },
                        supportingText = { Text("$bytes/${QuestionSender.MAX_QUESTION_BYTES}") },
                        modifier = Modifier.fillMaxWidth()
                    )
                    if (error != null) Text(error, color = MaterialTheme.colorScheme.error)
                    Button(onClick = { onAsk(text) }, enabled = text.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text("Preguntar") }
                }
                AskState.SENDING -> Waiting(ask.question, "Enviando por Bluetooth… intentos: ${ask.attempts}")
                AskState.ACCEPTED -> Waiting(ask.question, "El servidor la recibió. La IA está respondiendo; puede tardar unas decenas de segundos.")
                AskState.ANSWERED -> {
                    Question(ask.question)
                    Text(ask.text, style = MaterialTheme.typography.bodyLarge, color = BalizaColors.Good)
                    Text(
                        "Respuesta de una IA: puede equivocarse y no sustituye a los servicios de emergencia.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    OutlinedButton(onClick = { text = ""; onReset() }, modifier = Modifier.fillMaxWidth()) { Text("Otra pregunta") }
                }
                AskState.REJECTED -> Final(ask, "No se pudo responder", ask.text.ifBlank { "El servidor rechazó la pregunta." }, onAsk, onReset, canRetry = false) { text = "" }
                AskState.FAILED -> Final(ask, "La IA no pudo responder", ask.text.ifBlank { "Inténtalo de nuevo." }, onAsk, onReset, canRetry = true) { text = "" }
                AskState.DISABLED -> Final(ask, "Función desactivada", "El servidor tiene apagadas las preguntas a la IA.", onAsk, onReset, canRetry = false) { text = "" }
                AskState.STOPPED -> Final(ask, "Sin respuesta", "Ningún teléfono con conexión recibió la pregunta. Acércate a otros teléfonos e inténtalo de nuevo.", onAsk, onReset, canRetry = true) { text = "" }
            }
        }
    }
}

@Composable
private fun Question(q: String) {
    Text("«$q»", color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun Waiting(question: String, detail: String) {
    Question(question)
    Text(detail)
    LinearProgressIndicator(Modifier.fillMaxWidth(), color = BalizaColors.Waiting)
}

@Composable
private fun Final(
    ask: AskStatus, title: String, detail: String,
    onAsk: (String) -> Unit, onReset: () -> Unit, canRetry: Boolean, clearTyped: () -> Unit
) {
    Question(ask.question)
    Text(title, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.error)
    Text(detail)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (canRetry) Button(onClick = { onAsk(ask.question) }) { Text("Reintentar") }
        OutlinedButton(onClick = { clearTyped(); onReset() }) { Text("Otra pregunta") }
    }
}
