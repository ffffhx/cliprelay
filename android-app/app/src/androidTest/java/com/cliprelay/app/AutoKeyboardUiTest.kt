package com.cliprelay.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.view.View
import android.view.WindowInsets
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.limelight.ui.StreamView
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Exercises the actual phone IME without sending any input to a computer. */
@RunWith(AndroidJUnit4::class)
class AutoKeyboardUiTest {
    @Test fun streamViewCanShowAndDismissSystemKeyboard() {
        val instrument = InstrumentationRegistry.getInstrumentation()
        val activity = instrument.startActivitySync(Intent().setClassName(
            instrument.targetContext.packageName, "com.limelight.PcView").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        lateinit var stream: StreamView
        val ime = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        try {
            // PcView completes GL/device setup asynchronously and can replace its
            // content view. Install the isolated editor only after that settles.
            instrument.waitForIdleSync()
            SystemClock.sleep(1200)
            instrument.runOnMainSync {
                activity.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                stream = StreamView(activity).apply { isFocusable = true; isFocusableInTouchMode = true }
                val root = FrameLayout(activity)
                root.addView(stream, FrameLayout.LayoutParams(-1, -1))
                activity.setContentView(root)
                stream.requestFocus()
            }
            instrument.waitForIdleSync()
            val focusDeadline = SystemClock.uptimeMillis() + 3000
            while (!stream.hasWindowFocus() && SystemClock.uptimeMillis() < focusDeadline) SystemClock.sleep(50)
            assertTrue("Test editor was detached during activity setup", stream.isAttachedToWindow)
            if (!stream.hasWindowFocus()) {
                instrument.runOnMainSync {
                    instrument.sendStatus(0, android.os.Bundle().apply {
                        putBoolean("activityFinishing", activity.isFinishing)
                        putBoolean("activityDestroyed", activity.isDestroyed)
                        putBoolean("decorFocus", activity.window.decorView.hasWindowFocus())
                        putInt("windowFlags", activity.window.attributes.flags)
                        putInt("displayId", stream.display.displayId)
                    })
                }
            }
            assertTrue("Test editor window never received focus", stream.hasWindowFocus())
            val keys = mutableListOf<Int>()
            val committed = mutableListOf<String>()
            instrument.runOnMainSync {
                stream.setOnKeyListener { _, key, event ->
                    if (event.action == KeyEvent.ACTION_MULTIPLE && event.characters != null) committed += event.characters
                    if (event.action == KeyEvent.ACTION_DOWN) keys += key
                    true
                }
                val connection = stream.onCreateInputConnection(EditorInfo())!!
                connection.setComposingText("ab", 1)
                connection.deleteSurroundingText(1, 0)
                assertTrue("Composition deletion reached remote host", keys.isEmpty())
                connection.commitText("中文", 1)
                connection.deleteSurroundingText(1, 0)
                connection.deleteSurroundingTextInCodePoints(0, 1)
            }
            instrument.waitForIdleSync()
            assertTrue("Unicode commit was lost", committed.contains("中文"))
            assertTrue("Remote Backspace was lost", keys.contains(KeyEvent.KEYCODE_DEL))
            assertTrue("Remote Delete was lost", keys.contains(KeyEvent.KEYCODE_FORWARD_DEL))
            fun visible(): Boolean {
                var result = false
                instrument.runOnMainSync { result = stream.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true }
                return result
            }
            repeat(2) {
                instrument.runOnMainSync { assertTrue(ime.showSoftInput(stream, InputMethodManager.SHOW_IMPLICIT)) }
                val showDeadline = SystemClock.uptimeMillis() + 3500
                while (!visible() && SystemClock.uptimeMillis() < showDeadline) SystemClock.sleep(80)
                if (!visible()) {
                    instrument.runOnMainSync {
                        instrument.sendStatus(0, android.os.Bundle().apply {
                            putBoolean("viewFocused", stream.hasFocus())
                            putBoolean("windowFocused", stream.hasWindowFocus())
                            putBoolean("imeActive", ime.isActive(stream))
                            putInt("hardwareKeyboard", activity.resources.configuration.keyboard)
                        })
                    }
                }
                assertTrue("System keyboard did not open", visible())
                instrument.runOnMainSync { ime.hideSoftInputFromWindow(stream.windowToken, 0) }
                val hideDeadline = SystemClock.uptimeMillis() + 2500
                while (visible() && SystemClock.uptimeMillis() < hideDeadline) SystemClock.sleep(80)
                assertTrue("Keyboard did not dismiss", !visible())
                SystemClock.sleep(500)
                assertTrue("Keyboard reopened without a new request", !visible())
            }
        } finally {
            instrument.runOnMainSync { ime.hideSoftInputFromWindow(stream.windowToken, 0); activity.finish() }
        }
    }
}
