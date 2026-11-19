package com.cliprelay.app.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/** Small, consistent outline set matching the device action design. */
internal object DeviceActionIcons {
    private fun outline(name: String, draw: PathBuilder.() -> Unit) = ImageVector.Builder(
        name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f,
    ).apply {
        path(stroke = SolidColor(Color.Black), strokeLineWidth = 1.7f,
            strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round, pathBuilder = draw)
    }.build()

    val Folder = outline("Folder") {
        moveTo(3f, 8f); lineTo(3f, 6f); curveTo(3f, 5f, 4f, 4f, 5f, 4f)
        lineTo(10f, 4f); lineTo(12f, 7f); lineTo(19f, 7f); curveTo(20f, 7f, 21f, 8f, 21f, 9f)
        lineTo(21f, 18f); curveTo(21f, 19f, 20f, 20f, 19f, 20f)
        lineTo(5f, 20f); curveTo(4f, 20f, 3f, 19f, 3f, 18f); close()
        moveTo(3f, 10f); lineTo(21f, 10f)
    }
    val Terminal = outline("Terminal") {
        moveTo(6f, 4f); lineTo(18f, 4f); curveTo(20f, 4f, 21f, 5f, 21f, 7f)
        lineTo(21f, 17f); curveTo(21f, 19f, 20f, 20f, 18f, 20f)
        lineTo(6f, 20f); curveTo(4f, 20f, 3f, 19f, 3f, 17f)
        lineTo(3f, 7f); curveTo(3f, 5f, 4f, 4f, 6f, 4f); close()
        moveTo(7f, 9f); lineTo(10f, 12f); lineTo(7f, 15f)
        moveTo(13f, 15f); lineTo(17f, 15f)
    }
    val Sessions = outline("Sessions") {
        moveTo(8f, 5f); lineTo(8f, 4f); curveTo(8f, 3f, 9f, 2f, 10f, 2f)
        lineTo(20f, 2f); curveTo(21f, 2f, 22f, 3f, 22f, 4f)
        lineTo(22f, 14f); curveTo(22f, 15f, 21f, 16f, 19f, 16f)
        moveTo(5f, 8f); lineTo(13f, 8f); curveTo(15f, 8f, 16f, 9f, 16f, 11f)
        lineTo(16f, 19f); curveTo(16f, 21f, 15f, 22f, 13f, 22f)
        lineTo(5f, 22f); curveTo(3f, 22f, 2f, 21f, 2f, 19f)
        lineTo(2f, 11f); curveTo(2f, 9f, 3f, 8f, 5f, 8f); close()
        moveTo(5.5f, 12f); lineTo(8.5f, 15f); lineTo(5.5f, 18f)
        moveTo(10.5f, 17f); lineTo(12.5f, 17f)
    }
    val Link = outline("Link") {
        moveTo(10f, 14f); lineTo(14f, 10f)
        moveTo(8f, 16f); lineTo(7f, 17f); curveTo(3f, 21f, -1f, 15f, 3f, 11f)
        lineTo(7f, 7f); curveTo(8f, 6f, 10f, 6f, 11f, 7f)
        moveTo(13f, 17f); curveTo(14f, 18f, 16f, 18f, 17f, 17f)
        lineTo(21f, 13f); curveTo(25f, 9f, 20f, 3f, 16f, 7f); lineTo(15f, 8f)
    }
    val Power = outline("Power") {
        moveTo(12f, 2f); lineTo(12f, 12f)
        moveTo(7f, 5f); curveTo(0f, 9f, 2f, 22f, 12f, 22f); curveTo(22f, 22f, 24f, 9f, 17f, 5f)
    }
    val Sliders = outline("Sliders") {
        moveTo(4f, 7f); lineTo(7f, 7f); moveTo(13f, 7f); lineTo(20f, 7f)
        moveTo(4f, 17f); lineTo(13f, 17f); moveTo(19f, 17f); lineTo(20f, 17f)
        moveTo(13f, 7f); curveTo(13f, 11f, 7f, 11f, 7f, 7f); curveTo(7f, 3f, 13f, 3f, 13f, 7f); close()
        moveTo(19f, 17f); curveTo(19f, 21f, 13f, 21f, 13f, 17f); curveTo(13f, 13f, 19f, 13f, 19f, 17f); close()
    }
    val Trash = outline("Trash") {
        moveTo(3f, 6f); lineTo(21f, 6f); moveTo(9f, 6f); lineTo(9f, 3f); lineTo(15f, 3f); lineTo(15f, 6f)
        moveTo(5f, 6f); lineTo(6f, 20f); lineTo(7f, 21f); lineTo(17f, 21f); lineTo(18f, 20f); lineTo(19f, 6f)
        moveTo(10f, 10f); lineTo(10f, 17f); moveTo(14f, 10f); lineTo(14f, 17f)
    }
    val Chevron = outline("Chevron") { moveTo(9f, 5f); lineTo(16f, 12f); lineTo(9f, 19f) }
    val Back = outline("Back") { moveTo(14f, 5f); lineTo(7f, 12f); lineTo(14f, 19f) }
    val Close = outline("Close") { moveTo(6f, 6f); lineTo(18f, 18f); moveTo(6f, 18f); lineTo(18f, 6f) }
}
