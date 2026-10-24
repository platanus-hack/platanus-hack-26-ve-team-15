package com.baliza.emergency.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.toMutableStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.baliza.emergency.app.ContactProfile
import com.baliza.emergency.app.SosLabels
import com.baliza.emergency.sos.SosSender
import com.baliza.emergency.sos.SosState
import com.baliza.emergency.sos.SosStatus

private val intListSaver = listSaver<androidx.compose.runtime.snapshots.SnapshotStateList<Int>, Int>(
    save = { it.toList() },
    restore = { it.toMutableStateList() }
)

/** The main screen: pick what happened, hold the button, watch the honest status. */
@Composable
fun SosScreen(
    profile: ContactProfile,
    status: SosStatus,
    error: String?,
    onStart: (category: Int, severity: Int, publicText: String, note: String, contacts: Set<Int>) -> Unit,
    onCancel: () -> Unit,
    onDismissError: () -> Unit,
    header: @Composable () -> Unit = {}
) {
    var category by rememberSaveable { mutableStateOf(1) }
    var severity by rememberSaveable { mutableStateOf(3) }
    var publicText by rememberSaveable { mutableStateOf("") }
    var note by rememberSaveable { mutableStateOf("") }
    val selected = rememberSaveable(saver = intListSaver) { profile.contacts.map { it.index }.toMutableStateList() }
    var confirmCancel by rememberSaveable { mutableStateOf(false) }
    val active = SosLabels.active(status.state)

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 32.dp, bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        header()

        if (active) {
            StatusCard(status)
            OutlinedButton(onClick = { confirmCancel = true }, modifier = Modifier.fillMaxWidth()) { Text("Cancelar aviso") }
        } else {
            Text("¿Qué pasa?", style = MaterialTheme.typography.titleMedium)
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(SosLabels.categories) { (id, label) ->
                    FilterChip(selected = category == id, onClick = { category = id }, label = { Text(label) })
                }
            }
            Text("Gravedad", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for ((id, label) in SosLabels.severities) {
                    FilterChip(selected = severity == id, onClick = { severity = id }, label = { Text(label) })
                }
            }
            Text("A quién avisar", style = MaterialTheme.typography.titleMedium)
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(profile.contacts) { c ->
                    FilterChip(
                        selected = c.index in selected,
                        onClick = { if (c.index in selected) selected.remove(c.index) else selected.add(c.index) },
                        label = { Text(c.name) }
                    )
                }
            }
            OutlinedTextField(
                value = publicText,
                onValueChange = { if (it.toByteArray(Charsets.UTF_8).size <= 60) publicText = it },
                label = { Text("Mensaje corto (lo ve cualquiera en la red)") },
                supportingText = { Text("${publicText.toByteArray(Charsets.UTF_8).size}/60") },
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = note,
                onValueChange = { if (it.toByteArray(Charsets.UTF_8).size <= SosSender.MAX_NOTE_BYTES) note = it },
                label = { Text("Detalles para tus contactos (cifrado)") },
                supportingText = { Text("${note.toByteArray(Charsets.UTF_8).size}/${SosSender.MAX_NOTE_BYTES}") },
                modifier = Modifier.fillMaxWidth()
            )
            if (error != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f))
                    TextButton(onClick = onDismissError) { Text("Ok") }
                }
            }
            Spacer(Modifier.height(8.dp))
            SosButton(
                enabled = selected.isNotEmpty(),
                onTriggered = { onStart(category, severity, publicText, note, selected.toSet()) }
            )
            Text(
                if (selected.isEmpty()) "Elige a quién avisar." else "Mantén pulsado para pedir ayuda.",
                modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }

    if (confirmCancel) {
        AlertDialog(
            onDismissRequest = { confirmCancel = false },
            title = { Text("¿Cancelar el aviso?") },
            text = { Text("Dejaré de reenviarlo. Si ya llegó a tus contactos, no se puede deshacer.") },
            confirmButton = { Button(onClick = { confirmCancel = false; onCancel() }) { Text("Sí, cancelar") } },
            dismissButton = { TextButton(onClick = { confirmCancel = false }) { Text("Seguir pidiendo ayuda") } }
        )
    }
}

/** Held, not tapped: a pocket press must not text your family. */
@Composable
private fun SosButton(enabled: Boolean, onTriggered: () -> Unit) {
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .size(190.dp)
                .clip(CircleShape)
                .background(if (enabled) BalizaColors.Red else BalizaColors.RedDark.copy(alpha = 0.5f))
                .pointerInput(enabled) {
                    if (enabled) detectTapGestures(onLongPress = { onTriggered() })
                },
            contentAlignment = Alignment.Center
        ) {
            Text("SOS", fontSize = 56.sp, fontWeight = FontWeight.Black, color = androidx.compose.ui.graphics.Color.White)
        }
    }
}

@Composable
private fun StatusCard(status: SosStatus) {
    val tone = SosLabels.tone(status.state)
    val color = when (tone) {
        SosLabels.Tone.GOOD -> BalizaColors.Good
        SosLabels.Tone.WAITING -> BalizaColors.Waiting
        SosLabels.Tone.BAD -> MaterialTheme.colorScheme.error
        SosLabels.Tone.NEUTRAL -> BalizaColors.Muted
    }
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(SosLabels.title(status.state), style = MaterialTheme.typography.titleLarge, color = color)
            Text(SosLabels.detail(status.state))
            if (tone == SosLabels.Tone.WAITING) {
                LinearProgressIndicator(Modifier.fillMaxWidth(), color = color)
            }
            Text(
                "Intentos: ${status.attempts}",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
