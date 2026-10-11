package com.limelight.preferences

import android.content.SharedPreferences
import java.lang.reflect.Proxy
import org.junit.Assert.*
import org.junit.Test

class StreamingDefaultsTest {
    private class Store {
        val values = mutableMapOf<String, Any>("list_fps" to "30", "seekbar_bitrate_kbps" to 6000)
        private val pending = mutableMapOf<String, Any>()
        private val editor: SharedPreferences.Editor = Proxy.newProxyInstance(
            SharedPreferences.Editor::class.java.classLoader, arrayOf(SharedPreferences.Editor::class.java)
        ) { instance, method, args ->
            when (method.name) {
                "putBoolean", "putString" -> { pending[args[0] as String] = args[1]; instance }
                "apply" -> { values.putAll(pending); pending.clear(); null }
                else -> error("Unexpected editor call: ${method.name}")
            }
        } as SharedPreferences.Editor
        val prefs: SharedPreferences = Proxy.newProxyInstance(
            SharedPreferences::class.java.classLoader, arrayOf(SharedPreferences::class.java)
        ) { _, method, args ->
            when (method.name) {
                "getBoolean" -> values[args[0] as String] ?: args[1]
                "edit" -> editor
                else -> error("Unexpected preferences call: ${method.name}")
            }
        } as SharedPreferences

        fun select(width: Int, height: Int) = PreferenceConfiguration().apply {
            this.width = width; this.height = height; fps = 30
            values["list_resolution"] = "${width}x$height"
        }
    }

    @Test fun upgradeOld720pAnd960pWithoutChangingFrameRateOrManualBitrate() {
        for (height in listOf(720, 960)) {
            val store = Store()
            val config = store.select(1280, height)
            PreferenceConfiguration.migrateResolutionDefault(store.prefs, config)
            assertEquals(1920, config.width)
            assertEquals(1080, config.height)
            assertEquals("1920x1080", store.values["list_resolution"])
            assertEquals(30, config.fps)
            assertEquals("30", store.values["list_fps"])
            assertEquals(6000, store.values["seekbar_bitrate_kbps"])
        }
    }

    @Test fun manualLowerResolutionSurvivesTheNextConnection() {
        val store = Store()
        PreferenceConfiguration.migrateResolutionDefault(store.prefs, store.select(1280, 960))
        val chosen = store.select(1280, 720)
        PreferenceConfiguration.migrateResolutionDefault(store.prefs, chosen)
        assertEquals(1280, chosen.width)
        assertEquals(720, chosen.height)
        assertEquals("1280x720", store.values["list_resolution"])
    }

    @Test fun retainNativeHigherPortraitAndOtherLowResolutionChoices() {
        for ((width, height) in listOf(1920 to 1080, 1920 to 1200, 2560 to 1440,
                3840 to 2160, 960 to 1280, 854 to 480)) {
            val store = Store()
            val config = store.select(width, height)
            PreferenceConfiguration.migrateResolutionDefault(store.prefs, config)
            assertEquals(width, config.width)
            assertEquals(height, config.height)
            assertEquals("${width}x$height", store.values["list_resolution"])
            // Mark untouched installs too, so a later deliberate 720p choice sticks.
            val later = store.select(1280, 720)
            PreferenceConfiguration.migrateResolutionDefault(store.prefs, later)
            assertEquals(720, later.height)
        }
    }
}
