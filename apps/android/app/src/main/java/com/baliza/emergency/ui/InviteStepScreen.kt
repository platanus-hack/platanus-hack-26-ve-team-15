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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.baliza.emergency.registration.EmergencyContact

/**
 * Shown once, right after registering: the moment the user has just chosen their contacts is when to invite them.
 * Each invitation carries the code of that relationship, so accepting it makes them this user's contact only.
 */
@Composable
fun InviteStepScreen(contacts: List<EmergencyContact>, error: String?, onInvite: (Int) -> Unit, onDone: () -> Unit) {
    var invited by rememberSaveable { mutableStateOf(emptyList<Int>()) }
    val withPhone = contacts.filter { !it.sms.isNullOrBlank() }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 48.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Text("Invita a tus contactos", style = MaterialTheme.typography.headlineSmall)
        Text(
            "Para que puedan recibir tus avisos, cada contacto tiene que aceptar. Toca Invitar: se abrirá tu WhatsApp " +
                "con un mensaje para esa persona. Envíalo; cuando toque el enlace y envíe la respuesta, quedará como " +
                "tu contacto de emergencia (solo tuyo).",
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        if (withPhone.isEmpty()) Text("Ninguno de tus contactos tiene teléfono: no hay a quién invitar por WhatsApp.")
        withPhone.forEach { c ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    Text(c.name, style = MaterialTheme.typography.titleMedium)
                    if (c.index in invited) Text("Invitación abierta en WhatsApp", color = BalizaColors.Good, style = MaterialTheme.typography.bodySmall)
                }
                OutlinedButton(onClick = { invited = invited + c.index; onInvite(c.index) }) {
                    Text(if (c.index in invited) "Otra vez" else "Invitar")
                }
            }
        }
        if (error != null) Text(error, color = MaterialTheme.colorScheme.error)
        Button(onClick = onDone, modifier = Modifier.fillMaxWidth()) { Text(if (invited.isEmpty()) "Más tarde" else "Listo") }
        Text(
            "Puedes invitarlos después desde la pantalla principal.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}
