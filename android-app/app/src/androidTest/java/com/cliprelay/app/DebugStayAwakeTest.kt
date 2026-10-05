package com.cliprelay.app

import android.provider.Settings
import android.os.ParcelFileDescriptor
import androidx.test.platform.app.InstrumentationRegistry
import com.cliprelay.app.data.AppPreferences
import com.cliprelay.app.service.DebugStayAwake
import org.junit.Assert.*
import org.junit.Test

class DebugStayAwakeTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext

    @Test fun realDebuggingSettingsAreReadableAndHoldScreen() {
        val expectedUsb = shellSetting(Settings.Global.ADB_ENABLED)
        val expectedWifi = shellSetting(DebugStayAwake.ADB_WIFI_ENABLED)
        // Shell and third-party views can differ on newer Android versions. Verify
        // the values from inside the app, without adopting shell permissions.
        assertEquals(expectedUsb, Settings.Global.getInt(context.contentResolver, Settings.Global.ADB_ENABLED, 0))
        assertEquals(expectedWifi, Settings.Global.getInt(context.contentResolver, DebugStayAwake.ADB_WIFI_ENABLED, 0))
        val original = AppPreferences.load(context)
        instrumentation.runOnMainSync {
            val controller = DebugStayAwake(context)
            try {
                AppPreferences.save(context, original.copy(debugStayAwake = true))
                controller.start()
                assertEquals(expectedUsb == 1 || expectedWifi == 1, controller.isHoldingScreen)
            } finally {
                controller.close()
                AppPreferences.save(context, original)
            }
        }
    }

    private fun shellSetting(key: String): Int =
        ParcelFileDescriptor.AutoCloseInputStream(
            instrumentation.uiAutomation.executeShellCommand("settings get global $key"),
        ).bufferedReader().use { it.readText().trim().toIntOrNull() ?: 0 }

    @Test fun debugTransitionsOptOutAndShutdownReleaseTheScreen() {
        val original = AppPreferences.load(context)
        val timeout = Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_OFF_TIMEOUT)
        instrumentation.runOnMainSync {
            var usb = 0
            var wifi = 0
            val controller = DebugStayAwake(context) { key ->
                when (key) {
                    Settings.Global.ADB_ENABLED -> usb
                    DebugStayAwake.ADB_WIFI_ENABLED -> wifi
                    else -> error("Unexpected debugging setting")
                }
            }
            try {
                AppPreferences.save(context, original.copy(debugStayAwake = true))
                controller.start()
                assertFalse(controller.isHoldingScreen)
                usb = 1
                controller.refresh()
                assertTrue("USB alone", controller.isHoldingScreen)
                wifi = 1
                controller.refresh()
                assertTrue("Both enabled", controller.isHoldingScreen)
                usb = 0
                controller.refresh()
                assertTrue("Wireless alone, including on battery", controller.isHoldingScreen)
                wifi = 0
                controller.refresh()
                assertFalse("Both disabled", controller.isHoldingScreen)
                wifi = 1
                controller.refresh()
                AppPreferences.save(context, original.copy(debugStayAwake = false))
                assertFalse("Opt-out applies immediately through the preference listener", controller.isHoldingScreen)
                AppPreferences.save(context, original.copy(debugStayAwake = true))
                assertTrue("Opt-in applies immediately", controller.isHoldingScreen)
                controller.close()
                controller.refresh()
                assertFalse("Stopped service cannot reacquire", controller.isHoldingScreen)
                assertEquals(timeout, Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_OFF_TIMEOUT))
            } finally {
                controller.close()
                AppPreferences.save(context, original)
            }
        }
    }

    @Test fun unreadableSettingsReleaseAnyExistingScreenLock() {
        val original = AppPreferences.load(context)
        instrumentation.runOnMainSync {
            var readable = true
            val controller = DebugStayAwake(context) {
                if (readable) 1 else throw SecurityException("Simulated settings restriction")
            }
            try {
                AppPreferences.save(context, original.copy(debugStayAwake = true))
                controller.start()
                assertTrue(controller.isHoldingScreen)
                readable = false
                controller.refresh()
                assertFalse(controller.isHoldingScreen)
            } finally {
                controller.close()
                AppPreferences.save(context, original)
            }
        }
    }
}
