package com.cliprelay.app.network

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Uses isolated UI state. It never reads, deletes or changes the user's pairings. */
class NetworkPairScreenTest {
    @get:Rule val rule = createComposeRule()

    private val computers = listOf(
        ExternalConnectionState("ready", "已连接", computer = "家中电脑", id = "home", address = "127.120.0.1"),
        ExternalConnectionState("connecting", "等待电脑上线", computer = "办公电脑", id = "office", address = "127.120.0.2"),
    )

    @Test fun canPairAnotherComputerWhileExistingComputerIsOffline() {
        var submitted = ""
        rule.setContent {
            MaterialTheme {
                NetworkPairScreen(computers, null, {}, {}, { submitted = it }, {}, {}, {}, {})
            }
        }
        rule.onNodeWithTag("external-pair-code").performScrollTo().performTextInput("12345678")
        rule.onNodeWithTag("external-submit-code").performScrollTo().performClick()
        rule.runOnIdle { assertEquals("12345678", submitted) }
        rule.onNodeWithTag("external-computer-home").assertExists()
        rule.onNodeWithTag("external-computer-office").assertExists()
    }

    @Test fun failedOrCancelledNewPairingPreservesExistingComputerControls() {
        val pending = mutableStateOf<ExternalConnectionState?>(ExternalConnectionState("pending", "等待确认", "123ABC"))
        var paused = ""
        var cancelled = false
        rule.setContent {
            MaterialTheme {
                NetworkPairScreen(computers, pending.value, {}, {}, {}, { paused = it }, {}, {}, { cancelled = true })
            }
        }
        rule.onNodeWithTag("external-toggle-office").performScrollTo().performClick()
        rule.runOnIdle { assertEquals("office", paused) }
        rule.onNodeWithTag("external-cancel-pairing").performScrollTo().performClick()
        rule.runOnIdle {
            assertTrue(cancelled)
            pending.value = ExternalConnectionState("error", "配对码不正确")
        }
        rule.onNodeWithTag("external-computer-home").assertExists()
        rule.onNodeWithTag("external-pair-code").performScrollTo().assertIsEnabled()
    }

    @Test fun removingComputerRequiresConfirmationAndTargetsOnlyThatComputer() {
        var removed = ""
        rule.setContent {
            MaterialTheme { NetworkPairScreen(computers, null, {}, {}, {}, {}, {}, { removed = it }, {}) }
        }
        rule.onNodeWithTag("external-remove-office").performScrollTo().performClick()
        rule.runOnIdle { assertEquals("", removed) }
        rule.onNodeWithText("取消", useUnmergedTree = true).performClick()
        rule.runOnIdle { assertEquals("", removed) }
        rule.onNodeWithTag("external-remove-office").performClick()
        rule.onNodeWithTag("external-confirm-remove").performClick()
        rule.runOnIdle { assertEquals("office", removed) }
    }
}
