package com.cliprelay.app

import com.limelight.binding.input.touch.ModifierClickState
import com.limelight.ui.VirtualKeyboardState
import org.junit.Assert.*
import org.junit.Test

class ModifierClickTest {
    private val events = mutableListOf<String>()
    private val held = mutableSetOf<Int>()
    private val keyboard = VirtualKeyboardState { key, down, modifiers ->
        if (down) assertTrue(held.add(key)) else assertTrue(held.remove(key))
        events += "$key:$down:$modifiers"
    }.apply { setEnabled(true) }
    private val gesture = ModifierClickState(object : ModifierClickState.Sink {
        override fun hasModifiers() = keyboard.hasModifiers()
        override fun click(x: Float, y: Float) {
            events += "position:$x:$y"
            keyboard.clickWithModifiers {
                assertTrue("Mouse click lost its selected modifier", held.isNotEmpty())
                events += "mouse:down"
                events += "mouse:up"
            }
        }
    }, 8f, 500)

    private fun down(inside: Boolean = true) = gesture.down(7, 100f, 200f, 1000, inside)
    private fun up(time: Long = 1100) = gesture.up(7, 100f, 200f, time)

    @Test fun controlTapUsesRealLeftClickWithControlThroughMouseUpThenReleases() {
        keyboard.press(17)
        assertTrue(down()); assertTrue(events.isEmpty())
        assertTrue(up())
        assertEquals(listOf("position:100.0:200.0", "17:true:2", "mouse:down", "mouse:up", "17:false:0"), events)
        assertTrue(held.isEmpty()); assertFalse(keyboard.hasModifiers())
        assertFalse("Next normal tap must return to the user's touch mode", down())
        assertFalse(up())
    }

    @Test fun ordinaryTapsAndLetterboxTapsAreNotCaptured() {
        assertFalse(down()); assertFalse(up())
        keyboard.press(17)
        assertFalse(down(false)); assertFalse(up())
        assertTrue(events.isEmpty()); assertTrue(keyboard.hasModifiers())
    }

    @Test fun dragLongPressAndMultipleFingersDoNotOpenALink() {
        keyboard.press(17)
        assertTrue(down())
        gesture.move(7, 120f, 200f); gesture.move(7, 100f, 200f)
        assertTrue(up()); assertTrue(events.isEmpty())
        assertTrue(down()); assertTrue(up(1600)); assertTrue(events.isEmpty())
        assertTrue(down()); gesture.cancel()
        assertTrue(gesture.isCaptured()); assertTrue(up()); assertTrue(events.isEmpty())
        assertTrue(down()); gesture.up(8, 100f, 200f, 1100)
        assertTrue(events.isEmpty())
    }

    @Test fun hidePauseAndDisconnectCannotSendAPendingClick() {
        keyboard.press(17); assertTrue(down())
        keyboard.setEnabled(false)
        assertTrue(up()); assertTrue(events.isEmpty()); assertTrue(held.isEmpty())
        keyboard.setEnabled(true)
        assertFalse(down())
    }

    @Test fun cancellationConsumesTailWithoutReplayingOnNextTap() {
        keyboard.press(17); assertTrue(down()); gesture.cancel()
        assertTrue(up()); assertTrue(events.isEmpty())
        // A fresh intentional tap can use the still-visible selection.
        assertTrue(down()); assertTrue(up())
        assertEquals(1, events.count { it == "mouse:down" })
    }

    @Test fun combinedModifiersCoverBothMouseEvents() {
        keyboard.press(17); keyboard.press(16); assertTrue(down()); assertTrue(up())
        assertEquals(listOf("position:100.0:200.0", "16:true:1", "17:true:3",
            "mouse:down", "mouse:up", "17:false:1", "16:false:0"), events)
        assertTrue(held.isEmpty())
    }

    @Test fun failedMouseActionStillReleasesModifiers() {
        keyboard.press(17)
        try {
            keyboard.clickWithModifiers { throw IllegalStateException("Disconnected") }
            fail("Expected transport failure")
        } catch (_: IllegalStateException) { }
        assertEquals(listOf("17:true:2", "17:false:0"), events)
        assertTrue(held.isEmpty()); assertFalse(keyboard.hasModifiers())
        keyboard.clickWithModifiers { fail("No selected modifier must not send a click") }
    }

    @Test fun hostDelayedMouseUpStillSeesControlAndNewInputCannotReleaseItEarly() {
        var release: Runnable? = null
        val state = VirtualKeyboardState({ key, down, _ ->
            if (down) held.add(key) else held.remove(key)
        }, { release = it }).apply { setEnabled(true) }
        state.press(17)
        state.clickWithModifiers { events += "mouse:down" }
        assertTrue(state.isClickPending()); assertTrue(held.contains(17))
        state.press(65); state.pressAlone(17)
        assertTrue(held.contains(17)); assertFalse(held.contains(65))
        // Model Sunshine's later mouse-UP dispatch before the scheduled cleanup.
        assertTrue("Control was released before Windows delivered mouse UP", held.contains(17))
        release!!.run()
        assertTrue(held.isEmpty()); assertFalse(state.isClickPending())
    }

    @Test fun interruptionReleasesImmediatelyAndOldTimerCannotClearANewSelection() {
        var release: Runnable? = null
        val state = VirtualKeyboardState({ key, down, _ ->
            if (down) held.add(key) else held.remove(key)
        }, { release = it }).apply { setEnabled(true) }
        state.press(17); state.clickWithModifiers { }
        state.setEnabled(false)
        assertTrue(held.isEmpty()); assertFalse(state.isClickPending())
        state.setEnabled(true); state.press(16)
        release!!.run()
        assertTrue(state.isSelected(16)); assertTrue(held.isEmpty())
    }
}
