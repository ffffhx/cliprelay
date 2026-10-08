package com.cliprelay.app

import android.app.Activity
import android.content.Intent
import android.os.SystemClock
import android.preference.PreferenceManager
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.matcher.RootMatchers.isDialog
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.limelight.R
import com.limelight.binding.input.touch.PhoneTouchContext
import com.limelight.binding.input.touch.PhoneScrollState
import com.limelight.nvstream.jni.MoonBridge
import com.limelight.preferences.TouchMode
import com.limelight.ui.DesktopToolbar
import com.limelight.ui.DesktopProfile
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Native MotionEvent dispatch with a recording sink. No computer input is sent. */
@RunWith(AndroidJUnit4::class)
class PhoneTouchTest {
    private val instrument = InstrumentationRegistry.getInstrumentation()
    private data class Finger(val id: Int, val x: Float, val y: Float)
    private data class Contact(val type: Byte, val id: Int, val x: Float, val y: Float)

    @Test fun gesturesCancellationAndModeSelection() {
        val prefs = PreferenceManager.getDefaultSharedPreferences(instrument.targetContext)
        val oldMode = prefs.getString(TouchMode.PREF, null)
        val hadLegacy = prefs.contains("checkbox_touchscreen_trackpad")
        val oldLegacy = prefs.getBoolean("checkbox_touchscreen_trackpad", true)
        val handlePrefs = instrument.targetContext.getSharedPreferences("cliprelay_desktop_controls", 0)
        val hadHandlePosition = handlePrefs.contains("handle_y")
        val oldHandlePosition = handlePrefs.getFloat("handle_y", .5f)
        val oldProfile = handlePrefs.getString("profile", null)
        val oldAutomatic = handlePrefs.all["automatic_app"] as? Boolean
        handlePrefs.edit().remove("handle_y").commit()
        var activity: Activity? = null
        var context: PhoneTouchContext? = null
        try {
            activity = instrument.startActivitySync(Intent().setClassName(
                instrument.targetContext.packageName, "com.limelight.PcView")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val screen = activity
            lateinit var root: FrameLayout
            lateinit var video: View
            val events = mutableListOf<Contact>()
            val held = mutableSetOf<Int>()
            val mousePositions = mutableListOf<Pair<Float, Float>>()
            val wheels = mutableListOf<Pair<Short, Short>>()
            val clicks = mutableListOf<Boolean>()
            val feedbackPoints = mutableListOf<Pair<Float, Float>>()
            var feedbackVisible = false
            var feedbackReleases = 0
            var desktopTouches = 0
            var keyboardChecks = 0
            instrument.runOnMainSync {
                root = FrameLayout(screen)
                video = View(screen)
                root.addView(video, FrameLayout.LayoutParams(800, 400).apply { leftMargin = 100; topMargin = 100 })
                screen.setContentView(root)
                context = PhoneTouchContext(video, { type, id, x, y ->
                    events += Contact(type, id, x, y)
                    when (type) {
                        MoonBridge.LI_TOUCH_EVENT_DOWN -> assertTrue(held.add(id))
                        MoonBridge.LI_TOUCH_EVENT_MOVE -> assertTrue(held.contains(id))
                        MoonBridge.LI_TOUCH_EVENT_UP, MoonBridge.LI_TOUCH_EVENT_CANCEL -> assertTrue(held.remove(id))
                        MoonBridge.LI_TOUCH_EVENT_CANCEL_ALL -> held.clear()
                    }
                    0
                }, { fail("Supported mock was rejected") }, { x, y ->
                    assertEquals(.25f, x, .001f)
                    assertEquals(.5f, y, .001f)
                    keyboardChecks++
                })
                context!!.setScrollSink(object : PhoneScrollState.Sink {
                    override fun position(x: Float, y: Float) { mousePositions += x to y }
                    override fun scroll(vertical: Short, horizontal: Short) { wheels += vertical to horizontal }
                    override fun click(right: Boolean) { clicks += right }
                })
                context!!.setScrollFeedback(object : PhoneTouchContext.ScrollFeedback {
                    override fun show(x: Float, y: Float) { feedbackPoints += x to y; feedbackVisible = true }
                    override fun release() { feedbackReleases++; feedbackVisible = false }
                    override fun clear() { feedbackVisible = false }
                })
                root.setOnTouchListener { v, e -> desktopTouches++; context!!.onTouch(v, e) }
            }
            instrument.waitForIdleSync()
            fun send(action: Int, vararg fingers: Finger, flags: Int = 0) {
                val properties = fingers.map { f -> MotionEvent.PointerProperties().apply {
                    id = f.id; toolType = MotionEvent.TOOL_TYPE_FINGER
                } }.toTypedArray()
                val coords = fingers.map { f -> MotionEvent.PointerCoords().apply {
                    x = f.x; y = f.y; pressure = 1f; size = 1f
                } }.toTypedArray()
                val time = SystemClock.uptimeMillis()
                val e = MotionEvent.obtain(time, time, action, fingers.size, properties, coords,
                    0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, flags)
                try { instrument.runOnMainSync { assertTrue(root.dispatchTouchEvent(e)) } }
                finally { e.recycle() }
            }
            val a = Finger(7, 300f, 300f)
            val b = Finger(19, 700f, 300f)
            repeat(3) {
                send(MotionEvent.ACTION_DOWN, a)
                assertEquals(.25f, events.last().x, .001f)
                assertEquals(.5f, events.last().y, .001f)
                send(MotionEvent.ACTION_POINTER_DOWN or (1 shl 8), a, b)
                send(MotionEvent.ACTION_MOVE, a.copy(x = 250f), b.copy(x = 750f))
                send(MotionEvent.ACTION_POINTER_UP, a, b)
                send(MotionEvent.ACTION_MOVE, b.copy(y = 250f))
                send(MotionEvent.ACTION_UP, b)
                assertTrue(held.isEmpty())
            }
            // A third contact is forwarded, without a keyboard shortcut or pointer-index mix-up.
            send(MotionEvent.ACTION_DOWN, a)
            send(MotionEvent.ACTION_POINTER_DOWN or (1 shl 8), a, b)
            send(MotionEvent.ACTION_POINTER_DOWN or (2 shl 8), a, b, Finger(27, 500f, 200f))
            assertEquals(setOf(7, 19, 27), held)
            send(MotionEvent.ACTION_CANCEL, a, b)
            assertTrue(held.isEmpty())
            val count = events.size
            send(MotionEvent.ACTION_UP, a)
            assertEquals(count, events.size)
            assertEquals(0, keyboardChecks)
            // A gesture that starts in a black bar never generates an edge click.
            send(MotionEvent.ACTION_DOWN, Finger(3, 20f, 300f))
            send(MotionEvent.ACTION_MOVE, Finger(3, 200f, 300f))
            send(MotionEvent.ACTION_UP, Finger(3, 200f, 300f))
            assertEquals(count, events.size)
            assertEquals(0, keyboardChecks)
            send(MotionEvent.ACTION_DOWN, a)
            instrument.runOnMainSync { context!!.cancel() }
            send(MotionEvent.ACTION_UP, a)
            assertTrue(held.isEmpty())
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                send(MotionEvent.ACTION_DOWN, a)
                send(MotionEvent.ACTION_UP, a, flags = MotionEvent.FLAG_CANCELED)
                assertEquals(MoonBridge.LI_TOUCH_EVENT_CANCEL, events.last().type)
            }
            assertEquals(0, keyboardChecks)
            send(MotionEvent.ACTION_DOWN, a)
            send(MotionEvent.ACTION_UP, a)
            assertEquals(1, keyboardChecks)
            assertTrue(feedbackPoints.isEmpty()) // Native touch has its own host feedback.
            // ChatGPT buffers a first finger: a swipe never clicks or starts a native drag.
            instrument.runOnMainSync { context!!.setScrollCompatibility(true) }
            val beforeCompatibility = events.size
            send(MotionEvent.ACTION_DOWN, a)
            assertTrue(feedbackVisible)
            assertEquals(200f to 200f, feedbackPoints.last())
            send(MotionEvent.ACTION_MOVE, a.copy(y = 200f))
            assertEquals(200f to 100f, feedbackPoints.last()) // Follows finger, not fixed scroll target.
            send(MotionEvent.ACTION_UP, a.copy(y = 200f))
            assertEquals(1, feedbackReleases)
            assertFalse(feedbackVisible)
            assertEquals(beforeCompatibility, events.size)
            assertEquals(listOf(200f to 200f), mousePositions)
            assertTrue(wheels.single().first < 0)
            assertTrue(clicks.isEmpty())
            send(MotionEvent.ACTION_DOWN, a)
            send(MotionEvent.ACTION_UP, a)
            assertEquals(listOf(false), clicks)
            assertEquals(2, keyboardChecks)
            // Black bars, Android cancellation and focus/mode cancellation cannot click.
            val mouseCount = mousePositions.size
            send(MotionEvent.ACTION_DOWN, Finger(3, 20f, 300f))
            assertFalse(feedbackVisible)
            send(MotionEvent.ACTION_MOVE, a)
            send(MotionEvent.ACTION_UP, a)
            send(MotionEvent.ACTION_DOWN, a)
            send(MotionEvent.ACTION_CANCEL, a)
            assertFalse(feedbackVisible)
            send(MotionEvent.ACTION_UP, a)
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                send(MotionEvent.ACTION_DOWN, a)
                send(MotionEvent.ACTION_UP, a, flags = MotionEvent.FLAG_CANCELED)
            }
            send(MotionEvent.ACTION_DOWN, a)
            instrument.runOnMainSync { context!!.cancel() }
            send(MotionEvent.ACTION_UP, a)
            assertEquals(mouseCount, mousePositions.size)
            assertEquals(1, clicks.size)
            // A second finger before scrolling switches to native pinch, preserving IDs.
            send(MotionEvent.ACTION_DOWN, a)
            send(MotionEvent.ACTION_POINTER_DOWN or (1 shl 8), a, b)
            assertFalse(feedbackVisible) // Native pinch must not display a duplicate local circle.
            assertEquals(setOf(7, 19), held)
            send(MotionEvent.ACTION_MOVE, a.copy(x = 250f), b.copy(x = 750f))
            send(MotionEvent.ACTION_POINTER_UP, a, b)
            send(MotionEvent.ACTION_MOVE, b.copy(y = 250f))
            send(MotionEvent.ACTION_UP, b)
            assertTrue(held.isEmpty())
            assertEquals(2, keyboardChecks)
            // Once scrolling starts, adding another finger cancels the rest of this gesture.
            send(MotionEvent.ACTION_DOWN, a)
            send(MotionEvent.ACTION_MOVE, a.copy(y = 200f))
            val committedCount = events.size
            val wheelCount = wheels.size
            send(MotionEvent.ACTION_POINTER_DOWN or (1 shl 8), a, b)
            send(MotionEvent.ACTION_POINTER_UP, a, b)
            send(MotionEvent.ACTION_UP, b)
            assertEquals(committedCount, events.size)
            assertEquals(wheelCount, wheels.size)
            assertEquals(1, clicks.size)
            // First app identification changes the next gesture, without discarding a tap.
            instrument.runOnMainSync { context!!.setScrollCompatibility(false) }
            send(MotionEvent.ACTION_DOWN, a)
            instrument.runOnMainSync { context!!.setScrollCompatibility(true) }
            send(MotionEvent.ACTION_UP, a)
            assertEquals(MoonBridge.LI_TOUCH_EVENT_UP, events.last().type)
            assertEquals(3, keyboardChecks)
            instrument.runOnMainSync { context!!.setScrollCompatibility(false) }
            // Exercise preference migration and the actual toolbar selector without a host connection.
            prefs.edit().remove(TouchMode.PREF).putBoolean("checkbox_touchscreen_trackpad", false).commit()
            assertEquals(TouchMode.DIRECT, TouchMode.read(screen))
            prefs.edit().putBoolean("checkbox_touchscreen_trackpad", true).commit()
            assertEquals(TouchMode.TRACKPAD, TouchMode.read(screen))
            var selected = TouchMode.TRACKPAD
            lateinit var toolbar: DesktopToolbar.Controller
            instrument.runOnMainSync {
                toolbar = DesktopToolbar.attach(screen, root, null, object : DesktopToolbar.Actions {
                    override fun keyboard() = Unit
                    override fun disconnect() = Unit
                    override fun gameModeChanged(enabled: Boolean) = Unit
                    override fun applicationChanged() { context!!.cancel() }
                    override fun scrollCompatibilityChanged(enabled: Boolean) { context!!.setScrollCompatibility(enabled) }
                    override fun touchMode() = selected
                    override fun selectTouchMode(mode: TouchMode) { selected = mode; mode.save(screen) }
                })
            }
            instrument.waitForIdleSync()
            val handle = root.findViewById<View>(R.id.desktopControlsHandle)
            val panel = root.findViewById<View>(R.id.desktopToolbar)
            assertTrue(handle.isShown)
            assertFalse(panel.isShown)
            // The old collapsed bar intercepted the bottom desktop area. Verify it is usable.
            val beforeBottomTap = desktopTouches
            val bottom = Finger(1, root.width / 2f, root.height - 20f)
            send(MotionEvent.ACTION_DOWN, bottom)
            send(MotionEvent.ACTION_UP, bottom)
            assertEquals(beforeBottomTap + 2, desktopTouches)
            val beforeHandleDrag = desktopTouches
            val handleFinger = Finger(4, handle.x + handle.width / 2f, handle.y + handle.height / 2f)
            val startY = handle.y
            send(MotionEvent.ACTION_DOWN, handleFinger)
            send(MotionEvent.ACTION_MOVE, handleFinger.copy(y = handleFinger.y - 150))
            send(MotionEvent.ACTION_UP, handleFinger.copy(y = handleFinger.y - 150))
            assertTrue(handle.y < startY)
            assertFalse(panel.isShown)
            assertEquals(beforeHandleDrag, desktopTouches)
            val savedY = handle.y
            val moved = handleFinger.copy(y = handle.y + handle.height / 2f)
            send(MotionEvent.ACTION_DOWN, moved)
            send(MotionEvent.ACTION_MOVE, moved.copy(y = moved.y + 200))
            send(MotionEvent.ACTION_CANCEL, moved.copy(y = moved.y + 200))
            assertEquals(savedY, handle.y, .1f)
            assertFalse(panel.isShown)
            send(MotionEvent.ACTION_DOWN, moved)
            send(MotionEvent.ACTION_UP, moved)
            instrument.waitForIdleSync()
            assertFalse(handle.isShown)
            assertTrue(panel.isShown)
            instrument.runOnMainSync { root.findViewById<View>(R.id.desktopCollapseButton).performClick() }
            assertTrue(handle.isShown)
            assertFalse(panel.isShown)
            instrument.runOnMainSync {
                toolbar.setGameMode(true)
                assertFalse(handle.isShown)
                assertFalse(panel.isShown)
                toolbar.setGameMode(false)
                assertTrue(handle.isShown)
                handle.performClick()
                root.findViewById<View>(R.id.touchModeButton).performClick()
            }
            onView(withText(screen.getString(R.string.touch_mode_phone))).inRoot(isDialog()).perform(click())
            assertEquals(TouchMode.PHONE, selected)
            assertEquals(TouchMode.PHONE, TouchMode.read(screen))
            // Only ChatGPT uses wheel scrolling; Orca/general retain native contacts.
            val checksBeforeProfiles = keyboardChecks
            fun swipeInPhoneMode(compatible: Boolean) {
                assertEquals(TouchMode.PHONE, selected)
                for (endY in listOf(200f, 400f)) {
                    val before = events.size
                    val wheelsBefore = wheels.size
                    val clicksBefore = clicks.size
                    send(MotionEvent.ACTION_DOWN, a)
                    send(MotionEvent.ACTION_MOVE, a.copy(y = endY))
                    send(MotionEvent.ACTION_UP, a.copy(y = endY))
                    if (compatible) {
                        assertEquals(before, events.size)
                        assertEquals(wheelsBefore + 1, wheels.size)
                        assertEquals(endY > 300f, wheels.last().first > 0)
                        assertEquals(200f to 200f, mousePositions.last())
                    } else {
                        assertEquals(wheelsBefore, wheels.size)
                        assertEquals(listOf(
                            Contact(MoonBridge.LI_TOUCH_EVENT_DOWN, 7, .25f, .5f),
                            Contact(MoonBridge.LI_TOUCH_EVENT_MOVE, 7, .25f, (endY - 100f) / 400f),
                            Contact(MoonBridge.LI_TOUCH_EVENT_UP, 7, .25f, (endY - 100f) / 400f)
                        ), events.drop(before))
                    }
                    assertEquals(clicksBefore, clicks.size)
                    assertTrue(held.isEmpty())
                    assertEquals(checksBeforeProfiles, keyboardChecks)
                }
            }
            instrument.runOnMainSync {
                toolbar.setConnected(true); toolbar.setFocused(true); toolbar.setAutomaticMode(true)
            }
            for (profile in listOf(DesktopProfile.GENERAL, DesktopProfile.ORCA, DesktopProfile.CHATGPT)) {
                instrument.runOnMainSync { toolbar.observeApplication(profile.id) }
                assertEquals(profile, toolbar.profile)
                swipeInPhoneMode(profile == DesktopProfile.CHATGPT)
            }
            for (profile in DesktopProfile.values()) {
                instrument.runOnMainSync { toolbar.setProfile(profile); toolbar.observeApplication(profile.id) }
                swipeInPhoneMode(profile == DesktopProfile.CHATGPT)
            }
            // A manual ChatGPT toolbar must not reinterpret Orca's touch gestures.
            instrument.runOnMainSync { toolbar.setProfile(DesktopProfile.CHATGPT) }
            swipeInPhoneMode(false)
            instrument.runOnMainSync { toolbar.observeApplication("chatgpt") }
            swipeInPhoneMode(true)
            send(MotionEvent.ACTION_DOWN, a)
            instrument.runOnMainSync { toolbar.observeApplication("general") }
            val mouseBeforeSwitch = mousePositions.size
            send(MotionEvent.ACTION_UP, a)
            assertEquals(mouseBeforeSwitch, mousePositions.size)
            // A foreground change releases an in-flight contact and ignores the old release.
            send(MotionEvent.ACTION_DOWN, a)
            instrument.runOnMainSync { toolbar.observeApplication("orca") }
            assertEquals(MoonBridge.LI_TOUCH_EVENT_CANCEL_ALL, events.last().type)
            val cancelledCount = events.size
            send(MotionEvent.ACTION_UP, a)
            assertEquals(cancelledCount, events.size)
            assertTrue(held.isEmpty())
            assertEquals(checksBeforeProfiles, keyboardChecks)
            instrument.runOnMainSync { root.findViewById<View>(R.id.touchModeButton).performClick() }
            onView(withText(screen.getString(R.string.touch_mode_direct))).inRoot(isDialog()).perform(click())
            assertEquals(TouchMode.DIRECT, selected)
            assertEquals(TouchMode.DIRECT, TouchMode.read(screen))
        } finally {
            instrument.runOnMainSync { context?.cancel(); activity?.finish() }
            prefs.edit().apply {
                if (oldMode == null) remove(TouchMode.PREF) else putString(TouchMode.PREF, oldMode)
                if (hadLegacy) putBoolean("checkbox_touchscreen_trackpad", oldLegacy) else remove("checkbox_touchscreen_trackpad")
            }.commit()
            handlePrefs.edit().apply {
                if (hadHandlePosition) putFloat("handle_y", oldHandlePosition) else remove("handle_y")
                if (oldProfile == null) remove("profile") else putString("profile", oldProfile)
                if (oldAutomatic == null) remove("automatic_app") else putBoolean("automatic_app", oldAutomatic)
            }.commit()
        }
    }
}
