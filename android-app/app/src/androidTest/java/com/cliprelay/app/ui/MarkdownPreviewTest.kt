package com.cliprelay.app.ui

import android.content.ClipboardManager
import android.graphics.Bitmap
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeUp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cliprelay.app.MainActivity
import com.cliprelay.app.data.ReceivedClip
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class MarkdownPreviewTest {
    @get:Rule val rule = createAndroidComposeRule<MainActivity>()

    @Test fun controlsOverlayTextAndNewArrivalsStayDiscoverable() {
        val original = ReceivedClip(id = 1, text = "阅读中的正文", receivedAt = 0)
        val history = mutableStateOf(listOf(original))
        rule.activity.setContent {
            MaterialTheme {
                HistoryFullscreenViewer(
                    history = history.value, initialClipId = 1, onDismiss = {},
                    onCopy = {}, onSaveImage = {}, savingImageId = null,
                    copiedClipIds = emptySet(), savedImageIds = emptySet(),
                    fullscreenTextSizeSp = 17, onSetFullscreenTextSize = {}, onSetLandscape = {},
                )
            }
        }
        rule.waitUntil(10_000) {
            rule.onAllNodes(hasText(original.text), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        val before = rule.onNodeWithText(original.text, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        rule.onNodeWithText("隐藏控制").performClick()
        assertEquals(before, rule.onNodeWithText(original.text, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot)
        rule.runOnIdle {
            history.value = listOf(
                ReceivedClip(id = 3, text = "新到达的正文2", receivedAt = 2),
                ReceivedClip(id = 2, text = "新到达的正文1", receivedAt = 1), original,
            )
        }
        rule.onNodeWithText("收到 2 条新内容 · 点击查看").assertIsDisplayed()
        rule.onNodeWithText(original.text, useUnmergedTree = true).assertIsDisplayed()
        rule.onRoot().captureToImage().asAndroidBitmap().let { bitmap ->
            File(rule.activity.getExternalFilesDir(null), "arrival-banner-qa.png").outputStream().use {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
        rule.waitUntil(7_000) {
            rule.onAllNodes(hasText("新内容 2")).fetchSemanticsNodes().isNotEmpty()
        }
        rule.onNodeWithText("新内容 2").performClick()
        rule.waitUntil(5_000) {
            rule.onAllNodes(hasText("新到达的正文2")).fetchSemanticsNodes().isNotEmpty()
        }
        rule.onNodeWithText("新到达的正文2").assertIsDisplayed()
        rule.onNodeWithText("新内容 2").assertDoesNotExist()
    }

    @Test fun fullscreenSwitchesSourceAndKeepsReadingControls() {
        val source = "# 标题验收\n\n**加粗正文**与 `code`。"
        val clip = ReceivedClip(id = 1, text = source, receivedAt = 0)
        rule.activity.setContent {
            MaterialTheme {
                val size = remember { mutableIntStateOf(17) }
                HistoryFullscreenViewer(
                    history = listOf(clip), initialClipId = 1, onDismiss = {},
                    onCopy = {}, onSaveImage = {}, savingImageId = null,
                    copiedClipIds = emptySet(), savedImageIds = emptySet(),
                    fullscreenTextSizeSp = size.intValue,
                    onSetFullscreenTextSize = { size.intValue = it },
                    onSetLandscape = {},
                )
            }
        }
        rule.waitUntil(10_000) {
            rule.onAllNodes(androidx.compose.ui.test.hasText("标题验收")).fetchSemanticsNodes().isNotEmpty()
        }
        rule.onNodeWithText("查看原文").performClick()
        rule.onNodeWithText(source).assertIsDisplayed()
        rule.onNodeWithText("Markdown 预览").performClick()
        rule.onNodeWithText("A+").performClick()
        rule.onNodeWithText("19 sp").assertIsDisplayed()
        rule.onNodeWithText("横屏").assertIsDisplayed()
    }

    @Test fun rendersMarkdownAndCopiesOnlyCode() {
        val code = "fun greet(name: String): String {\n    return \"Hello, ${'$'}name! This deliberately long line checks horizontal scrolling without changing the history page.\"\n}"
        val markdown = """
            # Markdown 预览验收

            正文支持 **加粗**、*斜体* 和 `git revert`。

            ## 操作步骤

            1. 复制 Markdown 原文。
            2. 在手机上打开预览。

            > 引用内容保留层次。

            ```kotlin
            CODE_PLACEHOLDER
            ```

            | 功能 | 效果 |
            | --- | --- |
            | 标题 | 分级字号 |
            | 代码 | 保留缩进 |
        """.trimIndent().replace("CODE_PLACEHOLDER", code)
        rule.activity.setContent {
            MaterialTheme {
                HistoryFullscreenViewer(
                    history = listOf(
                        ReceivedClip(id = 1, text = markdown, receivedAt = 0),
                        ReceivedClip(id = 2, text = "相邻记录", receivedAt = 0),
                    ), initialClipId = 1, onDismiss = {},
                    onCopy = {}, onSaveImage = {}, savingImageId = null,
                    copiedClipIds = emptySet(), savedImageIds = emptySet(),
                    fullscreenTextSizeSp = 17, onSetFullscreenTextSize = {},
                    onSetLandscape = { landscape ->
                        rule.activity.requestedOrientation = if (landscape)
                            android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
                        else android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                    },
                )
            }
        }
        rule.waitUntil(10_000) {
            rule.onAllNodes(androidx.compose.ui.test.hasText("Markdown 预览验收")).fetchSemanticsNodes().isNotEmpty()
        }
        rule.onNodeWithText("Markdown 预览验收").assertIsDisplayed()
        val directory = rule.activity.getExternalFilesDir(null)!!
        rule.onRoot().captureToImage().asAndroidBitmap().let { bitmap ->
            File(directory, "markdown-preview-qa.png").outputStream().use {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
        rule.onNodeWithText("复制代码").performScrollTo().performClick()
        rule.runOnIdle {
            val clipboard = rule.activity.getSystemService(ClipboardManager::class.java)
            assertEquals(code, clipboard.primaryClip!!.getItemAt(0).text.toString())
        }
        rule.onNodeWithText("已复制").assertIsDisplayed()
        rule.onNodeWithTag("markdown-code", useUnmergedTree = true).performTouchInput { swipeLeft() }
        rule.onRoot().captureToImage().asAndroidBitmap().let { bitmap ->
            File(directory, "markdown-scroll-qa.png").outputStream().use {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
        rule.onNodeWithText("01 / 02").assertExists()
        rule.onNode(hasTestTag("markdown-reader") and hasAnyDescendant(hasText("Markdown 预览验收")), useUnmergedTree = true).performTouchInput { swipeUp() }
        rule.onNodeWithText("保留缩进", substring = true, useUnmergedTree = true).assertIsDisplayed()
        rule.onRoot().captureToImage().asAndroidBitmap().let { bitmap ->
            File(directory, "markdown-table-qa.png").outputStream().use {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
        rule.onNodeWithText("横屏").performClick()
        rule.waitUntil(5_000) {
            rule.activity.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE
        }
        rule.onNodeWithText("左右滑动 · 隐藏").performClick()
        rule.onNode(hasTestTag("markdown-reader") and hasAnyDescendant(hasText("Markdown 预览验收")), useUnmergedTree = true).performTouchInput { swipeUp() }
        rule.onNodeWithText("保留缩进", substring = true, useUnmergedTree = true).assertIsDisplayed()
        rule.onRoot().captureToImage().asAndroidBitmap().let { bitmap ->
            File(directory, "markdown-landscape-qa.png").outputStream().use {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
        rule.runOnIdle { rule.activity.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
    }
}
