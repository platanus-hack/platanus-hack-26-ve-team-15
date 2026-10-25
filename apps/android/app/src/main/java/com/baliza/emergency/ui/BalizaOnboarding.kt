package com.baliza.emergency.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BatteryAlert
import androidx.compose.material.icons.filled.BatteryChargingFull
import androidx.compose.material.icons.filled.Bluetooth
import androidx.compose.material.icons.filled.BluetoothDisabled
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LocationOff
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MyLocation
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.bitchat.android.R
import com.bitchat.android.onboarding.BatteryOptimizationPreferenceManager
import com.bitchat.android.onboarding.BatteryOptimizationStatus
import com.bitchat.android.onboarding.BluetoothStatus
import com.bitchat.android.onboarding.LocationStatus
import com.bitchat.android.onboarding.PermissionCategory
import com.bitchat.android.onboarding.PermissionType

/*
 * First-run screens in Baliza Vital's look, always dark. They stand in one for one for bitchat's onboarding
 * screens (same states and callbacks), so bitchat's OnboardingCoordinator keeps driving the flow unchanged.
 */

/** Before the system permission dialogs: what each permission is for, in SOS terms. */
@Composable
fun BalizaPermissionScreen(modifier: Modifier, permissionCategories: List<PermissionCategory>, onContinue: () -> Unit) {
    Step(modifier, actions = { PrimaryAction("Dar permisos", onContinue) }) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Text("Tu SOS sale aunque no haya señal", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Text(
                "Baliza Vital pasa tu alerta de teléfono en teléfono por Bluetooth hasta uno con internet, que avisa a tus contactos. Para eso necesita:",
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            permissionCategories.forEach { PermissionRow(it) }
            Note(Icons.Filled.Lock, "Tu ubicación solo se comparte cuando envías un SOS, y viaja cifrada hasta el servidor de Baliza Vital.")
        }
    }
}

@Composable
fun BalizaBluetoothScreen(
    modifier: Modifier,
    status: BluetoothStatus,
    onEnableBluetooth: () -> Unit,
    onRetry: () -> Unit,
    onSkip: () -> Unit,
    isLoading: Boolean = false
) {
    when (status) {
        BluetoothStatus.ENABLED -> Waiting(modifier, "Revisando el Bluetooth…")
        BluetoothStatus.DISABLED -> Message(
            modifier, Icons.Filled.BluetoothDisabled, "Enciende el Bluetooth",
            "Es el camino por el que tu SOS salta de teléfono en teléfono cuando no hay señal.",
            actions = {
                PrimaryAction("Encender Bluetooth", onEnableBluetooth, isLoading)
                SecondaryAction("Ya lo encendí", onRetry)
                QuietAction("Ahora no", onSkip)
            }
        )
        BluetoothStatus.NOT_SUPPORTED -> Message(
            modifier, Icons.Filled.BluetoothDisabled, "Este teléfono no tiene Bluetooth",
            "Puedes usar Baliza Vital, pero tu SOS solo saldrá cuando el teléfono tenga internet.",
            tone = MaterialTheme.colorScheme.secondary,
            actions = { PrimaryAction("Continuar", onSkip) }
        )
    }
}

@Composable
fun BalizaLocationScreen(
    modifier: Modifier,
    status: LocationStatus,
    onEnableLocation: () -> Unit,
    onRetry: () -> Unit,
    isLoading: Boolean = false
) {
    when (status) {
        LocationStatus.ENABLED -> Waiting(modifier, "Revisando la ubicación…")
        LocationStatus.DISABLED -> Message(
            modifier, Icons.Filled.LocationOff, "Activa la ubicación",
            "Tu SOS dice dónde estás para que puedan encontrarte. Android también la necesita para buscar teléfonos cercanos.",
            actions = {
                PrimaryAction("Activar ubicación", onEnableLocation, isLoading)
                SecondaryAction("Ya la activé", onRetry)
            }
        )
        LocationStatus.NOT_AVAILABLE -> Message(
            modifier, Icons.Filled.LocationOff, "La ubicación no está disponible",
            "Este teléfono no ofrece servicios de ubicación, y Android los exige para usar el Bluetooth de la baliza.",
            tone = MaterialTheme.colorScheme.error
        )
    }
}

@Composable
fun BalizaBatteryScreen(
    modifier: Modifier,
    status: BatteryOptimizationStatus,
    onDisableBatteryOptimization: () -> Unit,
    onRetry: () -> Unit,
    onSkip: () -> Unit,
    isLoading: Boolean = false
) {
    val context = LocalContext.current
    LaunchedEffect(Unit) { BatteryOptimizationPreferenceManager.init(context) }
    when (status) {
        BatteryOptimizationStatus.DISABLED -> Waiting(modifier, "Revisando la batería…")
        BatteryOptimizationStatus.ENABLED -> Message(
            modifier, Icons.Filled.BatteryAlert, "Deja la baliza encendida",
            "Android cierra apps en segundo plano para ahorrar batería. Si cierra Baliza Vital, tu teléfono deja de pasar alertas, también las de otras personas.",
            actions = {
                PrimaryAction("Permitir", onDisableBatteryOptimization, isLoading)
                SecondaryAction("Ya lo hice", onRetry)
                QuietAction("Ahora no", onSkip)
            }
        )
        BatteryOptimizationStatus.NOT_SUPPORTED -> Message(
            modifier, Icons.Filled.BatteryChargingFull, "La batería no es problema",
            "Este teléfono no cierra Baliza Vital en segundo plano.",
            tone = BalizaColors.Good,
            actions = { PrimaryAction("Continuar", onRetry) }
        )
    }
}

@Composable
fun BalizaBackgroundLocationScreen(modifier: Modifier, onContinue: () -> Unit, onRetry: () -> Unit, onSkip: () -> Unit) {
    Message(
        modifier, Icons.Filled.LocationOn, "Ubicación todo el tiempo",
        "Para que la baliza siga pasando alertas con la pantalla apagada, Android pide la ubicación en segundo plano.",
        note = "En la siguiente pantalla elige «Permitir todo el tiempo». Tu ubicación solo se comparte cuando envías un SOS.",
        actions = {
            PrimaryAction("Continuar", onContinue)
            SecondaryAction("Ya lo hice", onRetry)
            QuietAction("Ahora no", onSkip)
        }
    )
}

@Composable
fun BalizaInitializingScreen(modifier: Modifier) = Waiting(modifier, "Encendiendo la baliza…")

@Composable
fun BalizaInitErrorScreen(modifier: Modifier, errorMessage: String, onRetry: () -> Unit, onOpenSettings: () -> Unit) {
    Message(
        modifier, Icons.Filled.ErrorOutline, "No pude encender la baliza", errorMessage,
        tone = MaterialTheme.colorScheme.error,
        actions = {
            PrimaryAction("Reintentar", onRetry)
            SecondaryAction("Abrir ajustes", onOpenSettings)
        }
    )
}

// --- building blocks -----------------------------------------------------------------------------

/** Brand on top, [content] in the middle, [actions] pinned to the bottom. */
@Composable
private fun Step(modifier: Modifier, actions: @Composable ColumnScope.() -> Unit = {}, content: @Composable () -> Unit) {
    Surface(modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 20.dp)) {
            BalizaBrand()
            Box(Modifier.weight(1f).fillMaxWidth()) { content() }
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp), content = actions)
        }
    }
}

/** Logo and name, shared by the onboarding and the main screen. */
@Composable
internal fun BalizaBrand() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(40.dp).clip(RoundedCornerShape(12.dp)).background(Color(0xFFC62828))) {
            // The launcher foreground keeps its art inside the adaptive-icon safe zone, so it is scaled up here.
            Image(
                painterResource(R.drawable.ic_launcher_foreground), contentDescription = null,
                modifier = Modifier.fillMaxSize().graphicsLayer(scaleX = 1.5f, scaleY = 1.5f)
            )
        }
        Spacer(Modifier.size(12.dp))
        Text("Baliza Vital", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun Message(
    modifier: Modifier,
    icon: ImageVector,
    title: String,
    body: String,
    tone: Color = MaterialTheme.colorScheme.primary,
    note: String? = null,
    actions: @Composable ColumnScope.() -> Unit = {}
) {
    Step(modifier, actions) {
        // Centered while it fits, scrollable when it does not (small screens, long error messages).
        BoxWithConstraints(Modifier.fillMaxSize()) {
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).heightIn(min = maxHeight).padding(vertical = 24.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Box(Modifier.size(96.dp).clip(CircleShape).background(tone.copy(alpha = 0.15f)), contentAlignment = Alignment.Center) {
                    Icon(icon, contentDescription = null, tint = tone, modifier = Modifier.size(44.dp))
                }
                Text(title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                Text(body, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                if (note != null) Note(Icons.Filled.Lock, note)
            }
        }
    }
}

@Composable
private fun Waiting(modifier: Modifier, text: String) {
    Step(modifier) {
        Column(
            Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            CircularProgressIndicator()
            Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun PermissionRow(category: PermissionCategory) {
    val (icon, name, why) = explain(category)
    Surface(color = MaterialTheme.colorScheme.surface, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.Top) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 2.dp).size(22.dp))
            Spacer(Modifier.size(14.dp))
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(name, style = MaterialTheme.typography.titleSmall)
                Text(why, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

private data class Explained(val icon: ImageVector, val name: String, val why: String)

/** bitchat names its permission groups in English and in chat terms; these say what each one does for an SOS. */
private fun explain(category: PermissionCategory): Explained = when (category.type) {
    PermissionType.NEARBY_DEVICES -> Explained(Icons.Filled.Bluetooth, "Dispositivos cercanos", "Para pasar tu SOS por Bluetooth a los teléfonos de alrededor, y ayudar con los de otros.")
    PermissionType.PRECISE_LOCATION -> Explained(Icons.Filled.MyLocation, "Ubicación precisa", "Para que tu SOS diga dónde estás. Android también la pide para buscar teléfonos por Bluetooth.")
    PermissionType.BACKGROUND_LOCATION -> Explained(Icons.Filled.LocationOn, "Ubicación en segundo plano", "Para seguir pasando alertas con la pantalla apagada.")
    PermissionType.MICROPHONE -> Explained(Icons.Filled.Mic, "Micrófono", "Para dictar mensajes sin escribir.")
    PermissionType.NOTIFICATIONS -> Explained(Icons.Filled.Notifications, "Notificaciones", "Para avisarte cuando llegue la confirmación o la respuesta de tus contactos.")
    PermissionType.WIFI_AWARE -> Explained(Icons.Filled.Wifi, "Wi‑Fi cercano", "Para llegar más lejos entre teléfonos cuando el equipo lo permite.")
    PermissionType.BATTERY_OPTIMIZATION -> Explained(Icons.Filled.BatteryAlert, "Batería", "Para que Android no apague la baliza en segundo plano.")
    PermissionType.OTHER -> Explained(Icons.Filled.Settings, "Otros", category.description)
}

@Composable
private fun Note(icon: ImageVector, text: String) {
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.Top) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp).size(16.dp))
        Spacer(Modifier.size(10.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun PrimaryAction(text: String, onClick: () -> Unit, loading: Boolean = false) {
    Button(onClick = onClick, enabled = !loading, modifier = Modifier.fillMaxWidth().height(52.dp)) {
        if (loading) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
        else Text(text, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun SecondaryAction(text: String, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text(text) }
}

@Composable
private fun QuietAction(text: String, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = Modifier.fillMaxWidth()) { Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant) }
}
