package com.cliprelay.app

import com.limelight.binding.input.ApplicationPolicy
import com.limelight.binding.input.touch.PhoneScrollState
import org.junit.Assert.*
import org.junit.Test

class ApplicationDetectionTest {
    @Test fun foregroundMustStabilizeAndErrorsNeverSwitchToDesktop() {
        val p = ApplicationPolicy()
        assertNull(p.observe(true, "stardew", 0))
        assertNull(p.observe(true, "orca", 200))
        assertNull(p.observe(true, "orca", 400))
        assertEquals("orca", p.observe(true, "orca", 800))
        assertNull(p.observe(false, "general", 1000))
        assertNull(p.observe(true, "general", 1600))
        assertEquals("general", p.observe(true, "general", 2200))
        assertNull(p.observe(true, "unknown.exe", 3000))
    }

    private class Sink : PhoneScrollState.Sink {
        val clicks = mutableListOf<Boolean>()
        val positions = mutableListOf<Pair<Float, Float>>()
        var vertical = 0
        var horizontal = 0
        override fun position(x: Float, y: Float) { positions += x to y }
        override fun click(right: Boolean) { clicks += right }
        override fun scroll(v: Short, h: Short) { vertical += v; horizontal += h }
    }

    @Test fun swipeScrollsUnderFingerWithoutClickAndDirectionReverses() {
        val sink = Sink(); val gesture = PhoneScrollState(sink, 8f, 2f)
        gesture.down(200f, 300f)
        gesture.move(201f, 204f)
        gesture.up(201f, 204f)
        assertEquals(-120, sink.vertical)
        assertEquals(listOf(200f to 300f), sink.positions)
        assertTrue(sink.clicks.isEmpty())
        gesture.down(200f, 204f)
        gesture.move(200f, 300f); gesture.up(200f, 300f)
        assertEquals(0, sink.vertical)
    }

    @Test fun tapLongPressAndCancelCannotTurnIntoScrollOrDuplicateClick() {
        val sink = Sink(); val gesture = PhoneScrollState(sink, 8f, 2f)
        gesture.down(20f, 20f); assertTrue(gesture.up(21f, 21f))
        gesture.down(20f, 20f); gesture.longPress(); gesture.longPress()
        assertFalse(gesture.up(20f, 50f))
        gesture.down(20f, 20f); gesture.cancel(); gesture.longPress(); gesture.up(20f, 20f)
        assertEquals(listOf(false, true), sink.clicks)
        assertEquals(0, sink.vertical)
    }

    @Test fun horizontalGestureLocksAxisAndSmallDeltasAccumulate() {
        val sink = Sink(); val gesture = PhoneScrollState(sink, 2f, 3f)
        gesture.down(200f, 300f)
        repeat(144) { gesture.move(199f - it, 299f) }
        gesture.up(56f, 299f)
        assertEquals(120, sink.horizontal)
        assertEquals(0, sink.vertical)
        assertTrue(sink.clicks.isEmpty())
    }
}
