package com.baliza.emergency.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.baliza.emergency.app.EmergencyApp

/** Entry point of the Baliza Vital interface (replaces bitchat's chat as the home screen). */
@Composable
fun BalizaRoot(vm: BalizaViewModel, onOpenBitchat: () -> Unit) {
    BalizaTheme {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            // Edge to edge: the background goes behind the system bars, the content stays clear of them and of the keyboard.
            Box(Modifier.fillMaxSize().safeDrawingPadding()) {
                val boot by vm.boot.collectAsState()
                when (val b = boot) {
                    is EmergencyApp.Boot.Loading -> Centered { CircularProgressIndicator(); Text("Preparando tu baliza…") }
                    is EmergencyApp.Boot.Failed -> Centered {
                        Text("No pude preparar la baliza.", style = MaterialTheme.typography.titleMedium)
                        Text(b.message, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                    }
                    is EmergencyApp.Boot.Ready -> ReadyContent(vm, b.engine, onOpenBitchat)
                }
            }
        }
    }
}

@Composable
private fun ReadyContent(vm: BalizaViewModel, engine: EmergencyApp.Engine, onOpenBitchat: () -> Unit) {
    val registered by engine.registered.collectAsState()
    val profile by engine.profile.collectAsState()
    val status by engine.sosStatus.collectAsState()
    val replies by engine.replies.collectAsState()
    val ask by engine.askStatus.collectAsState()
    val askError by vm.askError.collectAsState()
    val pay by engine.payStatus.collectAsState()
    val payError by vm.payError.collectAsState()
    val inviteError by vm.inviteError.collectAsState()
    val context = androidx.compose.ui.platform.LocalContext.current
    val registration by vm.registration.collectAsState()
    val sosError by vm.sosError.collectAsState()
    var showDebug by rememberSaveable { mutableStateOf(false) }
    // Held here, above the debug/SOS switch, so visiting the debug panel does not reset the choices.
    val form = rememberSaveable(saver = SosFormState.Saver) { SosFormState() }
    val current = profile
    LaunchedEffect(current?.contacts?.map { it.index }) { current?.let { form.reconcile(it.contacts.map { c -> c.index }) } }
    val debug = com.bitchat.android.BuildConfig.DEBUG

    if (debug && showDebug) {
        DebugScreen(vm, engine, onBack = { showDebug = false }, onOpenBitchat = onOpenBitchat)
        return
    }

    val debugButton: @Composable () -> Unit = {
        if (debug) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = { showDebug = true }) { Text("Depuración") }
        }
    }

    val inviteStep by engine.inviteStep.collectAsState()
    if (!registered || current == null) {
        RegistrationScreen(
            initial = current,
            state = registration,
            serverConfigured = vm.settings.baseUrl.isNotBlank(),
            onSubmit = { vm.register(engine, it) },
            footer = debugButton
        )
    } else if (inviteStep) {
        InviteStepScreen(
            contacts = current.contacts,
            error = inviteError,
            onInvite = { index -> vm.invite(engine, index) { link -> openLink(context, link) } },
            onDone = { vm.clearInviteError(); engine.finishInviteStep() }
        )
    } else {
        SosScreen(
            profile = current,
            form = form,
            replies = replies,
            status = status,
            ask = ask,
            askError = askError,
            pay = pay,
            payError = payError,
            error = sosError,
            onAsk = { vm.ask(engine, it) },
            onResetAsk = { vm.resetAsk(engine) },
            onPay = { vm.pay(engine, it) },
            onResetPay = { vm.resetPay(engine) },
            canInvite = engine.whatsappNumber.isNotBlank(),
            inviteError = inviteError,
            onInvite = { index -> vm.invite(engine, index) { link -> openLink(context, link) } },
            onCloseInvite = vm::clearInviteError,
            onStart = { category, severity, text, note, contacts -> vm.startSos(engine, category, severity, text, note, contacts) },
            onCancel = { vm.cancelSos(engine) },
            onDismissError = vm::clearSosError,
            header = {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    BalizaBrand()
                    debugButton()
                }
            }
        )
    }
}

@Composable
private fun Centered(content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally
    ) { content() }
}

/** Opens a wa.me link: WhatsApp if installed, the browser otherwise. */
private fun openLink(context: android.content.Context, link: String) {
    try {
        context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(link)))
    } catch (_: android.content.ActivityNotFoundException) {
        // Nothing on this phone opens links: there is no WhatsApp to invite through.
    }
}
