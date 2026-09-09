package com.cliprelay.app.ui

import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

@androidx.compose.runtime.Immutable
internal data class PreviewColors(val dark: Boolean) {
    val background = if (dark) Color(0xFF101214) else Color.White
    val text = if (dark) Color(0xFFF2F7FC) else Color(0xFF17191C)
    val secondary = if (dark) Color(0xFFAFC5D7) else Color(0xFF536170)
    val surface = if (dark) Color(0xFF20303D) else Color(0xFFEAF0F5)
    val code = if (dark) Color(0xFF19242E) else Color(0xFFF0F3F6)
    val inlineCode = if (dark) Color(0xFF304657) else Color(0xFFE1E8EE)
    val accent = if (dark) Color(0xFFA58AFF) else Color(0xFF6543C2)
    val link = if (dark) Color(0xFF6EDBEB) else Color(0xFF006B7A)
    val divider = if (dark) Color(0xFF456073) else Color(0xFFB5C2CE)
}

internal val LocalPreviewColors = staticCompositionLocalOf { PreviewColors(dark = true) }
