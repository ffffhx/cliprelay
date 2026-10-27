package com.cliprelay.app.ui

import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.cliprelay.app.data.AppSettings
import com.cliprelay.app.runtime.ReceiverPhase
import com.cliprelay.app.runtime.ReceiverStatus
import com.cliprelay.app.ui.theme.ClipRelayTheme
import com.cliprelay.app.update.UpdateState
import com.limelight.nvstream.http.ComputerDetails.State
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Isolated state: never changes the phone's saved computers or starts a stream. */
class DeviceHomeUiTest {
    @get:Rule val rule = createComposeRule()
    private val first = HomeComputer("uckf", "ClipRelay - UCKF", State.ONLINE)
    private val second = HomeComputer("yifan", "ClipRelay - YIFAN", State.ONLINE)

    @Test fun homeConnectsSelectedComputerInPlaceAndCanCancel() {
        val connecting = mutableStateOf<String?>(null)
        rule.setContent { Home(listOf(first, second), connecting = connecting.value,
            connect = { connecting.value = it }, cancel = { connecting.value = null }) }
        rule.onNodeWithText("剪贴板接收已开启").assertIsDisplayed()
        rule.onNodeWithText("ClipRelay - UCKF").assertDoesNotExist()
        rule.onNodeWithTag("connect-uckf").performClick()
        rule.runOnIdle { assertEquals("uckf", connecting.value) }
        rule.onNodeWithText("正在连接…").assertIsDisplayed()
        rule.onNodeWithTag("connect-yifan").assertIsNotEnabled()
        rule.onNodeWithTag("add-computer-sheet").assertDoesNotExist()
        rule.onNodeWithTag("connect-uckf").performClick()
        rule.runOnIdle { assertNull(connecting.value) }
        rule.onNodeWithTag("connect-yifan").assertIsEnabled()
        rule.onNodeWithText("最近收到").assertIsDisplayed()
    }

    @Test fun addSheetOnlyShowsNewComputerAndAddsItWithoutOpeningAnotherPicker() {
        val saved = mutableStateOf(listOf(first))
        val nearby = mutableStateOf(listOf(second))
        rule.setContent { Home(saved.value, nearby.value, add = {
            saved.value += second
            nearby.value = emptyList()
        }) }
        rule.onNodeWithTag("add-computer").performClick()
        rule.onNodeWithTag("nearby-yifan").assertIsDisplayed()
        rule.onNodeWithTag("nearby-uckf").assertDoesNotExist()
        rule.onNodeWithText("添加", substring = false).performClick()
        rule.onNodeWithTag("add-computer-sheet").assertDoesNotExist()
        rule.onNodeWithTag("computer-yifan").assertIsDisplayed()
        rule.onNodeWithTag("add-computer").performClick()
        rule.onNodeWithTag("nearby-yifan").assertDoesNotExist()
        rule.onNodeWithText("输入电脑地址").assertIsDisplayed()
        rule.onNodeWithText("使用配对码").assertIsDisplayed()
    }

    @Test fun offlineRetryDoesNotLaunchAConnectionAndManualEntryClosesSheet() {
        var scans = 0
        var connects = 0
        var addresses = 0
        rule.setContent { Home(listOf(first.copy(state = State.OFFLINE)),
            connect = { connects++ }, rescan = { scans++ }, address = { addresses++ }) }
        rule.onNodeWithText("离线").assertIsDisplayed()
        rule.onNodeWithTag("connect-uckf").performClick()
        rule.runOnIdle { assertEquals(1, scans); assertEquals(0, connects) }
        rule.onNodeWithTag("add-computer").performClick()
        rule.onNodeWithText("输入电脑地址").performClick()
        rule.runOnIdle { assertEquals(1, addresses) }
        rule.onNodeWithTag("add-computer-sheet").assertDoesNotExist()
    }

    @Composable private fun Home(
        computers: List<HomeComputer>, nearby: List<HomeComputer> = emptyList(),
        connecting: String? = null, connect: (String) -> Unit = {}, cancel: () -> Unit = {},
        add: (String) -> Unit = {}, rescan: () -> Unit = {}, address: () -> Unit = {},
    ) {
        ClipRelayTheme {
            ClipRelayScreen(ReceiverStatus(ReceiverPhase.RUNNING),
                AppSettings(47632, true, true, "", 24, "Test", true), emptyList(), UpdateState(),
                onToggleReceiver = {}, onSaveSettings = {}, onCopyClip = {}, onSaveImage = {},
                savingImageId = null, copiedClipIds = emptySet(), savedImageIds = emptySet(),
                onSetFullscreenTextSize = {}, onSetFullscreenDarkMode = {}, onSetFullscreenLandscape = {},
                onSetImmersiveFullscreen = {}, onCopyEndpoint = {}, onShareEndpoint = {}, onClearHistory = {},
                onCheckUpdate = {}, onDownloadUpdate = {}, onInstallUpdate = {},
                computers = computers, nearbyComputers = nearby, connectingComputer = connecting,
                onConnectComputer = connect, onCancelConnection = cancel, onAddComputer = add,
                onRescanComputers = rescan, onAddAddress = address)
        }
    }
}
