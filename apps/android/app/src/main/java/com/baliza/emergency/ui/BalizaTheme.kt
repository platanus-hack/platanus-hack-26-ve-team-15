package com.baliza.emergency.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.material3.Typography
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily

/** Always dark and low glare: it is used in the worst moments, often at night. Red comes from the icon. */
object BalizaColors {
    val Red = Color(0xFFE53935)
    val RedDark = Color(0xFF8E1B1B)
    val Background = Color(0xFF111111)
    val Surface = Color(0xFF1C1C1E)
    val SurfaceHigh = Color(0xFF2A2A2D)
    val OnSurface = Color(0xFFF2F2F2)
    val Muted = Color(0xFFA0A0A6)
    val Good = Color(0xFF4CAF50)
    val Waiting = Color(0xFFFFB300)
}

private val scheme = darkColorScheme(
    primary = BalizaColors.Red,
    onPrimary = Color.White,
    primaryContainer = BalizaColors.RedDark,
    onPrimaryContainer = Color.White,
    secondary = BalizaColors.Waiting,
    secondaryContainer = BalizaColors.RedDark,
    onSecondaryContainer = Color.White,
    onSecondary = Color.Black,
    background = BalizaColors.Background,
    onBackground = BalizaColors.OnSurface,
    surface = BalizaColors.Surface,
    onSurface = BalizaColors.OnSurface,
    surfaceVariant = BalizaColors.SurfaceHigh,
    onSurfaceVariant = BalizaColors.Muted,
    outline = Color(0xFF3A3A3F),
    error = Color(0xFFFF6B6B),
    onError = Color.Black
)

/** bitchat's theme is monospace; this app is not, so every text style is set to the system sans. */
private val typography = Typography().let { t ->
    fun TextStyle.sans() = copy(fontFamily = FontFamily.SansSerif)
    Typography(
        displayLarge = t.displayLarge.sans(), displayMedium = t.displayMedium.sans(), displaySmall = t.displaySmall.sans(),
        headlineLarge = t.headlineLarge.sans(), headlineMedium = t.headlineMedium.sans(), headlineSmall = t.headlineSmall.sans(),
        titleLarge = t.titleLarge.sans(), titleMedium = t.titleMedium.sans(), titleSmall = t.titleSmall.sans(),
        bodyLarge = t.bodyLarge.sans(), bodyMedium = t.bodyMedium.sans(), bodySmall = t.bodySmall.sans(),
        labelLarge = t.labelLarge.sans(), labelMedium = t.labelMedium.sans(), labelSmall = t.labelSmall.sans()
    )
}

@Composable
fun BalizaTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, typography = typography, content = content)
}
