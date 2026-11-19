package com.cliprelay.app.ui

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.test.platform.app.InstrumentationRegistry
import com.cliprelay.app.ui.theme.ClipRelayTheme
import com.limelight.PcView.ComputerAction
import com.limelight.nvstream.http.ComputerDetails.State
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Uses sample state only: never deletes a saved computer or opens a remote session. */
class ComputerActionsSheetTest {
    @get:Rule val rule = createComposeRule()
    private val online = HomeComputer("sample", "ClipRelay - 工作电脑", State.ONLINE,
        address = "192.168.1.24:47989", paired = true, hasCertificate = true)

    @Test fun allToolsDispatchTheSelectedActionAndClose() {
        val shown = mutableStateOf(true)
        val actions = mutableListOf<ComputerAction>()
        rule.setContent {
            ClipRelayTheme(darkTheme = false) {
                if (shown.value) ComputerActionsSheet(online, { shown.value = false }, {
                    actions += it; shown.value = false
                })
            }
        }
        val cases = listOf("files" to ComputerAction.FILES, "terminal" to ComputerAction.TERMINAL,
            "herdr" to ComputerAction.HERDR, "wake-settings" to ComputerAction.WAKE_SETTINGS)
        for ((tag, action) in cases) {
            rule.runOnIdle { shown.value = true }
            rule.onNodeWithTag("device-action-$tag").performScrollTo().assertIsEnabled().performClick()
            rule.runOnIdle { assertEquals(action, actions.last()); assertFalse(shown.value) }
            rule.onNodeWithTag("computer-actions-sheet").assertDoesNotExist()
        }
        assertEquals(cases.size, actions.size)
    }

    @Test fun availabilityUpdatesWhileOpenAndWakeOnlyRunsOffline() {
        val device = mutableStateOf(online)
        var action: ComputerAction? = null
        rule.setContent { ClipRelayTheme { ComputerActionsSheet(device.value, {}, { action = it }) } }
        rule.onNodeWithTag("device-action-wake").assertIsNotEnabled()
        rule.onNodeWithTag("device-action-files").assertIsEnabled()
        rule.runOnIdle { device.value = online.copy(state = State.OFFLINE) }
        listOf("files", "terminal", "herdr", "wake-settings").forEach {
            rule.onNodeWithTag("device-action-$it").assertIsNotEnabled()
        }
        rule.onNodeWithText("连接电脑后，即可使用以上功能").assertIsDisplayed()
        rule.onNodeWithTag("device-action-wake").assertIsEnabled().performClick()
        rule.runOnIdle { assertEquals(ComputerAction.WAKE, action); device.value = online.copy(state = State.UNKNOWN) }
        rule.onNodeWithTag("device-action-wake").assertIsNotEnabled()
        rule.runOnIdle { device.value = online.copy(paired = false) }
        rule.onNodeWithTag("device-action-files").assertIsNotEnabled()
        rule.onNodeWithTag("device-action-wake-settings").assertIsNotEnabled()
        rule.runOnIdle { device.value = online.copy(address = null) }
        rule.onNodeWithTag("device-action-terminal").assertIsNotEnabled()
        rule.runOnIdle { device.value = online.copy(hasCertificate = false) }
        rule.onNodeWithTag("device-action-wake-settings").assertIsNotEnabled()
    }

    @Test fun detailsReflectLiveConnectionAndDoNotShowStaleOfflineAddress() {
        val device = mutableStateOf(online.copy(crossNetwork = true))
        rule.setContent { ClipRelayTheme { ComputerActionsSheet(device.value, {}, {}) } }
        rule.onNodeWithTag("device-action-details").performClick()
        rule.onNodeWithTag("device-connection-details").assertIsDisplayed()
        rule.onNodeWithText("跨网络连接").assertIsDisplayed()
        rule.onNodeWithText("192.168.1.24:47989").assertIsDisplayed()
        rule.runOnIdle { device.value = online.copy(state = State.OFFLINE) }
        rule.onNodeWithText("192.168.1.24:47989").assertDoesNotExist()
        rule.onNodeWithText("暂不可用").assertIsDisplayed()
        rule.onNodeWithTag("device-actions-back").performClick()
        rule.onNodeWithTag("device-action-remove").performScrollTo().assertIsDisplayed()
    }

    @Test fun removalRequiresConfirmationAndCancelKeepsTheDevice() {
        var removed = 0
        rule.setContent { ClipRelayTheme { ComputerActionsSheet(online, {}, { if (it == ComputerAction.REMOVE) removed++ }) } }
        rule.onNodeWithTag("device-action-remove").performScrollTo().performClick()
        rule.onNodeWithTag("device-remove-confirmation").assertIsDisplayed()
        rule.runOnIdle { assertEquals(0, removed) }
        rule.onNodeWithTag("device-keep").performClick()
        rule.onNodeWithTag("device-action-files").assertIsDisplayed()
        rule.runOnIdle { assertEquals(0, removed) }
        rule.onNodeWithTag("device-action-remove").performScrollTo().performClick()
        rule.onNodeWithTag("device-remove-confirm").performScrollTo().performClick()
        rule.runOnIdle { assertEquals(1, removed) }
    }

    @Test fun closeDismissesTheSheet() {
        val shown = mutableStateOf(true)
        rule.setContent { ClipRelayTheme {
            if (shown.value) ComputerActionsSheet(online, { shown.value = false }, {})
        } }
        rule.onNodeWithTag("device-actions-close").performClick()
        rule.onNodeWithTag("computer-actions-sheet").assertDoesNotExist()
    }

    @Test fun lightDarkAndOfflineLayouts() {
        val dark = mutableStateOf(false)
        val device = mutableStateOf(online)
        rule.setContent { ClipRelayTheme(darkTheme = dark.value) {
            Box(Modifier.fillMaxSize()) { Text("设计验收 · 示例设备") }
            ComputerActionsSheet(device.value, {}, {})
        } }
        rule.onNodeWithTag("device-action-files").assertIsDisplayed()
        rule.onNodeWithTag("device-action-remove").assertIsDisplayed()
        capture("actions-light")
        rule.runOnIdle { dark.value = true }
        rule.onNodeWithTag("device-action-remove").assertIsDisplayed()
        capture("actions-dark")
        rule.runOnIdle { device.value = online.copy(state = State.OFFLINE) }
        rule.onNodeWithTag("device-action-wake").assertIsEnabled()
        capture("actions-offline")
    }

    @Test fun largeTextAndLongNameKeepAllActionsReachable() {
        rule.setContent {
            val density = LocalDensity.current.density
            CompositionLocalProvider(LocalDensity provides Density(density, fontScale = 1.6f)) {
                ClipRelayTheme {
                    ComputerActionsSheet(online.copy(name = "一台用于设计评审与远程工作的长名称电脑"), {}, {})
                }
            }
        }
        rule.onNodeWithTag("device-action-herdr").performScrollTo().assertIsDisplayed()
        rule.onNodeWithTag("device-action-remove").performScrollTo().assertIsDisplayed().performClick()
        rule.onNodeWithTag("device-remove-confirm").performScrollTo().assertIsDisplayed()
        capture("actions-large-text-confirm")
    }

    private fun capture(name: String) {
        rule.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val bitmap = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
        val directory = File(instrumentation.targetContext.getExternalFilesDir(null), "device-actions-acceptance")
        directory.mkdirs()
        File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
