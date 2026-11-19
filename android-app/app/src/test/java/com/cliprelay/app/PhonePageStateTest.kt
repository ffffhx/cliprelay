package com.cliprelay.app

import com.limelight.binding.input.ApplicationPolicy
import com.limelight.binding.input.touch.PhonePageState
import org.junit.Assert.*
import org.junit.Test

class PhonePageStateTest {
    private val positions = mutableListOf<Pair<Float, Float>>()
    private val pages = mutableListOf<Boolean>()
    private val clicks = mutableListOf<Boolean>()
    private val state = PhonePageState(object : PhonePageState.Sink {
        override fun position(x: Float, y: Float) { positions += x to y }
        override fun page(pageDown: Boolean) { pages += pageDown }
        override fun click(right: Boolean) { clicks += right }
    }, 8f, 2f) // 96px of travel per page

    @Test fun swipeUpPagesDownAndSwipeDownPagesUp() {
        state.down(300f, 400f, 0)
        state.move(300f, 304f, 16)
        state.up(300f, 304f, 32)
        assertEquals(listOf(true), pages)
        state.down(300f, 100f, 100)
        state.move(300f, 196f, 116)
        state.up(300f, 196f, 132)
        assertEquals(listOf(true, false), pages)
        assertTrue(clicks.isEmpty())
    }

    @Test fun pagesAreRateLimitedAndNeverReplayed() {
        state.down(300f, 500f, 0)
        state.move(300f, 404f, 10) // One page; the next interval starts at 80ms.
        state.move(300f, 308f, 20) // Too soon: the page is dropped, not queued.
        state.move(300f, 212f, 90)
        assertEquals(listOf(true, true), pages)
        state.move(300f, 212f, 400) // No travel left, so no replay.
        assertEquals(2, pages.size)
    }

    @Test fun perEventTravelBeyondOnePageStillEmitsOneTap() {
        state.down(300f, 700f, 0)
        state.move(300f, 100f, 10) // 600px in one coalesced event.
        assertEquals(1, pages.size)
        assertEquals(true, pages.single())
        state.move(300f, 100f, 200)
        assertEquals(1, pages.size)
    }

    @Test fun horizontalSwipeEmitsNothingAndIsNotATap() {
        state.down(300f, 300f, 0)
        state.move(200f, 302f, 16)
        state.move(100f, 500f, 32)
        state.up(100f, 500f, 48)
        assertTrue(pages.isEmpty())
        assertTrue(clicks.isEmpty())
        assertTrue(positions.isEmpty())
    }

    @Test fun tapClicksLeftLongPressClicksRightAtTheDownPoint() {
        state.down(300f, 300f, 0)
        assertTrue(state.up(302f, 303f, 16))
        state.down(400f, 400f, 100)
        state.longPress()
        state.longPress()
        assertFalse(state.canStartMultiTouch())
        state.move(400f, 200f, 116)
        assertFalse(state.up(400f, 200f, 132))
        assertEquals(listOf(false, true), clicks)
        assertEquals(listOf(300f to 300f, 400f to 400f), positions)
        assertTrue(pages.isEmpty())
    }

    @Test fun shortFlickPastSlopBelowOnePageIsANoOp() {
        state.down(300f, 300f, 0)
        state.move(300f, 280f, 16)
        state.up(300f, 280f, 32)
        assertTrue(pages.isEmpty())
        assertTrue(clicks.isEmpty())
        assertTrue(positions.isEmpty())
    }

    @Test fun jitterUnderSlopIsATap() {
        state.down(300f, 300f, 0)
        state.move(302f, 303f, 16)
        assertTrue(state.up(301f, 302f, 32))
        assertEquals(listOf(false), clicks)
        assertTrue(pages.isEmpty())
    }

    @Test fun cancelAndSecondFingerHandoffNeverCommit() {
        state.down(300f, 300f, 0)
        assertTrue(state.canStartMultiTouch())
        state.cancel()
        state.longPress()
        state.move(300f, 100f, 16)
        assertFalse(state.up(300f, 100f, 32))
        assertTrue(pages.isEmpty())
        assertTrue(clicks.isEmpty())
        assertTrue(positions.isEmpty())
        state.down(300f, 300f, 100)
        state.move(300f, 200f, 116)
        assertEquals(1, pages.size)
        assertFalse(state.canStartMultiTouch())
        state.cancel()
        val count = pages.size
        assertFalse(state.up(300f, 100f, 200))
        assertEquals(count, pages.size)
        assertTrue(clicks.isEmpty())
    }

    @Test fun invalidCoordinatesCancelInsteadOfClicking() {
        state.down(Float.NaN, 100f, 0)
        assertFalse(state.up(100f, 100f, 16))
        state.down(100f, 100f, 100)
        assertFalse(state.up(Float.POSITIVE_INFINITY, 100f, 116))
        state.down(100f, 100f, 200)
        state.move(100f, Float.NaN, 216)
        assertFalse(state.up(100f, 50f, 232))
        assertTrue(clicks.isEmpty())
        assertTrue(pages.isEmpty())
    }

    @Test fun terminalAreaKeepsTheLeftQuarterForNativeTouch() {
        assertFalse(PhonePageState.isTerminalArea(0f, 800f))
        assertFalse(PhonePageState.isTerminalArea(199.9f, 800f))
        assertFalse(PhonePageState.isTerminalArea(200f, 800f)) // Boundary stays native.
        assertTrue(PhonePageState.isTerminalArea(200.1f, 800f))
        assertTrue(PhonePageState.isTerminalArea(799f, 800f))
        assertFalse(PhonePageState.isTerminalArea(300f, 0f))
        assertFalse(PhonePageState.isTerminalArea(300f, -800f))
        assertFalse(PhonePageState.isTerminalArea(Float.NaN, 800f))
        assertFalse(PhonePageState.isTerminalArea(300f, Float.NaN))
    }

    @Test fun singleFingerGesturesNeverEnableLegacyPaging() {
        for (app in listOf(null, "orca", "chatgpt", "general", "stardew", "plateup", "unknown")) {
            assertFalse(ApplicationPolicy.usesPhonePageCompatibility(app, false))
        }
        for (app in listOf(null, "chatgpt", "orca", "general", "stardew", "plateup")) {
            assertFalse(ApplicationPolicy.usesPhonePageCompatibility(app, true))
        }
        // Orca keeps native single-finger touch and its independent pinch shortcuts.
        assertFalse(ApplicationPolicy.usesPhoneScrollCompatibility("orca", false))
        assertTrue(ApplicationPolicy.usesPhonePinchCompatibility("orca", false))
    }
}
