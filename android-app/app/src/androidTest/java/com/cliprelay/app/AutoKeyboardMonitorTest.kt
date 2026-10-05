package com.cliprelay.app

import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import com.limelight.binding.input.AutoKeyboardMonitor
import com.limelight.binding.input.AutoKeyboardPolicy
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Reproduces app identification racing the focus response after a real tap. */
class AutoKeyboardMonitorTest {
    private val instrument = InstrumentationRegistry.getInstrumentation()
    private fun ui(action: () -> Unit) = instrument.runOnMainSync(action)
    private fun editable(id: String) = JSONObject().put("supported", true)
        .put("editable", true).put("focusId", id).put("targeted", true)

    @Test fun appSwitchDiscardsOldResponseAndKeepsPendingTap() {
        instrument.sendStatus(0, android.os.Bundle().apply {
            putString("configuredTouchMode", com.limelight.preferences.TouchMode.read(instrument.targetContext).value)
        })
        val firstRequest = CountDownLatch(1)
        val finishOldRequest = CountDownLatch(1)
        val shown = CountDownLatch(1)
        val reads = AtomicInteger()
        val actions = mutableListOf<Int>()
        lateinit var monitor: AutoKeyboardMonitor
        ui {
            monitor = AutoKeyboardMonitor(AutoKeyboardMonitor.FocusSource { x, y ->
                assertEquals(.3f, x, .001f); assertEquals(.7f, y, .001f)
                if (reads.incrementAndGet() == 1) {
                    firstRequest.countDown()
                    check(finishOldRequest.await(2, TimeUnit.SECONDS))
                    editable("old-app-input")
                } else editable("new-app-input")
            }) { action -> actions += action; shown.countDown() }
            monitor.tap(.3f, .7f)
        }
        try {
            assertTrue(firstRequest.await(2, TimeUnit.SECONDS))
            ui { monitor.foregroundChanged() }
            finishOldRequest.countDown()
            assertTrue("Application recognition cancelled the tap", shown.await(3, TimeUnit.SECONDS))
            ui { assertEquals(listOf(AutoKeyboardPolicy.SHOW), actions) }
            assertTrue("New focus wasn't checked twice", reads.get() >= 3)
            // A later app observation without another user tap must not reopen IME.
            ui { monitor.foregroundChanged() }
            SystemClock.sleep(500)
            ui { assertEquals(1, actions.size) }
        } finally { finishOldRequest.countDown(); ui { monitor.close() } }
    }

    @Test fun dismissalStillCancelsInFlightFocusAndAppChanges() {
        val requested = CountDownLatch(1)
        val respond = CountDownLatch(1)
        val calls = AtomicInteger()
        val actions = AtomicInteger()
        lateinit var monitor: AutoKeyboardMonitor
        ui {
            monitor = AutoKeyboardMonitor(AutoKeyboardMonitor.FocusSource { _, _ ->
                calls.incrementAndGet(); requested.countDown()
                check(respond.await(2, TimeUnit.SECONDS))
                editable("input")
            }) { actions.incrementAndGet() }
            monitor.tap(.3f, .7f)
        }
        try {
            assertTrue(requested.await(2, TimeUnit.SECONDS))
            ui { monitor.cancel(); monitor.foregroundChanged() }
            respond.countDown()
            SystemClock.sleep(600)
            assertEquals("Dismissed keyboard reopened", 0, actions.get())
            assertEquals("App change invented a new tap", 1, calls.get())
        } finally { respond.countDown(); ui { monitor.close() } }
    }

    @Test fun sessionAutofocusOutsideTapNeverShowsKeyboard() {
        val decided = CountDownLatch(1)
        val actions = mutableListOf<Int>()
        lateinit var monitor: AutoKeyboardMonitor
        ui {
            monitor = AutoKeyboardMonitor(AutoKeyboardMonitor.FocusSource { x, _ ->
                // The session sidebar retains or automatically assigns editor focus,
                // but the point query reports that this tap did not hit the editor.
                editable("session-editor").put("editable", x > .5f)
                    .put("focusId", if (x > .5f) "session-editor" else "")
            }) { action -> actions += action; decided.countDown() }
            monitor.tap(.1f, .4f)
            monitor.foregroundChanged()
        }
        try {
            assertTrue(decided.await(3, TimeUnit.SECONDS))
            ui { assertEquals(listOf(AutoKeyboardPolicy.HIDE), actions) }
            ui { monitor.foregroundChanged() }
            SystemClock.sleep(400)
            ui { assertEquals(1, actions.size) }
        } finally { ui { monitor.close() } }
    }
}
