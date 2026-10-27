package com.cliprelay.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

val RelayBlue = Color(0xFF3F5ED7)
val SignalCyan = Color(0xFF338267)
val RelayViolet = Color(0xFF3F5ED7)
val DeepRelay = Color(0xFF0B1F33)
val PaperBlue = Color(0xFFF7F8FA)
val Ink = Color(0xFF202633)

private val LightColors = lightColorScheme(
    primary = RelayBlue,
    onPrimary = Color.White,
    secondaryContainer = Color(0xFFE8EEFF),
    onSecondaryContainer = RelayBlue,
    secondary = RelayViolet,
    tertiary = SignalCyan,
    background = PaperBlue,
    onBackground = Ink,
    surface = Color.White,
    onSurface = Ink,
    surfaceVariant = Color(0xFFF1F3F7),
    onSurfaceVariant = Color(0xFF737C8B),
    outline = Color(0xFFDDE2EA),
    error = Color(0xFFB42318),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF7AB7FF),
    onPrimary = Color(0xFF002D52),
    secondaryContainer = Color(0xFF243B5E),
    onSecondaryContainer = Color(0xFF7AB7FF),
    secondary = Color(0xFFBEA9FF),
    tertiary = SignalCyan,
    background = Color(0xFF181C24),
    onBackground = Color(0xFFE8F1FA),
    surface = Color(0xFF20252F),
    onSurface = Color(0xFFE8F1FA),
    surfaceVariant = Color(0xFF2A303C),
    onSurfaceVariant = Color(0xFFB8C8D8),
    outline = Color(0xFF50677A),
    error = Color(0xFFFFB4AB),
)

private val ClipRelayTypography = Typography(
    displaySmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 34.sp,
        lineHeight = 38.sp,
        letterSpacing = (-0.7).sp,
    ),
    headlineSmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 22.sp,
        lineHeight = 28.sp,
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 16.sp,
        lineHeight = 22.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp,
        lineHeight = 24.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 21.sp,
    ),
    labelLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    ),
)

@Composable
fun ClipRelayTheme(content: @Composable () -> Unit) {
    val darkTheme = isSystemInDarkTheme()
    val colorScheme = if (darkTheme) DarkColors else LightColors

    MaterialTheme(
        colorScheme = colorScheme,
        typography = ClipRelayTypography,
        content = content,
    )
}
