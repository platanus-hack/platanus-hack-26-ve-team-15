package com.baliza.emergency.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.baliza.emergency.app.ContactProfile
import com.baliza.emergency.app.EmergencyApp
import com.baliza.emergency.ask.AskStart
import com.baliza.emergency.pay.PayStart
import com.baliza.emergency.pay.PaymentRequest
import com.baliza.emergency.registration.RegistrationResult
import com.baliza.emergency.sos.StartResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** What the registration screen shows while and after trying to register. */
sealed interface RegistrationUi {
    object Idle : RegistrationUi
    object Working : RegistrationUi

    /** [saved]: the contacts are kept on the phone, so only the server step is pending. */
    class Failed(val message: String, val saved: Boolean) : RegistrationUi
}

/**
 * Screen-facing glue. The emergency stack itself lives in [EmergencyApp] (it must outlive this),
 * this only turns results into messages and keeps one-off UI state across rotation.
 */
class BalizaViewModel(app: Application) : AndroidViewModel(app) {
    private val emergency = EmergencyApp.get(app)

    val boot: StateFlow<EmergencyApp.Boot> = emergency.boot
    val settings = emergency.settings

    private val _registration = MutableStateFlow<RegistrationUi>(RegistrationUi.Idle)
    val registration: StateFlow<RegistrationUi> = _registration.asStateFlow()

    private val _sosError = MutableStateFlow<String?>(null)
    val sosError: StateFlow<String?> = _sosError.asStateFlow()

    fun register(engine: EmergencyApp.Engine, profile: ContactProfile) {
        if (_registration.value is RegistrationUi.Working) return
        _registration.value = RegistrationUi.Working
        viewModelScope.launch {
            _registration.value = when (val result = engine.register(profile)) {
                is RegistrationResult.Success -> RegistrationUi.Idle
                else -> RegistrationUi.Failed(registrationMessage(result), saved = true)
            }
        }
    }

    fun startSos(engine: EmergencyApp.Engine, category: Int, severity: Int, text: String, note: String, contacts: Set<Int>) {
        _sosError.value = null
        viewModelScope.launch {
            val result = engine.startSos(category, severity, text, note, contacts)
            _sosError.value = sosMessage(result)
        }
    }

    private val _askError = MutableStateFlow<String?>(null)
    val askError: StateFlow<String?> = _askError.asStateFlow()

    fun ask(engine: EmergencyApp.Engine, question: String) {
        _askError.value = null
        viewModelScope.launch { _askError.value = askMessage(engine.ask(question)) }
    }

    fun resetAsk(engine: EmergencyApp.Engine) {
        _askError.value = null
        viewModelScope.launch { engine.resetAsk() }
    }

    private val _payError = MutableStateFlow<String?>(null)
    val payError: StateFlow<String?> = _payError.asStateFlow()

    fun pay(engine: EmergencyApp.Engine, request: PaymentRequest) {
        _payError.value = null
        viewModelScope.launch { _payError.value = payMessage(engine.pay(request)) }
    }

    fun resetPay(engine: EmergencyApp.Engine) {
        _payError.value = null
        viewModelScope.launch { engine.resetPay() }
    }

    fun cancelSos(engine: EmergencyApp.Engine) {
        viewModelScope.launch { engine.cancelSos() }
    }

    fun sendTestPacket(engine: EmergencyApp.Engine) {
        viewModelScope.launch { engine.sendTestPacket() }
    }

    fun resetForTesting(engine: EmergencyApp.Engine) {
        viewModelScope.launch { engine.resetForTesting() }
    }

    fun clearSosError() { _sosError.value = null }

    companion object {
        fun registrationMessage(result: RegistrationResult): String = when (result) {
            is RegistrationResult.Success -> ""
            is RegistrationResult.Network ->
                "No hay conexión con el servidor. Tus contactos quedaron guardados: vuelve a intentarlo cuando tengas internet."
            is RegistrationResult.Rejected ->
                "El servidor respondió con un error (${result.httpCode}). Inténtalo de nuevo en un momento."
            is RegistrationResult.BadResponse -> "El servidor respondió algo inesperado. No es seguro continuar."
            is RegistrationResult.InvalidInput -> result.reason
            is RegistrationResult.ServerKeyChanged ->
                "Las llaves del servidor cambiaron desde tu primer registro. Por seguridad no continúo."
        }

        fun askMessage(result: AskStart): String? = when (result) {
            is AskStart.Started -> null
            is AskStart.Busy -> "Ya hay una pregunta en curso."
            is AskStart.NotRegistered -> "Falta completar el registro."
            is AskStart.NoIncident -> "Primero espera la confirmación de tu aviso."
            is AskStart.Invalid -> "No se pudo preparar la pregunta: ${result.reason}."
        }

        fun payMessage(result: PayStart): String? = when (result) {
            is PayStart.Started -> null
            is PayStart.Busy -> "Ya hay un pago en curso."
            is PayStart.NotRegistered -> "Falta completar el registro."
            is PayStart.NoIncident -> "Primero espera la confirmación de tu aviso."
            is PayStart.Invalid -> result.reason
        }

        fun sosMessage(result: StartResult): String? = when (result) {
            is StartResult.Started -> null
            is StartResult.AlreadyActive -> "Ya hay un aviso en curso."
            is StartResult.NotRegistered -> "Falta completar el registro: sin él el SOS no puede enviarse."
            is StartResult.Invalid -> "No se pudo preparar el aviso: ${result.reason}."
        }
    }
}
