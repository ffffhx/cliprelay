package com.cliprelay.app

import com.limelight.nvstream.DirectDesktopConnection
import com.limelight.nvstream.http.NvApp
import org.junit.Assert.*
import org.junit.Test

class DirectDesktopConnectionTest {
    private val desktop = NvApp("Desktop", 8, false)
    private val game = NvApp("Stardew Valley", 42, false)

    @Test fun startsDesktopWhenIdleEvenIfAGameIsListedFirst() {
        assertSame(desktop, DirectDesktopConnection.select(0, listOf(game, desktop)))
    }

    @Test fun resumesDesktopWhenAlreadyRunning() {
        assertEquals(8, DirectDesktopConnection.select(8, listOf(desktop)).appId)
    }

    @Test fun resumesExistingGameInsteadOfQuittingItForDesktop() {
        assertEquals(42, DirectDesktopConnection.select(42, listOf(desktop)).appId)
    }

    @Test fun resumeDoesNotRequireAnAppListOrCachedAppId() {
        assertEquals(123, DirectDesktopConnection.select(123, emptyList()).appId)
    }

    @Test fun noDesktopNeverLaunchesAnArbitraryGame() {
        assertNull(DirectDesktopConnection.select(0, listOf(game)))
        assertNull(DirectDesktopConnection.select(0, emptyList()))
        assertNull(DirectDesktopConnection.select(0, listOf(NvApp("Desktop", 0, false))))
    }

    @Test fun desktopNameIsCaseInsensitive() {
        assertEquals(9, DirectDesktopConnection.select(0, listOf(NvApp("desktop", 9, false))).appId)
    }
}
