package com.cliprelay.app

import android.app.Activity
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.Espresso.onData
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.action.ViewActions.scrollTo
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.espresso.matcher.ViewMatchers.withContentDescription
import androidx.test.espresso.matcher.RootMatchers.isDialog
import androidx.test.espresso.matcher.RootMatchers.isPlatformPopup
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.limelight.R
import com.limelight.ui.GameControlsView
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.hamcrest.Matchers.equalTo
import java.io.File

/** Exercises native multitouch dispatch against a recording sink; never sends computer input. */
@RunWith(AndroidJUnit4::class)
class GameControlsTouchTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val held = mutableSetOf<Int>()
    private val events = mutableListOf<Pair<Int, Boolean>>()
    private lateinit var overlay: GameControlsView
    private var downAt = 0L
    private data class Finger(val id: Int, val x: Float, val y: Float)

    private fun send(action: Int, vararg fingers: Finger) {
        if (action == MotionEvent.ACTION_DOWN) downAt = SystemClock.uptimeMillis()
        val properties = fingers.map { f -> MotionEvent.PointerProperties().apply {
            id = f.id; toolType = MotionEvent.TOOL_TYPE_FINGER
        } }.toTypedArray()
        val coords = fingers.map { f -> MotionEvent.PointerCoords().apply {
            x = f.x; y = f.y; pressure = 1f; size = 1f
        } }.toTypedArray()
        val event = MotionEvent.obtain(downAt, SystemClock.uptimeMillis(), action, fingers.size,
            properties, coords, 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
        try { instrumentation.runOnMainSync { overlay.dispatchTouchEvent(event) } }
        finally { event.recycle() }
    }

    private fun finger(id: Int, viewId: Int, x: Float = .5f, y: Float = .5f): Finger {
        var result: Finger? = null
        instrumentation.runOnMainSync {
            val view = overlay.findViewById<View>(viewId)
            val rect = Rect(0, 0, view.width, view.height)
            overlay.offsetDescendantRectToMyCoords(view, rect)
            result = Finger(id, rect.left + rect.width() * x, rect.top + rect.height() * y)
        }
        return requireNotNull(result)
    }

    private fun menuAction(id: Int) {
        instrumentation.runOnMainSync {
            overlay.findViewById<View>(R.id.gameMenuButton).performClick()
            val action = overlay.findViewById<View>(id)
            check(action.isShown)
            action.performClick()
        }
    }

    @Test fun simultaneousHoldsAndInterruptionsNeverLeaveKeysDown() {
        val preferences = instrumentation.targetContext.getSharedPreferences("cliprelay_game_controls", 0)
        val saved = preferences.all.toMap()
        val profiles = instrumentation.targetContext.getSharedPreferences("cliprelay_game_profiles", 0)
        val savedProfile = profiles.getString("profile", null)
        profiles.edit().putString("profile", "plateup").commit()
        preferences.edit().clear().commit()
        var activity: Activity? = null
        try {
            activity = instrumentation.startActivitySync(Intent().setClassName(
                instrumentation.targetContext.packageName, "com.limelight.PcView")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val screen = activity
            instrumentation.runOnMainSync {
                screen.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                screen.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            }
            SystemClock.sleep(2_000)
            instrumentation.waitForIdleSync()
            lateinit var root: FrameLayout
            instrumentation.runOnMainSync {
                root = FrameLayout(screen).apply { setBackgroundColor(0xFF253449.toInt()) }
                overlay = GameControlsView(screen, { key, down, _ ->
                    events += key to down
                    if (down) assertTrue("Duplicate key down: $key", held.add(key))
                    else assertTrue("Key up without matching down: $key", held.remove(key))
                }, { overlay.visibility = View.GONE })
                root.addView(overlay, FrameLayout.LayoutParams(-1, -1))
                screen.setContentView(root)
                overlay.setAvailable(true)
            }
            SystemClock.sleep(500)
            instrumentation.waitForIdleSync()
            repeat(3) { round ->
                val stick = finger(2, R.id.gameJoystick, .8f, .2f)
                val act = finger(7, R.id.gameAct)
                val grab = finger(11, R.id.gameGrab)
                send(MotionEvent.ACTION_DOWN, stick)
                assertEquals(setOf(87, 68), held)
                send(MotionEvent.ACTION_POINTER_DOWN or (1 shl 8), stick, act)
                send(MotionEvent.ACTION_POINTER_DOWN or (2 shl 8), stick, act, grab)
                assertEquals(setOf(87, 68, 79, 80), held)
                val count = events.size
                repeat(10) { send(MotionEvent.ACTION_MOVE, stick, act, grab) }
                SystemClock.sleep(150)
                assertEquals(count, events.size)
                // The first finger may lift before the action buttons.
                if (round % 2 == 0) {
                    send(MotionEvent.ACTION_POINTER_UP, stick, act, grab)
                    assertEquals(setOf(79, 80), held)
                    send(MotionEvent.ACTION_POINTER_UP or (1 shl 8), act, grab)
                    assertEquals(setOf(79), held)
                    send(MotionEvent.ACTION_UP, act)
                } else {
                    send(MotionEvent.ACTION_POINTER_UP or (1 shl 8), stick, act, grab)
                    assertEquals(setOf(87, 68, 80), held)
                    send(MotionEvent.ACTION_POINTER_UP or (1 shl 8), stick, grab)
                    send(MotionEvent.ACTION_UP, stick)
                }
                assertTrue(held.isEmpty())
            }

            val act = finger(1, R.id.gameAct)
            val second = act.copy(id = 9)
            send(MotionEvent.ACTION_DOWN, act)
            send(MotionEvent.ACTION_POINTER_DOWN or (1 shl 8), act, second)
            send(MotionEvent.ACTION_POINTER_UP, act, second)
            assertEquals(setOf(79), held)
            send(MotionEvent.ACTION_UP, second)
            assertTrue(held.isEmpty())
            // Sliding off releases; sliding back resumes until the touch is cancelled.
            send(MotionEvent.ACTION_DOWN, act)
            send(MotionEvent.ACTION_MOVE, act.copy(x = 0f, y = 0f))
            assertTrue(held.isEmpty())
            send(MotionEvent.ACTION_MOVE, act)
            assertEquals(setOf(79), held)
            send(MotionEvent.ACTION_CANCEL, act)
            assertTrue(held.isEmpty())

            val stick = finger(2, R.id.gameJoystick, .2f, .8f)
            // Opening the menu releases movement, and dismissing it over the joystick
            // consumes that entire gesture instead of sending a surprise game input.
            send(MotionEvent.ACTION_DOWN, stick)
            instrumentation.runOnMainSync { overlay.findViewById<View>(R.id.gameMenuButton).performClick() }
            assertTrue(held.isEmpty())
            send(MotionEvent.ACTION_MOVE, stick)
            assertTrue(held.isEmpty())
            send(MotionEvent.ACTION_UP, stick)
            val beforeDismiss = events.size
            send(MotionEvent.ACTION_DOWN, stick)
            send(MotionEvent.ACTION_MOVE, stick)
            send(MotionEvent.ACTION_UP, stick)
            assertEquals(beforeDismiss, events.size)
            instrumentation.runOnMainSync { assertFalse(overlay.findViewById<View>(R.id.gameMenuPanel).isShown) }
            send(MotionEvent.ACTION_DOWN, act)
            assertEquals(setOf(79), held)
            send(MotionEvent.ACTION_UP, act)
            val beforePause = events.size
            menuAction(R.id.gamePause)
            assertEquals(listOf(27 to true, 27 to false), events.drop(beforePause))
            assertTrue(held.isEmpty())
            instrumentation.runOnMainSync {
                overlay.findViewById<View>(R.id.gameMenuButton).performClick()
                overlay.setAvailable(false)
                overlay.setAvailable(true)
                assertFalse(overlay.findViewById<View>(R.id.gameMenuPanel).isShown)
            }
            for (interrupt in listOf<() -> Unit>(
                { overlay.setAvailable(false); overlay.setAvailable(true) },
                { overlay.visibility = View.GONE; overlay.visibility = View.VISIBLE },
                { overlay.releaseTouches() })) {
                send(MotionEvent.ACTION_DOWN, stick)
                send(MotionEvent.ACTION_POINTER_DOWN or (1 shl 8), stick, act)
                instrumentation.runOnMainSync(interrupt)
                assertTrue(held.isEmpty())
                send(MotionEvent.ACTION_MOVE, stick, act)
                assertTrue("Old gestures resumed after interruption", held.isEmpty())
                send(MotionEvent.ACTION_CANCEL, stick, act)
            }
            send(MotionEvent.ACTION_DOWN, act)
            menuAction(R.id.gameSettings)
            assertTrue(held.isEmpty())
            onView(withText(android.R.string.cancel)).inRoot(isDialog()).perform(click())
            send(MotionEvent.ACTION_CANCEL, act)
            send(MotionEvent.ACTION_DOWN, act)
            assertEquals(setOf(79), held)
            send(MotionEvent.ACTION_UP, act)
            menuAction(R.id.gameSettings)
            onView(withContentDescription(screen.getString(R.string.game_grab))).inRoot(isDialog()).perform(scrollTo(), click())
            onData(equalTo("Space")).inRoot(isPlatformPopup()).perform(click())
            onView(withText(R.string.game_save)).inRoot(isDialog()).perform(click())
            assertEquals(32, preferences.getInt("key_4", -1))
            val remapped = finger(3, R.id.gameGrab)
            send(MotionEvent.ACTION_DOWN, remapped)
            assertEquals(setOf(32), held)
            send(MotionEvent.ACTION_UP, remapped)
            menuAction(R.id.gameSettings)
            onView(withText(R.string.game_reset)).inRoot(isDialog()).perform(click())
            send(MotionEvent.ACTION_DOWN, remapped)
            assertEquals(setOf(80), held)
            send(MotionEvent.ACTION_UP, remapped)
            instrumentation.uiAutomation.takeScreenshot().let { bitmap ->
                File(instrumentation.targetContext.getExternalFilesDir(null), "game-controls-qa.png")
                    .outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
            }
            send(MotionEvent.ACTION_DOWN, stick)
            instrumentation.runOnMainSync { root.removeView(overlay) }
            assertTrue("Detached overlay left movement held", held.isEmpty())
        } catch (error: Throwable) {
            instrumentation.uiAutomation.takeScreenshot()?.let { bitmap ->
                File(instrumentation.targetContext.getExternalFilesDir(null), "game-controls-error.png")
                    .outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
            }
            throw error
        } finally {
            activity?.let { screen -> instrumentation.runOnMainSync { screen.finish() } }
            profiles.edit().putString("profile", savedProfile).commit()
            preferences.edit().clear().apply {
                saved.forEach { (key, value) -> when (value) {
                    is Int -> putInt(key, value)
                    is Boolean -> putBoolean(key, value)
                    is String -> putString(key, value)
                } }
            }.commit()
        }
    }
}
