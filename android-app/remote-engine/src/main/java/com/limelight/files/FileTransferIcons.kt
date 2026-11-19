package com.limelight.files

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import java.util.Locale

internal enum class FileGlyph { BACK, NEXT, CLOSE, TRANSFER, COMPUTER, PHONE, FOLDER, NEW_FOLDER, FILE, IMAGE, ARCHIVE, CHECK, UPLOAD, DOWNLOAD, PAUSE, PLAY, RETRY }

@Composable internal fun FileIconButton(glyph: FileGlyph, label: String, tag: String, enabled: Boolean = true,
    tint: Color = MaterialTheme.colorScheme.onSurfaceVariant, click: () -> Unit) {
    IconButton(onClick = click, enabled = enabled, modifier = Modifier.size(44.dp).testTag(tag).semantics { contentDescription = label }) {
        FileIcon(glyph, Modifier.size(22.dp), if (enabled) tint else tint.copy(alpha = .35f))
    }
}

@Composable internal fun FileTypeIcon(name: String, directory: Boolean = false, small: Boolean = false) {
    val extension = name.substringAfterLast('.', "").lowercase(Locale.ROOT)
    val (glyph, color) = when {
        directory -> FileGlyph.FOLDER to Color(0xFFB38B4C)
        extension in listOf("png", "jpg", "jpeg", "gif", "webp", "heic", "svg") -> FileGlyph.IMAGE to Color(0xFF6B9891)
        extension in listOf("zip", "rar", "7z", "gz", "tar") -> FileGlyph.ARCHIVE to Color(0xFF967CBD)
        extension == "pdf" -> FileGlyph.FILE to Color(0xFFCF7769)
        else -> FileGlyph.FILE to Color(0xFF6C91C2)
    }
    Box(Modifier.size(if (small) 36.dp else 42.dp, if (small) 40.dp else 46.dp).background(color.copy(alpha = .12f), RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
        FileIcon(glyph, Modifier.size(if (small) 23.dp else 26.dp), color)
    }
}

/** Small stroked icons share the device sheet's quiet outline style. */
@Composable internal fun FileIcon(glyph: FileGlyph, modifier: Modifier = Modifier, tint: Color = LocalContentColor.current) {
    Canvas(modifier) {
        scale(size.width / 24f, size.height / 24f, pivot = Offset.Zero) {
            fun line(x1: Float, y1: Float, x2: Float, y2: Float) = drawLine(tint, Offset(x1, y1), Offset(x2, y2), strokeWidth = 1.65f, cap = StrokeCap.Round)
            fun path(vararg points: Float, close: Boolean = false) {
                val path = Path().apply { moveTo(points[0], points[1]); for (i in 2 until points.size step 2) lineTo(points[i], points[i + 1]); if (close) close() }
                drawPath(path, tint, style = Stroke(1.65f, cap = StrokeCap.Round))
            }
            fun folder() = path(3f, 6f, 9f, 6f, 11f, 9f, 21f, 9f, 21f, 20f, 3f, 20f, close = true)
            fun file() { path(5f, 3f, 14f, 3f, 20f, 9f, 20f, 21f, 5f, 21f, close = true); path(14f, 3f, 14f, 9f, 20f, 9f) }
            when (glyph) {
                FileGlyph.BACK -> path(15f, 5f, 8f, 12f, 15f, 19f)
                FileGlyph.NEXT -> path(9f, 5f, 16f, 12f, 9f, 19f)
                FileGlyph.CLOSE -> { line(6f, 6f, 18f, 18f); line(18f, 6f, 6f, 18f) }
                FileGlyph.CHECK -> path(5f, 12f, 10f, 17f, 19f, 7f)
                FileGlyph.COMPUTER -> { path(3f, 4f, 21f, 4f, 21f, 16f, 3f, 16f, close = true); line(12f, 16f, 12f, 21f); line(8f, 21f, 16f, 21f) }
                FileGlyph.PHONE -> { path(7f, 2f, 17f, 2f, 17f, 22f, 7f, 22f, close = true); line(11f, 19f, 13f, 19f) }
                FileGlyph.FOLDER -> { folder(); line(3f, 11f, 21f, 11f) }
                FileGlyph.NEW_FOLDER -> { folder(); line(12f, 12f, 12f, 17f); line(9.5f, 14.5f, 14.5f, 14.5f) }
                FileGlyph.FILE -> { file(); line(9f, 13f, 16f, 13f); line(9f, 17f, 14f, 17f) }
                FileGlyph.ARCHIVE -> { file(); line(11f, 4f, 11f, 6f); line(11f, 8f, 11f, 10f); line(11f, 12f, 11f, 14f); path(10f, 16f, 12f, 16f, 12f, 18f, 10f, 18f, close = true) }
                FileGlyph.IMAGE -> { path(3f, 3f, 21f, 3f, 21f, 21f, 3f, 21f, close = true); path(3f, 17f, 9f, 11f, 14f, 16f, 17f, 13f, 21f, 17f); drawCircle(tint, 1.8f, Offset(8f, 8f), style = Stroke(1.5f)) }
                FileGlyph.PAUSE -> { line(8f, 6f, 8f, 18f); line(16f, 6f, 16f, 18f) }
                FileGlyph.PLAY -> path(8f, 5f, 19f, 12f, 8f, 19f, close = true)
                FileGlyph.RETRY -> { drawArc(tint, 35f, 285f, false, Offset(4f, 4f), Size(16f, 16f), style = Stroke(1.65f, cap = StrokeCap.Round)); path(20f, 3f, 20f, 9f, 14f, 9f) }
                FileGlyph.TRANSFER -> { line(8f, 3f, 8f, 20f); path(3f, 8f, 8f, 3f, 13f, 8f); line(16f, 4f, 16f, 21f); path(11f, 16f, 16f, 21f, 21f, 16f) }
                FileGlyph.UPLOAD, FileGlyph.DOWNLOAD -> {
                    path(4f, 15f, 4f, 21f, 20f, 21f, 20f, 15f)
                    if (glyph == FileGlyph.UPLOAD) { line(12f, 3f, 12f, 16f); path(7f, 8f, 12f, 3f, 17f, 8f) }
                    else { line(12f, 3f, 12f, 16f); path(7f, 11f, 12f, 16f, 17f, 11f) }
                }
            }
        }
    }
}
