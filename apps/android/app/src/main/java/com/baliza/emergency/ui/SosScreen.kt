package com.baliza.emergency.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bluetooth
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CloudUpload
import androidx.compose.material.icons.filled.DirectionsCar
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.LocalFireDepartment
import androidx.compose.material.icons.filled.LocalHospital
import androidx.compose.material.icons.filled.PersonSearch
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Smartphone
import androidx.compose.material.icons.filled.Verified
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.filled.Water
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.baliza.emergency.app.ContactProfile
import com.baliza.emergency.app.SosLabels
import com.baliza.emergency.ask.AskStatus
import com.baliza.emergency.pay.PayStatus
import com.baliza.emergency.pay.PaymentRequest
import com.baliza.emergency.replies.Reply
import com.baliza.emergency.sos.SosSender
import com.baliza.emergency.sos.SosState
import com.baliza.emergency.sos.SosStatus
import kotlinx.coroutines.launch

private val QUICK_MESSAGES = listOf(
    "No puedo moverme" to "No puedo moverme, herido en la zona",
    "Estoy atrapado" to "Estoy atrapado, ayuda urgente",
    "Heridos graves" to "Hay heridos graves en el lugar"
)

/** The main screen: pick what happened, hold the button, watch the honest status. */
@Composable
fun SosScreen(
    profile: ContactProfile,
    form: SosFormState,
    replies: List<Reply>,
    status: SosStatus,
    ask: AskStatus,
    askError: String?,
    pay: PayStatus,
    payError: String?,
    error: String?,
    onAsk: (String) -> Unit,
    onResetAsk: () -> Unit,
    onPay: (PaymentRequest) -> Unit,
    onResetPay: () -> Unit,
    onStart: (category: Int, severity: Int, publicText: String, note: String, contacts: Set<Int>) -> Unit,
    onCancel: () -> Unit,
    onDismissError: () -> Unit,
    header: @Composable () -> Unit = {}
) {
    var confirmCancel by rememberSaveable { mutableStateOf(false) }
    val active = SosLabels.active(status.state)

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 24.dp, bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        header()
        OfflineBadge()

        if (replies.isNotEmpty()) RepliesCard(replies, names = profile.contacts.associate { it.index to it.name })

        if (active) {
            StatusCard(status)
            if (SosLabels.canAsk(status.state)) {
                AskCard(ask, askError, onAsk, onResetAsk)
                PayCard(pay, payError, onPay, onResetPay)
            }
            OutlinedButton(onClick = { confirmCancel = true }, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text("Cancelar aviso") }
        } else {
            Section("¿Qué pasa?") {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(SosLabels.categories) { (id, label) ->
                        Chip(form.category == id, { form.category = id }, label, icon = categoryIcon(id))
                    }
                }
            }
            Section("Gravedad") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for ((id, label) in SosLabels.severities) {
                        Chip(form.severity == id, { form.severity = id }, label, dot = severityColor(id))
                    }
                }
            }
            Section("A quién avisar", trailing = "${form.selected.size} de ${profile.contacts.size}") {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (profile.contacts.size > 1) {
                        item {
                            val all = profile.contacts.all { it.index in form.selected }
                            Chip(all, { if (all) form.selected.clear() else form.selected.addAll(profile.contacts.map { it.index }) }, "Todos", checkWhenSelected = true)
                        }
                    }
                    items(profile.contacts) { c ->
                        Chip(c.index in form.selected, { form.toggle(c.index) }, c.name, checkWhenSelected = true)
                    }
                }
            }
            Section("Mensaje") {
                OutlinedTextField(
                    value = form.publicText,
                    onValueChange = { if (it.toByteArray(Charsets.UTF_8).size <= 60) form.publicText = it },
                    label = { Text("Mensaje público") },
                    supportingText = { Text("Lo ve cualquiera en la red · ${form.publicText.toByteArray(Charsets.UTF_8).size}/60") },
                    modifier = Modifier.fillMaxWidth()
                )
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(QUICK_MESSAGES) { (label, text) -> Chip(form.publicText == text, { form.publicText = text }, label) }
                }
                OutlinedTextField(
                    value = form.note,
                    onValueChange = { if (it.toByteArray(Charsets.UTF_8).size <= SosSender.MAX_NOTE_BYTES) form.note = it },
                    label = { Text("Detalles para tus contactos") },
                    supportingText = { Text("Cifrado: solo lo abren tus contactos · ${form.note.toByteArray(Charsets.UTF_8).size}/${SosSender.MAX_NOTE_BYTES}") },
                    modifier = Modifier.fillMaxWidth()
                )
            }
            if (error != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f))
                    TextButton(onClick = onDismissError) { Text("Ok") }
                }
            }
            SosButton(
                enabled = form.selected.isNotEmpty(),
                onTriggered = { onStart(form.category, form.severity, form.publicText, form.note, form.selected.toSet()) }
            )
            Text(
                if (form.selected.isEmpty()) "Elige a quién avisar." else "Mantén pulsado hasta que se complete el círculo.",
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

@Composable
private fun OfflineBadge() {
    Row(
        Modifier.clip(RoundedCornerShape(50)).background(BalizaColors.Good.copy(alpha = 0.12f)).padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Icon(Icons.Filled.Bluetooth, contentDescription = null, tint = BalizaColors.Good, modifier = Modifier.size(14.dp))
        Text("Funciona sin internet", style = MaterialTheme.typography.labelMedium, color = BalizaColors.Good)
    }
}

@Composable
private fun Section(title: String, trailing: String? = null, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (trailing != null) Text(trailing, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        content()
    }
}

/** One look for every choice on the screen: red outline and tint when selected. */
@Composable
private fun Chip(
    selected: Boolean,
    onClick: () -> Unit,
    label: String,
    icon: ImageVector? = null,
    dot: Color? = null,
    checkWhenSelected: Boolean = false
) {
    val leading: (@Composable () -> Unit)? = when {
        icon != null -> { { Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp)) } }
        dot != null -> { { Box(Modifier.size(10.dp).clip(CircleShape).background(dot)) } }
        checkWhenSelected && selected -> { { Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(18.dp)) } }
        else -> null
    }
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text(label) },
        leadingIcon = leading,
        shape = RoundedCornerShape(50),
        colors = FilterChipDefaults.filterChipColors(
            containerColor = MaterialTheme.colorScheme.surface,
            labelColor = MaterialTheme.colorScheme.onSurface,
            iconColor = MaterialTheme.colorScheme.onSurfaceVariant,
            selectedContainerColor = BalizaColors.Red.copy(alpha = 0.18f),
            selectedLabelColor = MaterialTheme.colorScheme.onSurface,
            selectedLeadingIconColor = BalizaColors.Red
        ),
        border = FilterChipDefaults.filterChipBorder(
            enabled = true, selected = selected,
            borderColor = MaterialTheme.colorScheme.outline, selectedBorderColor = BalizaColors.Red
        )
    )
}

private fun categoryIcon(id: Int): ImageVector = when (id) {
    1 -> Icons.Filled.LocalHospital
    2 -> Icons.Filled.LocalFireDepartment
    3 -> Icons.Filled.Shield
    4 -> Icons.Filled.DirectionsCar
    5 -> Icons.Filled.Water
    6 -> Icons.Filled.PersonSearch
    else -> Icons.Filled.Warning
}

private fun severityColor(id: Int): Color = when (id) {
    1 -> Color(0xFFFFC107)
    2 -> Color(0xFFFF7043)
    else -> BalizaColors.Red
}

private const val HOLD_MILLIS = 1200

/**
 * Held, not tapped: a pocket press must not text your family. The button sinks while pressed and a ring fills
 * over [HOLD_MILLIS]; letting go early empties it. A haptic tick marks the press and a stronger one the trigger.
 */
@Composable
private fun SosButton(enabled: Boolean, onTriggered: () -> Unit) {
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val trigger by rememberUpdatedState(onTriggered)
    val progress = remember { Animatable(0f) }
    var pressed by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(if (pressed) 0.92f else 1f, spring(dampingRatio = 0.45f, stiffness = 500f), label = "sos-scale")
    val halo by rememberInfiniteTransition(label = "sos-halo")
        .animateFloat(0f, 1f, infiniteRepeatable(tween(1800), RepeatMode.Restart), label = "sos-halo-progress")
    val face = if (enabled) Brush.radialGradient(listOf(Color(0xFFF0544F), BalizaColors.Red, Color(0xFFB71C1C)))
    else Brush.radialGradient(listOf(BalizaColors.RedDark.copy(alpha = 0.6f), BalizaColors.RedDark.copy(alpha = 0.4f)))

    Box(Modifier.fillMaxWidth().height(270.dp), contentAlignment = Alignment.Center) {
        if (enabled && !pressed) {
            Box(
                Modifier.size(200.dp)
                    .graphicsLayer { scaleX = 1f + halo * 0.28f; scaleY = 1f + halo * 0.28f; alpha = (1f - halo) * 0.45f }
                    .clip(CircleShape).background(BalizaColors.Red)
            )
        }
        Canvas(Modifier.size(236.dp)) {
            val stroke = 7.dp.toPx()
            drawArc(Color.White.copy(alpha = if (enabled) 0.08f else 0.04f), 0f, 360f, false, style = Stroke(stroke))
            if (progress.value > 0f) {
                drawArc(Color.White, -90f, 360f * progress.value, false, style = Stroke(stroke, cap = StrokeCap.Round))
            }
        }
        Box(
            Modifier
                .size(200.dp)
                .graphicsLayer { scaleX = scale; scaleY = scale }
                .shadow(if (pressed || !enabled) 2.dp else 18.dp, CircleShape, ambientColor = BalizaColors.Red, spotColor = BalizaColors.Red)
                .clip(CircleShape)
                .background(face)
                .pointerInput(enabled) {
                    if (!enabled) return@pointerInput
                    awaitEachGesture {
                        awaitFirstDown()
                        pressed = true
                        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                        val hold = scope.launch {
                            progress.animateTo(1f, tween(HOLD_MILLIS, easing = LinearEasing))
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            trigger()
                        }
                        waitForUpOrCancellation()
                        pressed = false
                        hold.cancel()
                        scope.launch { progress.animateTo(0f, tween(250)) }
                    }
                },
            contentAlignment = Alignment.Center
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("SOS", fontSize = 56.sp, fontWeight = FontWeight.Black, color = Color.White.copy(alpha = if (enabled) 1f else 0.5f))
                Text(
                    if (pressed) "Sigue pulsando" else "Mantén pulsado",
                    style = MaterialTheme.typography.labelMedium, color = Color.White.copy(alpha = if (enabled) 0.85f else 0.4f)
                )
            }
        }
    }
}

@Composable
private fun MeshStepper(state: SosState) {
    val step1Done = state != SosState.IDLE
    val step2Done = state == SosState.SENT || state == SosState.UNCONFIRMED || state == SosState.RECEIVED || state == SosState.IN_PROGRESS || state == SosState.CONTACTS_NOTIFIED
    val step3Done = state == SosState.RECEIVED || state == SosState.IN_PROGRESS || state == SosState.CONTACTS_NOTIFIED
    val step4Done = state == SosState.CONTACTS_NOTIFIED

    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(BalizaColors.SurfaceHigh).padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.Top
    ) {
        StepNode(Icons.Filled.Smartphone, "Tu teléfono", step1Done)
        StepLine(step2Done)
        StepNode(Icons.Filled.Bluetooth, "Bluetooth", step2Done)
        StepLine(step3Done)
        StepNode(Icons.Filled.CloudUpload, "Internet", step3Done)
        StepLine(step4Done)
        StepNode(Icons.Filled.Groups, "Contactos", step4Done)
    }
}

@Composable
private fun StepNode(icon: ImageVector, label: String, done: Boolean) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(
            Modifier.size(32.dp).clip(CircleShape).background(if (done) BalizaColors.Good.copy(alpha = 0.2f) else MaterialTheme.colorScheme.surface),
            contentAlignment = Alignment.Center
        ) {
            Icon(icon, contentDescription = null, tint = if (done) BalizaColors.Good else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
        }
        Text(label, style = MaterialTheme.typography.labelSmall, color = if (done) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun RowScope.StepLine(done: Boolean) {
    Box(
        Modifier.weight(1f).padding(top = 15.dp).height(2.dp).background(if (done) BalizaColors.Good else BalizaColors.Surface)
    )
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
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(SosLabels.title(status.state), style = MaterialTheme.typography.titleLarge, color = color)
            Text(SosLabels.detail(status.state))
            MeshStepper(status.state)
            if (tone == SosLabels.Tone.WAITING) {
                LinearProgressIndicator(Modifier.fillMaxWidth(), color = color)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("Intentos de radio: ${status.attempts}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                // Only claimed once the server's signed ACK arrived.
                if (tone == SosLabels.Tone.GOOD) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.Verified, contentDescription = null, tint = BalizaColors.Good, modifier = Modifier.size(14.dp))
                        Spacer(Modifier.size(4.dp))
                        Text("Confirmado por el servidor", style = MaterialTheme.typography.bodySmall, color = BalizaColors.Good)
                    }
                }
            }
        }
    }
}

private fun channelName(code: Int) = when (code) { 1 -> "SMS"; 2 -> "correo"; 4 -> "llamada"; else -> "mensaje" }

private val timeFormat = java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault())

/** What the contacts wrote back. Shown as plain text: it comes from a third party. */
@Composable
private fun RepliesCard(replies: List<Reply>, names: Map<Int, String>) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("Respuestas de tus contactos", style = MaterialTheme.typography.titleMedium, color = BalizaColors.Good)
            replies.forEach { r ->
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        "${names[r.contactIndex] ?: "Contacto ${r.contactIndex + 1}"} · ${channelName(r.channel)} · ${timeFormat.format(java.util.Date(r.receivedAtMillis))}",
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(r.text, style = MaterialTheme.typography.bodyLarge)
                }
            }
        }
    }
}
