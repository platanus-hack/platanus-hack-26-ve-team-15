package com.baliza.emergency.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.baliza.emergency.app.EmergencyApp
import com.baliza.emergency.app.HeardPacket
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Debug builds only. Lets two or three phones exercise the mesh before any backend exists: send a real
 * signed packet, and see on the other phones what arrived and after how many hops.
 */
@Composable
fun DebugScreen(vm: BalizaViewModel, engine: EmergencyApp.Engine, onBack: () -> Unit, onOpenBitchat: () -> Unit) {
    val heard by engine.heard.collectAsState()
    val status by engine.sosStatus.collectAsState()
    var url by rememberSaveable { mutableStateOf(vm.settings.baseUrl) }
    var urlMessage by rememberSaveable { mutableStateOf<String?>(null) }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Depuración", style = MaterialTheme.typography.headlineSmall)
            TextButton(onClick = onBack) { Text("Volver") }
        }

        Text("Servidor", style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            value = url, onValueChange = { url = it; urlMessage = null }, singleLine = true,
            label = { Text("URL base (http://IP:puerto)") }, modifier = Modifier.fillMaxWidth()
        )
        Button(onClick = {
            urlMessage = if (vm.settings.setBaseUrl(url)) "Guardada." else "Debe empezar por http:// o https://"
        }) { Text("Guardar URL") }
        urlMessage?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }

        Text("Prueba del mesh", style = MaterialTheme.typography.titleMedium)
        Text(
            "Envía un paquete firmado y sellado a una llave descartable. No llega a ningún servidor: sirve para ver " +
                "en otros teléfonos si el paquete cruza el mesh y cuántos saltos da.",
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { vm.sendTestPacket(engine) }) { Text("Enviar prueba") }
            OutlinedButton(onClick = { engine.stopTestPacket() }) { Text("Detener") }
        }
        Text("SOS real: ${status.state} · intentos ${status.attempts}", style = MaterialTheme.typography.bodySmall)

        Text("Paquetes oídos (${heard.size})", style = MaterialTheme.typography.titleMedium)
        if (heard.isEmpty()) Text("Nada todavía.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        heard.forEach { Text(describe(it), style = MaterialTheme.typography.bodySmall) }

        Text("Restablecer", style = MaterialTheme.typography.titleMedium)
        Text(
            "Borra llaves, contactos y registro, como una instalación nueva. Después cierra la app del todo y ábrela otra vez.",
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        var confirmReset by rememberSaveable { mutableStateOf(false) }
        OutlinedButton(onClick = { confirmReset = true }) { Text("Borrar registro y contactos") }
        if (confirmReset) {
            androidx.compose.material3.AlertDialog(
                onDismissRequest = { confirmReset = false },
                title = { Text("¿Borrar todo?") },
                text = { Text("Se pierde tu identidad en la baliza y tendrás que registrarte de nuevo.") },
                confirmButton = { Button(onClick = { confirmReset = false; vm.resetForTesting(engine) }) { Text("Borrar") } },
                dismissButton = { TextButton(onClick = { confirmReset = false }) { Text("No") } }
            )
        }

        OutlinedButton(onClick = onOpenBitchat) { Text("Abrir bitchat original") }
    }
}

private val clock = SimpleDateFormat("HH:mm:ss", Locale.US)

private fun describe(p: HeardPacket): String {
    val time = clock.format(Date(p.atMillis))
    val type = p.type ?: "INVÁLIDO"
    val id = p.incidentIdHex?.take(8) ?: "--------"
    return "$time  $type  $id  saltos=${p.hops}  ttl restante=${p.envelopeTtl}  enlace=${p.link?.takeLast(5) ?: "?"}"
}
