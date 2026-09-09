package com.cliprelay.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp
import com.cliprelay.app.data.FullscreenTextSize
import com.mikepenz.markdown.compose.components.markdownComponents
import com.mikepenz.markdown.compose.elements.MarkdownCodeBlock
import com.mikepenz.markdown.compose.elements.MarkdownCodeFence
import com.mikepenz.markdown.compose.elements.MarkdownHighlightedCode
import com.mikepenz.markdown.compose.elements.MarkdownTable
import com.mikepenz.markdown.compose.elements.MarkdownParagraph
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.rememberMarkdownState
import com.mikepenz.markdown.model.markdownAnnotator
import com.mikepenz.markdown.model.markdownAnnotatorConfig
import dev.snipme.highlights.Highlights
import dev.snipme.highlights.model.SyntaxThemes

/** Rendering is display-only; history and the full-text copy action retain the source. */
@Composable
internal fun MarkdownPreview(text: String, textSizeSp: Int, onHorizontalGesture: (Boolean) -> Unit = {}) {
    val size = FullscreenTextSize.normalize(textSizeSp)
    val body = TextStyle(fontSize = size.sp, lineHeight = FullscreenTextSize.lineHeight(size).sp)
    fun heading(scale: Float) = body.copy(
        fontSize = (size * scale).sp,
        lineHeight = (size * scale * 1.35f).sp,
        fontWeight = FontWeight.Bold,
    )
    val code = body.copy(fontFamily = FontFamily.Monospace, fontSize = (size * 0.9f).sp)
    val previewText = remember(text) { text.replace("\r\n", "\n").replace('\r', '\n') }
    val paragraphGap = with(LocalDensity.current) { body.lineHeight.toDp() }
    Markdown(
        markdownState = rememberMarkdownState(previewText),
        // Clipboard text uses single newlines as visible line breaks.
        annotator = remember { markdownAnnotator(markdownAnnotatorConfig(eolAsNewLine = true)) },
        colors = markdownColor(
            text = Color(0xFFF2F7FC),
            codeBackground = Color(0xFF122C40),
            inlineCodeBackground = Color(0xFF234357),
            dividerColor = Color(0xFF36566C),
            tableBackground = Color(0xFF10293C),
        ),
        typography = markdownTypography(
            h1 = heading(1.65f), h2 = heading(1.4f), h3 = heading(1.2f),
            h4 = heading(1.1f), h5 = heading(1f), h6 = heading(1f),
            text = body, paragraph = body, ordered = body, bullet = body,
            list = body, quote = body, table = body, code = code, inlineCode = code,
        ),
        components = markdownComponents(
            paragraph = { component ->
                MarkdownParagraph(
                    content = component.content,
                    node = component.node,
                    modifier = Modifier.padding(bottom = if (needsParagraphGap(component.content, component.node)) paragraphGap else 0.dp),
                    style = component.typography.paragraph,
                )
            },
            codeFence = { component ->
                MarkdownCodeFence(component.content, component.node, component.typography.code) { value, language, style ->
                    MarkdownScrollRegion(onHorizontalGesture) { RelayCodeBlock(value, language, style) }
                }
            },
            codeBlock = { component ->
                MarkdownCodeBlock(component.content, component.node, component.typography.code) { value, language, style ->
                    MarkdownScrollRegion(onHorizontalGesture) { RelayCodeBlock(value, language, style) }
                }
            },
            table = { component ->
                MarkdownScrollRegion(onHorizontalGesture) {
                    MarkdownTable(component.content, component.node, component.typography.table)
                }
            },
        ),
    )
}

/** A horizontal drag within code/tables must never turn the history page. */
@Composable
private fun MarkdownScrollRegion(onGesture: (Boolean) -> Unit, content: @Composable () -> Unit) {
    val currentCallback by androidx.compose.runtime.rememberUpdatedState(onGesture)
    val connection = remember {
        object : NestedScrollConnection {
            override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource) = Offset(available.x, 0f)
            override suspend fun onPostFling(consumed: Velocity, available: Velocity) = Velocity(available.x, 0f)
        }
    }
    Column(Modifier.nestedScroll(connection).pointerInput(Unit) {
        awaitEachGesture {
            awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            currentCallback(true)
            try {
                do { val event = awaitPointerEvent(PointerEventPass.Final) } while (event.changes.any { it.pressed })
            } finally { currentCallback(false) }
        }
    }) { content() }
}

@Composable
private fun RelayCodeBlock(code: String, language: String?, style: TextStyle) {
    val context = LocalContext.current
    var copied by remember(code) { mutableStateOf(false) }
    val highlighter = remember { Highlights.Builder().theme(SyntaxThemes.default(darkMode = true)) }
    Column(Modifier.testTag("markdown-code")) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(language?.takeIf { it.isNotBlank() } ?: "代码", color = Color(0xFF9CB7CC), fontSize = 12.sp)
            TextButton(onClick = {
                context.getSystemService(ClipboardManager::class.java)
                    .setPrimaryClip(ClipData.newPlainText("ClipRelay code", code))
                copied = true
            }) { Text(if (copied) "已复制" else "复制代码", color = Color(0xFF6EDBEB)) }
        }
        MarkdownHighlightedCode(code = code, language = language, style = style, highlightsBuilder = highlighter)
    }
}
