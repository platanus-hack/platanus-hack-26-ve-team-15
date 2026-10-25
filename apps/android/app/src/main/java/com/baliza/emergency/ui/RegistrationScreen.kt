package com.baliza.emergency.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.ContactsContract
import android.view.View
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Contacts
import androidx.compose.material3.Icon
import androidx.compose.material3.TextButton
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.ui.platform.LocalContext
import com.baliza.emergency.app.ContactBook
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.toMutableStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.baliza.emergency.app.ContactDraft
import com.baliza.emergency.app.ContactProfile
import com.baliza.emergency.app.FormResult
import com.baliza.emergency.app.RegistrationForm

private const val FIELDS_PER_CONTACT = 3

private val stringListSaver = listSaver<androidx.compose.runtime.snapshots.SnapshotStateList<String>, String>(
    save = { it.toList() },
    restore = { it.toMutableStateList() }
)

/**
 * These fields hold other people's details. System autofill would fill them with the user's own name,
 * phone and email, so it is switched off for as long as the form is on screen.
 */
@Composable
private fun NoAutofill() {
    val view = LocalView.current
    DisposableEffect(view) {
        val previous = view.importantForAutofill
        view.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        onDispose { view.importantForAutofill = previous }
    }
}

/** First launch: who you are and who to warn. Needs internet once; what is typed survives a failure. */
@Composable
fun RegistrationScreen(
    initial: ContactProfile?,
    state: RegistrationUi,
    serverConfigured: Boolean,
    onSubmit: (ContactProfile) -> Unit,
    footer: @Composable () -> Unit = {}
) {
    var name by rememberSaveable { mutableStateOf(initial?.displayName.orEmpty()) }
    val fields = rememberSaveable(saver = stringListSaver) {
        val list = MutableList(RegistrationForm.MAX_CONTACTS * FIELDS_PER_CONTACT) { "" }
        initial?.contacts?.take(RegistrationForm.MAX_CONTACTS)?.forEachIndexed { i, c ->
            list[i * FIELDS_PER_CONTACT] = c.name
            list[i * FIELDS_PER_CONTACT + 1] = c.sms.orEmpty()
            list[i * FIELDS_PER_CONTACT + 2] = c.email.orEmpty()
        }
        list.toMutableStateList()
    }
    var visibleRows by rememberSaveable { mutableStateOf(maxOf(2, initial?.contacts?.size ?: 0)) }
    var formError by rememberSaveable { mutableStateOf<String?>(null) }
    val working = state is RegistrationUi.Working
    // At least one contact who can be reached is required; the button says so instead of failing on tap.
    val hasContact = (0 until visibleRows).any {
        fields[it * FIELDS_PER_CONTACT].isNotBlank() && (fields[it * FIELDS_PER_CONTACT + 1].isNotBlank() || fields[it * FIELDS_PER_CONTACT + 2].isNotBlank())
    }
    val ready = name.isNotBlank() && hasContact
    var pickingRow by rememberSaveable { mutableStateOf(-1) }
    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(PickPhoneContact) { uri ->
        val row = pickingRow
        pickingRow = -1
        val picked = uri?.let { readPickedPhone(context, it) } ?: return@rememberLauncherForActivityResult
        if (row !in 0 until visibleRows) return@rememberLauncherForActivityResult
        fields[row * FIELDS_PER_CONTACT] = picked.first
        fields[row * FIELDS_PER_CONTACT + 1] = picked.second.take(20)
        formError = null
    }
    NoAutofill()

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 36.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        BalizaBrand()
        Text("Configura Meshy", style = MaterialTheme.typography.headlineMedium)
        Text(
            "Necesitas internet una sola vez para registrar a quién avisar. Después, tu SOS saldrá aunque no haya red.",
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        OutlinedTextField(
            value = name, onValueChange = { name = it.take(40) }, label = { Text("Tu nombre") },
            singleLine = true, enabled = !working, modifier = Modifier.fillMaxWidth()
        )
        for (row in 0 until visibleRows) {
            val base = row * FIELDS_PER_CONTACT
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Text(if (row == 0) "Contacto de emergencia" else "Contacto ${row + 1}", style = MaterialTheme.typography.titleSmall)
                        Text(
                            if (row == 0) "Obligatorio" else "Opcional",
                            style = MaterialTheme.typography.labelMedium,
                            color = if (row == 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    TextButton(
                        enabled = !working,
                        onClick = {
                            pickingRow = row
                            try { picker.launch(Unit) } catch (_: ActivityNotFoundException) {
                                pickingRow = -1
                                formError = "Este teléfono no tiene una app de contactos. Escribe los datos a mano."
                            }
                        }
                    ) {
                        Icon(Icons.Filled.Contacts, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Elegir de mis contactos")
                    }
                    OutlinedTextField(
                        value = fields[base], onValueChange = { fields[base] = it.take(40) },
                        label = { Text("Nombre") }, singleLine = true, enabled = !working, modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = fields[base + 1], onValueChange = { fields[base + 1] = it.take(20) },
                        label = { Text("Teléfono (SMS y llamada)") }, singleLine = true, enabled = !working,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone), modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = fields[base + 2], onValueChange = { fields[base + 2] = it.take(80) },
                        label = { Text("Correo (opcional)") }, singleLine = true, enabled = !working,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth()
                    )
                }
            }
        }
        if (visibleRows < RegistrationForm.MAX_CONTACTS) {
            OutlinedButton(onClick = { visibleRows += 1 }, enabled = !working) { Text("Agregar otro contacto") }
        }

        val message = formError ?: (state as? RegistrationUi.Failed)?.message
        if (message != null) Text(message, color = MaterialTheme.colorScheme.error)
        if (!serverConfigured) {
            Text(
                "Esta versión no tiene servidor configurado, así que el registro no puede completarse todavía.",
                color = MaterialTheme.colorScheme.secondary
            )
        }

        if (!ready && !working) {
            Text(
                if (name.isBlank()) "Escribe tu nombre y al menos un contacto de emergencia con teléfono o correo."
                else "Agrega al menos un contacto de emergencia con nombre y teléfono o correo.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Button(
            enabled = !working && ready,
            modifier = Modifier.fillMaxWidth().height(52.dp),
            onClick = {
                val drafts = (0 until visibleRows).map { ContactDraft(fields[it * FIELDS_PER_CONTACT], fields[it * FIELDS_PER_CONTACT + 1], fields[it * FIELDS_PER_CONTACT + 2]) }
                when (val form = RegistrationForm.build(name, drafts)) {
                    is FormResult.Error -> formError = form.message
                    is FormResult.Ok -> { formError = null; onSubmit(form.value) }
                }
            }
        ) {
            if (working) CircularProgressIndicator(Modifier.height(22.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
            else Text(if (state is RegistrationUi.Failed) "Reintentar registro" else "Guardar y registrar")
        }
        Spacer(Modifier.height(8.dp))
        footer()
    }
}

/**
 * Opens the address book on phone numbers. Picking one grants read access to that single entry, so the app needs
 * no READ_CONTACTS permission and never sees the rest of the address book.
 */
private object PickPhoneContact : ActivityResultContract<Unit, Uri?>() {
    override fun createIntent(context: Context, input: Unit) = Intent(Intent.ACTION_PICK, ContactsContract.CommonDataKinds.Phone.CONTENT_URI)
    override fun parseResult(resultCode: Int, intent: Intent?): Uri? = if (resultCode == Activity.RESULT_OK) intent?.data else null
}

/** Name and number of the picked entry, cleaned for the form; null if it cannot be read. */
private fun readPickedPhone(context: Context, uri: Uri): Pair<String, String>? = try {
    val columns = arrayOf(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER)
    context.contentResolver.query(uri, columns, null, null, null)?.use { c ->
        if (!c.moveToFirst()) null
        else ContactBook.cleanName(c.getString(0).orEmpty()) to ContactBook.cleanPhone(c.getString(1).orEmpty())
    }
} catch (_: SecurityException) {
    null
}
