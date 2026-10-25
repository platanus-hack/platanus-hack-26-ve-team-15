package com.baliza.emergency.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.baliza.emergency.registration.EmergencyContact

/**
 * Pick a contact to invite. Their invitation carries the code of this relationship: when they send it, they accept
 * this user only, not everyone who has their number.
 */
@Composable
fun InviteDialog(contacts: List<EmergencyContact>, error: String?, onInvite: (Int) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Invitar por WhatsApp") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "Se abrirá tu WhatsApp con un mensaje para tu contacto. Cuando toque el enlace y lo envíe, " +
                        "quedará como tu contacto de emergencia (solo tuyo).",
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                val withPhone = contacts.filter { !it.sms.isNullOrBlank() }
                if (withPhone.isEmpty()) Text("Ninguno de tus contactos tiene teléfono.")
                withPhone.forEach { c ->
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(c.name, modifier = Modifier.weight(1f))
                        OutlinedButton(onClick = { onInvite(c.index) }) { Text("Invitar") }
                    }
                }
                if (error != null) Text(error, color = MaterialTheme.colorScheme.error)
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Cerrar") } }
    )
}
