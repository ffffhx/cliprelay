package com.cliprelay.app

import android.app.Activity
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.Espresso.onData
import androidx.test.espresso.action.ViewActions.*
import androidx.test.espresso.matcher.RootMatchers.isDialog
import androidx.test.espresso.matcher.ViewMatchers.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.limelight.R
import com.limelight.preferences.TouchMode
import com.limelight.ui.*
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.io.File

/** Uses a recording transport so no test text, clicks or key presses reach the computer. */
@RunWith(AndroidJUnit4::class)
class ApplicationControlsUiTest {
    private val instrument = InstrumentationRegistry.getInstrumentation()
    private val names = listOf("cliprelay_desktop_controls", "cliprelay_game_profiles",
        "cliprelay_game_controls", "cliprelay_game_controls_stardew")
    private val saved = names.associateWith { instrument.targetContext.getSharedPreferences(it, 0).all.toMap() }
    private lateinit var screen: Activity
    private lateinit var root: FrameLayout
    private lateinit var toolbar: DesktopToolbar.Controller
    private val held = mutableSetOf<Int>()
    private val events = mutableListOf<String>()
    private var pointer = false
    private var desktopTouches = 0
    private var applicationChanges = 0
    private var infoRequests = 0
    private var infoSample: com.limelight.binding.video.StreamStatistics? = null
    private val infoDialog = StreamInfoDialog()
    private fun ui(action: () -> Unit) = instrument.runOnMainSync(action)

    @Before fun setup() {
        names.forEach { instrument.targetContext.getSharedPreferences(it, 0).edit().clear().commit() }
        screen = instrument.startActivitySync(Intent().setClassName(instrument.targetContext.packageName,
            "com.limelight.PcView").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        ui {
            screen.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            screen.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        }
        SystemClock.sleep(1500)
        ui {
            // PcView may be recreated by the portrait -> landscape change. Use
            // its current window token rather than the destroyed launch instance.
            screen = androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
                .getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED)
                .first { it.javaClass.name == "com.limelight.PcView" }
            screen.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            root = FrameLayout(screen)
            root.addView(TextView(screen).apply {
                id = R.id.surfaceView
                text = "ClipRelay · control verification"
                setTextColor(-1); setBackgroundColor(0xFF253449.toInt())
                gravity = android.view.Gravity.CENTER
                setOnTouchListener { _, _ -> desktopTouches++; true }
            }, FrameLayout.LayoutParams(-1, -1))
            screen.setContentView(root)
            toolbar = DesktopToolbar.attachWithSink(screen, root, object : DesktopInput.Sink {
                override fun send(key: Int, down: Boolean, modifiers: Int) {
                    if (down) assertTrue(held.add(key)) else assertTrue(held.remove(key))
                    events += "$key:$down:$modifiers"
                }
                override fun text(value: String) { events += "text:$value" }
                override fun rightClick() { events += "rightClick" }
                override fun scroll(clicks: Byte) { events += "scroll:$clicks" }
            }, object : DesktopToolbar.Actions {
                override fun keyboard() {}
                override fun touchMode() = TouchMode.PHONE
                override fun selectTouchMode(mode: TouchMode) {}
                override fun disconnect() {}
                override fun gameModeChanged(enabled: Boolean) {}
                override fun gamePointerModeChanged(enabled: Boolean) { pointer = enabled }
                override fun applicationChanged() { applicationChanges++ }
                override fun streamInfo() {
                    infoRequests++
                    infoDialog.show(screen, { infoSample }, { "目标码率　8.00 Mbps" })
                }
            })
            toolbar.setConnected(true); toolbar.setFocused(true); toolbar.setExpanded(true)
        }
        instrument.waitForIdleSync()
    }

    @After fun cleanup() {
        if (::screen.isInitialized) ui { infoDialog.dismiss(); screen.finish() }
        names.forEach { name ->
            instrument.targetContext.getSharedPreferences(name, 0).edit().clear().apply {
                saved.getValue(name).forEach { (key, value) -> when (value) {
                    is Int -> putInt(key, value)
                    is Long -> putLong(key, value)
                    is Float -> putFloat(key, value)
                    is Boolean -> putBoolean(key, value)
                    is String -> putString(key, value)
                } }
            }.commit()
        }
    }

    private fun clickId(id: Int) { ui { root.findViewById<View>(id).performClick() }; instrument.waitForIdleSync() }
    private fun screenshot(name: String) {
        instrument.waitForIdleSync()
        SystemClock.sleep(300)
        instrument.uiAutomation.takeScreenshot().let { bitmap ->
            File(instrument.targetContext.getExternalFilesDir(null), name).outputStream().use {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
            bitmap.recycle()
        }
    }
    private fun touch(view: View, action: Int, x: Float = view.width / 2f, y: Float = view.height / 2f) {
        val now = SystemClock.uptimeMillis()
        val event = MotionEvent.obtain(now, now, action, x, y, 0)
        try { ui { view.dispatchTouchEvent(event) } } finally { event.recycle() }
    }

    @Test fun streamInformationRefreshesWithoutSendingRemoteInput() {
        ui {
            infoSample = com.limelight.binding.video.StreamStatistics(SystemClock.uptimeMillis(),
                2000, 1920, 1080, "HEVC", 1_500_000, 118, 116, 120, 2, 35)
        }
        events.clear()
        clickId(R.id.streamInfoButton)
        onView(withId(R.id.streamInfoText)).inRoot(isDialog()).check { view, error ->
            if (error != null) throw error
            val text = (view as TextView).text.toString()
            assertTrue(text.contains("1920 × 1080"))
            assertTrue(text.contains("HEVC"))
            assertTrue(text.contains("8.00 Mbps"))
            assertFalse(text.contains(screen.getString(R.string.stream_info_waiting)))
        }
        ui { infoSample = null }
        SystemClock.sleep(1200)
        onView(withId(R.id.streamInfoText)).inRoot(isDialog()).check { view, error ->
            if (error != null) throw error
            assertTrue((view as TextView).text.contains(screen.getString(R.string.stream_info_waiting)))
        }
        onView(withText(R.string.stream_info_close)).inRoot(isDialog()).perform(click())
        ui { toolbar.setGameMode(true); toolbar.setFocused(true) }
        clickId(R.id.gameMenuButton)
        clickId(R.id.gameStreamInfoButton)
        assertEquals(2, infoRequests)
        assertTrue(events.isEmpty())
        assertTrue(held.isEmpty())
    }

    @Test fun sideRailsStayOutsideVideoAndRestoreAfterModeChanges() {
        val video = root.findViewById<View>(R.id.surfaceView)
        val margin = (100 * screen.resources.displayMetrics.density).toInt()
        ui {
            toolbar.setProfile(DesktopProfile.ORCA)
            toolbar.setExpanded(false)
            video.layoutParams = FrameLayout.LayoutParams(root.width - margin * 2, -1,
                android.view.Gravity.CENTER)
        }
        instrument.waitForIdleSync()
        val left = root.findViewById<View>(R.id.desktopLeftRail)
        val right = root.findViewById<View>(R.id.desktopRightRail)
        fun assertRails() = ui {
            assertTrue(toolbar.isSideRailsActive)
            assertTrue(left.isShown && right.isShown)
            assertTrue(left.right <= video.left)
            assertTrue(right.left >= video.right)
            assertFalse(root.findViewById<View>(R.id.desktopControlsHandle).isShown)
            assertFalse(root.findViewById<View>(R.id.desktopToolbar).isShown)
        }
        assertRails()
        // The former bottom toolbar area is now entirely available to the stream.
        val beforeTouch = desktopTouches
        touch(root, MotionEvent.ACTION_DOWN, root.width / 2f, root.height - 30f)
        touch(root, MotionEvent.ACTION_UP, root.width / 2f, root.height - 30f)
        assertEquals(beforeTouch + 2, desktopTouches)
        events.clear()
        onView(withContentDescription(R.string.desktop_copy)).perform(scrollTo(), click())
        assertEquals(listOf("17:true:2", "67:true:2", "67:false:2", "17:false:0"), events)
        assertTrue(held.isEmpty())
        for (profile in listOf(DesktopProfile.GENERAL, DesktopProfile.CHATGPT, DesktopProfile.ORCA)) {
            ui { toolbar.setProfile(profile) }
            instrument.waitForIdleSync()
            assertRails()
        }
        ui { toolbar.setGameMode(true) }
        assertFalse(left.isShown || right.isShown)
        ui { toolbar.setGameMode(false) }
        assertRails()
        ui { toolbar.setPictureInPicture(true) }
        assertFalse(left.isShown || right.isShown)
        ui { toolbar.setPictureInPicture(false) }
        assertRails()
        clickId(R.id.virtualKeyboardButton)
        assertFalse(left.isShown || right.isShown)
        ui { toolbar.hideVirtualKeyboard() }
        assertRails()
        // A stream stretched to full width cannot leave controls on top of its pixels.
        ui { video.layoutParams = FrameLayout.LayoutParams(-1, -1) }
        instrument.waitForIdleSync()
        assertFalse(toolbar.isSideRailsActive)
        assertFalse(left.isShown || right.isShown)
        assertTrue(root.findViewById<View>(R.id.desktopControlsHandle).isShown)
        ui {
            video.layoutParams = FrameLayout.LayoutParams(root.width - margin * 2, -1,
                android.view.Gravity.CENTER)
        }
        instrument.waitForIdleSync()
        assertRails()
        screenshot("desktop-side-rails-qa.png")
    }

    @Test fun applicationMenuIncludesGamesWithoutSeparateButton() {
        val game = root.findViewById<GameControlsView>(R.id.gameControlsOverlay)
        val video = root.findViewById<View>(R.id.surfaceView)
        val margin = (100 * screen.resources.displayMetrics.density).toInt()
        ui { video.layoutParams = FrameLayout.LayoutParams(root.width - margin * 2, -1,
            android.view.Gravity.CENTER) }
        instrument.waitForIdleSync()
        assertTrue(toolbar.isSideRailsActive)
        assertNull("Game mode still has a separate toolbar button", root.findViewById<View>(R.id.gameModeButton))
        fun chooseGame() {
            clickId(R.id.desktopProfileButton)
            onData(org.hamcrest.Matchers.equalTo(screen.getString(R.string.game_mode)))
                .inRoot(isDialog()).perform(click())
        }
        assertTrue(toolbar.isAutomaticMode)
        clickId(R.id.desktopProfileButton)
        screenshot("application-menu-games-qa.png")
        onData(org.hamcrest.Matchers.equalTo(screen.getString(R.string.game_mode)))
            .inRoot(isDialog()).perform(click())
        onView(withText(R.string.game_choose_profile)).inRoot(isDialog())
            .check(androidx.test.espresso.assertion.ViewAssertions.matches(isDisplayed()))
        assertFalse(toolbar.isGameMode)
        assertFalse(game.isShown)
        assertTrue(toolbar.isAutomaticMode)
        screenshot("game-mode-chooser-qa.png")
        onView(withText(android.R.string.cancel)).inRoot(isDialog()).perform(click())
        assertFalse(toolbar.isGameMode)
        assertTrue(toolbar.isAutomaticMode)
        assertTrue(events.isEmpty())

        // The compact toolbar uses the same menu when the video fills the screen.
        ui { video.layoutParams = FrameLayout.LayoutParams(-1, -1); toolbar.setExpanded(true) }
        instrument.waitForIdleSync()
        assertFalse(toolbar.isSideRailsActive)
        assertNull(root.findViewById<View>(R.id.gameModeButton))
        chooseGame()
        onView(withText(R.string.game_profile_stardew)).inRoot(isDialog()).perform(click())
        assertTrue(toolbar.isGameMode)
        assertTrue(game.isShown)
        assertEquals(GameBindings.Profile.STARDEW, game.profile)
        assertFalse(toolbar.isAutomaticMode)
        ui { toolbar.observeApplication("plateup") }
        assertEquals("Automatic detection replaced an explicit game selection",
            GameBindings.Profile.STARDEW, game.profile)

        // Entering again must still ask, even when a game was saved previously.
        ui { toolbar.setGameMode(false); toolbar.setExpanded(true) }
        chooseGame()
        assertFalse(toolbar.isGameMode)
        onView(withText(android.R.string.cancel)).inRoot(isDialog()).perform(click())
        assertEquals(GameBindings.Profile.STARDEW, game.profile)
        assertFalse(toolbar.isAutomaticMode)
        chooseGame()
        onView(withText(R.string.game_profile)).inRoot(isDialog()).perform(click())
        assertTrue(toolbar.isGameMode)
        assertEquals(GameBindings.Profile.PLATEUP, game.profile)
        assertTrue(events.isEmpty())
    }

    @Test fun stardewSwitchingReleasesHoldsAndMenuTouchReachesDesktop() {
        val legacy = screen.getSharedPreferences(GameBindings.preferencesName(GameBindings.Profile.PLATEUP), 0)
        legacy.edit().putInt("key_4", 32).commit()
        ui { toolbar.setGameMode(true) }
        val game = root.findViewById<GameControlsView>(R.id.gameControlsOverlay)
        ui { game.setProfile(GameBindings.Profile.PLATEUP) }
        instrument.waitForIdleSync()
        val tool = game.findViewById<View>(R.id.gameGrab)
        touch(tool, MotionEvent.ACTION_DOWN)
        assertEquals(setOf(32), held)
        clickId(R.id.gameMenuButton)
        assertTrue(held.isEmpty())
        clickId(R.id.gameProfileButton)
        onView(withText(R.string.game_profile_stardew)).inRoot(isDialog()).perform(click())
        assertEquals(GameBindings.Profile.STARDEW, game.profile)
        touch(tool, MotionEvent.ACTION_CANCEL)
        touch(tool, MotionEvent.ACTION_DOWN)
        assertEquals(setOf(67), held)
        clickId(R.id.gamePointerButton)
        assertTrue(held.isEmpty()); assertTrue(pointer)
        assertFalse(tool.isShown)
        val before = desktopTouches
        clickId(R.id.gameMenuButton)
        touch(root, MotionEvent.ACTION_DOWN); touch(root, MotionEvent.ACTION_UP)
        assertEquals("Closing the menu leaked a click to the game", before, desktopTouches)
        touch(root, MotionEvent.ACTION_DOWN); touch(root, MotionEvent.ACTION_UP)
        assertEquals(before + 2, desktopTouches)
        clickId(R.id.gamePointerButton)
        assertFalse(pointer)
        val beforeKeys = desktopTouches
        touch(root, MotionEvent.ACTION_DOWN); touch(root, MotionEvent.ACTION_UP)
        assertEquals(beforeKeys, desktopTouches)
        // Stardew reset must leave the existing PlateUp customization intact.
        clickId(R.id.gameMenuButton); clickId(R.id.gameSettings)
        onView(withText(R.string.stardew_reset)).inRoot(isDialog()).perform(click())
        assertEquals(32, legacy.getInt("key_4", -1))
        screenshot("stardew-controls-qa.png")
        ui { game.setProfile(GameBindings.Profile.PLATEUP) }
        touch(tool, MotionEvent.ACTION_DOWN)
        assertEquals(setOf(32), held)
        ui { game.setProfile(GameBindings.Profile.STARDEW) }
        assertTrue(held.isEmpty())
        clickId(R.id.gamePointerButton)
        ui { toolbar.setGameMode(false) }
        assertFalse(pointer)
        assertTrue(held.isEmpty())
    }

    @Test fun automaticModesReleaseKeysAndRespectManualOverride() {
        val game = root.findViewById<GameControlsView>(R.id.gameControlsOverlay)
        ui { toolbar.observeApplication("stardew") }
        assertEquals("First identification cancelled the first touch", 0, applicationChanges)
        assertTrue(toolbar.isGameMode)
        assertEquals(GameBindings.Profile.STARDEW, game.profile)
        val tool = game.findViewById<View>(R.id.gameGrab)
        instrument.waitForIdleSync()
        touch(tool, MotionEvent.ACTION_DOWN)
        assertEquals(setOf(67), held)
        ui { toolbar.observeApplication("orca") }
        assertEquals(1, applicationChanges)
        assertTrue(held.isEmpty())
        assertFalse(toolbar.isGameMode)
        assertEquals(DesktopProfile.ORCA, toolbar.profile)
        ui { toolbar.setProfile(DesktopProfile.CHATGPT); toolbar.observeApplication("stardew") }
        assertFalse(toolbar.isAutomaticMode)
        assertFalse(toolbar.isGameMode)
        assertEquals(DesktopProfile.CHATGPT, toolbar.profile)
        ui { toolbar.setAutomaticMode(true) }
        assertTrue(toolbar.isGameMode)
        assertEquals(GameBindings.Profile.STARDEW, game.profile)
        ui { toolbar.observeApplication("general") }
        assertFalse(toolbar.isGameMode)
        assertEquals(DesktopProfile.GENERAL, toolbar.profile)
        assertTrue(held.isEmpty())
    }

    @Test fun virtualKeyboardCombosPagesAndLifecycleDoNotLeakKeysOrTouches() {
        clickId(R.id.virtualKeyboardButton)
        val panel = root.findViewById<VirtualKeyboardView>(R.id.virtualKeyboardPanel)
        assertTrue(toolbar.isVirtualKeyboardOpen); assertTrue(panel.isShown)
        instrument.waitForIdleSync()
        SystemClock.sleep(300)
        ui {
            val pasteKey = panel.findViewWithTag<View>("vk:86")
            val visible = android.graphics.Rect()
            assertTrue("V key is offscreen in landscape", pasteKey.getGlobalVisibleRect(visible))
            assertEquals("Keyboard bottom row is clipped", pasteKey.height, visible.height())
        }
        val before = desktopTouches
        fun key(code: Int) { ui { panel.findViewWithTag<View>("vk:$code").performClick() } }
        key(17); assertTrue(panel.findViewWithTag<View>("vk:17").isSelected)
        assertTrue(events.isEmpty())
        key(67)
        assertEquals(listOf("17:true:2", "67:true:2", "67:false:2", "17:false:0"), events)
        assertFalse(panel.findViewWithTag<View>("vk:17").isSelected)
        assertTrue(held.isEmpty()); assertEquals(before, desktopTouches)
        key(17); clickId(R.id.virtualKeyboardPage); key(0x74)
        assertEquals(listOf("17:true:2", "116:true:2", "116:false:2", "17:false:0"), events.takeLast(4))
        screenshot("virtual-keyboard-functions-qa.png")
        clickId(R.id.virtualKeyboardPage)
        key(18); ui { toolbar.setFocused(false) }
        assertFalse(toolbar.isVirtualKeyboardOpen)
        assertFalse(panel.findViewWithTag<View>("vk:18").isSelected)
        assertTrue(held.isEmpty())
        ui { toolbar.setFocused(true); toolbar.showVirtualKeyboard() }
        key(86); assertEquals(listOf("86:true:0", "86:false:0"), events.takeLast(2))
        screenshot("virtual-keyboard-qa.png")
        clickId(R.id.virtualKeyboardClose)
        assertFalse(panel.isShown)
        ui { toolbar.setGameMode(true) }
        clickId(R.id.gameMenuButton); clickId(R.id.gameVirtualKeyboardButton)
        assertTrue(toolbar.isVirtualKeyboardOpen)
        assertFalse(root.findViewById<View>(R.id.gameControlsOverlay).isShown)
        clickId(R.id.virtualKeyboardClose)
        assertTrue(root.findViewById<View>(R.id.gameControlsOverlay).isShown)
        ui { toolbar.showVirtualKeyboard(); toolbar.setConnected(false) }
        assertFalse(toolbar.isVirtualKeyboardOpen)
        val disconnectedEvents = events.size
        key(67)
        assertEquals(disconnectedEvents, events.size)
    }
}
