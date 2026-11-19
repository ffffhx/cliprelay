package com.cliprelay.app.ui

import android.graphics.Bitmap
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.test.platform.app.InstrumentationRegistry
import com.limelight.files.*
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** UI fixtures never touch the user's files or durable transfer journal. */
class FileTransferScreenTest {
    @get:Rule val rule = createComposeRule()
    private val sample = FileTransferState(hostName = "UCKF", root = "documents", path = "工作资料", connected = true,
        roots = listOf("home", "desktop", "documents", "downloads"), entries = listOf(
            RemoteFile("项目素材", true), RemoteFile("产品说明.pdf", size = 2516582), RemoteFile("界面预览.png", size = 3984589),
            RemoteFile("品牌素材.zip", size = 25794969), RemoteFile("项目说明.md", size = 16384), RemoteFile("受限文件", blocked = true)),
        jobs = listOf(TransferItem("up", "品牌素材.zip", "upload", "sending", 25794969, 9028239, "UCKF / 文档 / 工作资料"),
            TransferItem("down", "界面预览.png", "download", "receiving", 3984589, 2709520, "Download/ClipRelay"),
            TransferItem("done", "项目说明.md", "download", "complete", 16384, 16384, "Download/ClipRelay")))

    @Test fun selectionChangesPrimaryActionAndNeverSelectsFoldersOrBlockedFiles() {
        val state = mutableStateOf(sample)
        val actions = mutableListOf<FileAction>()
        rule.setContent { FileTransferTheme(false) { FileTransferScreen(state.value) { action ->
            actions += action
            if (action.kind == FileActionKind.SELECT) state.value = state.value.copy(selected = state.value.selected + action.value)
            if (action.kind == FileActionKind.CLEAR_SELECTION) state.value = state.value.copy(selected = emptySet())
        } } }
        rule.onNodeWithTag("files-upload").assertIsEnabled()
        rule.onNodeWithTag("file-产品说明.pdf").performClick()
        rule.onNodeWithTag("files-upload").assertDoesNotExist()
        rule.onNodeWithTag("files-download").assertIsEnabled().performClick()
        rule.runOnIdle { assertEquals(FileActionKind.DOWNLOAD, actions.last().kind) }
        rule.onNodeWithTag("files-back").performClick()
        rule.onNodeWithTag("files-upload").assertIsDisplayed()
        rule.onNodeWithTag("file-项目素材").performClick()
        rule.runOnIdle { assertEquals(FileAction(FileActionKind.OPEN_PATH, "工作资料/项目素材"), actions.last()) }
        rule.onNodeWithTag("files-list").performScrollToNode(hasTestTag("file-受限文件"))
        rule.onNodeWithTag("file-受限文件").assertIsNotEnabled()
    }

    @Test fun rootsAndPaginationRemainReachableAndLoadingDisablesWrites() {
        val state = mutableStateOf(sample.copy(root = "", path = ""))
        var last: FileAction? = null
        rule.setContent { FileTransferTheme { FileTransferScreen(state.value) { last = it } } }
        rule.onNodeWithTag("files-upload").assertIsNotEnabled()
        rule.onNodeWithTag("files-root-documents").performClick()
        rule.runOnIdle { assertEquals(FileAction(FileActionKind.OPEN_ROOT, "documents"), last); state.value = sample.copy(next = "page2") }
        rule.onNodeWithTag("files-list").performScrollToNode(hasTestTag("files-more"))
        rule.onNodeWithTag("files-more").performClick()
        rule.runOnIdle { assertEquals(FileActionKind.MORE, last?.kind); state.value = sample.copy(loading = true) }
        rule.onNodeWithTag("files-upload").assertIsNotEnabled()
        rule.onNodeWithTag("files-list").performScrollToIndex(0)
        rule.onNodeWithTag("files-mkdir").assertIsNotEnabled()
        rule.runOnIdle { state.value = sample.copy(error = "连接失败，请重试") }
        rule.onNodeWithTag("files-error").assertIsDisplayed()
        rule.onNodeWithTag("files-roots").performClick()
        rule.onNodeWithTag("files-roots-sheet").assertIsDisplayed()
        rule.onNodeWithTag("files-root-downloads").performClick()
        rule.runOnIdle { assertEquals(FileAction(FileActionKind.OPEN_ROOT, "downloads"), last) }
    }

    @Test fun cancellationRequiresConfirmationAndHistoryOnlyClearsRecord() {
        val actions = mutableListOf<FileAction>()
        rule.setContent { FileTransferTheme(false) { FileTransferScreen(sample.copy(showQueue = true), actions::add) } }
        rule.onNodeWithTag("transfer-pause-up").performClick()
        rule.runOnIdle { assertEquals(FileAction(FileActionKind.PAUSE, "up"), actions.last()) }
        rule.onNodeWithTag("transfer-cancel-up").performClick()
        rule.onNodeWithTag("files-cancel-dialog").assertIsDisplayed()
        rule.runOnIdle { assertEquals(1, actions.size) }
        rule.onNodeWithTag("files-keep-transfer").performClick()
        rule.onNodeWithTag("transfer-cancel-up").performClick()
        rule.onNodeWithTag("files-confirm-cancel").performClick()
        rule.runOnIdle { assertEquals(FileAction(FileActionKind.CANCEL, "up"), actions.last()) }
        rule.onNodeWithTag("files-history-tab").performClick()
        rule.onNodeWithTag("transfer-clear-done").performClick()
        rule.runOnIdle { assertEquals(FileAction(FileActionKind.FORGET, "done"), actions.last()) }
    }

    @Test fun pausedAndPendingCancellationUseTheCorrectResumeAction() {
        val state = mutableStateOf(sample.copy(showQueue = true, jobs = sample.jobs.take(2).map { it.copy(state = "paused") }))
        var last: FileAction? = null
        rule.setContent { FileTransferTheme { FileTransferScreen(state.value) { last = it } } }
        rule.onNodeWithTag("files-control-all").assertIsEnabled().performClick()
        rule.runOnIdle { assertEquals(FileActionKind.RESUME_ALL, last?.kind)
            state.value = state.value.copy(jobs = listOf(state.value.jobs.first().copy(cancelRequested = true, error = "取消尚未完成"))) }
        rule.onNodeWithTag("files-control-all").assertIsNotEnabled()
        rule.onNodeWithTag("transfer-cancel-up").assertIsNotEnabled()
        rule.onNodeWithTag("transfer-resume-up").performClick()
        rule.runOnIdle { assertEquals(FileAction(FileActionKind.RESUME, "up"), last) }
    }

    @Test fun folderNameMustBeValidBeforeCreation() {
        var last: FileAction? = null
        rule.setContent { FileTransferTheme { FileTransferScreen(sample) { last = it } } }
        rule.onNodeWithTag("files-mkdir").performClick()
        rule.onNodeWithTag("files-folder-create").assertIsNotEnabled()
        rule.onNodeWithTag("files-folder-name").performTextInput("../secret")
        rule.onNodeWithTag("files-folder-create").assertIsNotEnabled()
        rule.onNodeWithTag("files-folder-name").performTextReplacement("新资料")
        rule.onNodeWithTag("files-folder-create").assertIsEnabled().performClick()
        rule.runOnIdle { assertEquals(FileAction(FileActionKind.MKDIR, "新资料"), last) }
    }

    @Test fun finishingTheLastTransferShowsItsResultImmediately() {
        val state = mutableStateOf(sample.copy(showQueue = true, jobs = sample.jobs.take(1)))
        rule.setContent { FileTransferTheme { FileTransferScreen(state.value) {} } }
        rule.onNodeWithTag("files-active-tab").assertIsSelected()
        rule.runOnIdle { state.value = state.value.copy(jobs = state.value.jobs.map { it.copy(state = "complete", bytes = it.size) }) }
        rule.onNodeWithTag("files-history-tab").assertIsSelected()
        rule.onNodeWithTag("transfer-clear-up").assertIsDisplayed()
    }

    @Test fun designStatesAndLargeTextStayUsable() {
        val state = mutableStateOf(sample.copy(entries = sample.entries.take(5)))
        val dark = mutableStateOf(false)
        val scale = mutableFloatStateOf(1f)
        rule.setContent { CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, scale.floatValue)) {
            FileTransferTheme(dark.value) { FileTransferScreen(state.value) { if (it.kind == FileActionKind.HIDE_QUEUE) state.value = state.value.copy(showQueue = false) } }
        } }
        capture("files-light")
        rule.runOnIdle { state.value = state.value.copy(selected = setOf("产品说明.pdf", "界面预览.png")) }
        capture("files-selection")
        rule.runOnIdle { state.value = state.value.copy(selected = emptySet(), showQueue = true) }
        rule.onNodeWithTag("transfer-cancel-down").assertIsDisplayed()
        capture("files-tasks-light")
        rule.runOnIdle { dark.value = true }
        capture("files-tasks-dark")
        rule.runOnIdle { state.value = state.value.copy(showQueue = false) }
        capture("files-dark")
        rule.runOnIdle { scale.floatValue = 1.6f; state.value = state.value.copy(showQueue = true, jobs = sample.jobs.map { it.copy(name = "一份非常长的文件名称，用于验证大字体下的传输与暂停功能.pdf") }) }
        rule.onNodeWithTag("transfer-cancel-down").performScrollTo().assertIsDisplayed()
        rule.onNodeWithTag("files-control-all").assertIsDisplayed()
        capture("files-large-text")
    }

    private fun capture(name: String) {
        rule.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val tag = if (rule.onAllNodesWithTag("files-queue-sheet").fetchSemanticsNodes().isNotEmpty()) "files-queue-sheet" else "file-transfer-screen"
        val bitmap = rule.onNodeWithTag(tag).captureToImage().asAndroidBitmap()
        val directory = File(instrumentation.targetContext.getExternalFilesDir(null), "file-transfer-acceptance").apply { mkdirs() }
        File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
