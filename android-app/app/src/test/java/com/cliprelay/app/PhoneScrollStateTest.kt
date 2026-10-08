package com.cliprelay.app

import com.limelight.binding.input.touch.PhoneScrollState
import com.limelight.ui.DesktopProfile
import org.junit.Assert.*
import org.junit.Test

class PhoneScrollStateTest {
    private val positions = mutableListOf<Pair<Float, Float>>()
    private val wheels = mutableListOf<Pair<Short, Short>>()
    private val clicks = mutableListOf<Boolean>()
    private val state = PhoneScrollState(object : PhoneScrollState.Sink {
        override fun position(x: Float, y: Float) { positions += x to y }
        override fun scroll(vertical: Short, horizontal: Short) { wheels += vertical to horizontal }
        override fun click(right: Boolean) { clicks += right }
    }, 8f, 2f)

    @Test fun sidebarSwipePinsTargetAndNeverClicksOrChangesAxis() {
        state.down(80f, 300f)
        state.move(82f, 296f)
        assertTrue(positions.isEmpty())
        state.move(80f, 204f)
        state.move(450f, 108f) // Finger leaves the sidebar; target stays there.
        state.up(460f, 204f) // Reversal still scrolls the original region.
        assertEquals(listOf((-120).toShort() to 0.toShort(), (-120).toShort() to 0.toShort(),
            120.toShort() to 0.toShort()), wheels)
        assertTrue(positions.all { it == 80f to 300f })
        assertTrue(clicks.isEmpty())
    }

    @Test fun horizontalSwipeHasNaturalDirectionAndLocksItsAxis() {
        state.down(200f, 100f)
        state.move(104f, 100f)
        state.move(8f, 600f)
        state.up(8f, 600f)
        assertEquals(listOf(0.toShort() to 120.toShort(), 0.toShort() to 120.toShort()), wheels)
        assertTrue(clicks.isEmpty())
    }

    @Test fun tapAndLongPressAreExclusiveAndUseTheInitialPoint() {
        state.down(100f, 100f)
        assertTrue(state.canStartMultiTouch())
        assertTrue(state.up(102f, 103f))
        state.down(200f, 200f)
        state.longPress()
        state.longPress()
        assertFalse(state.canStartMultiTouch())
        state.move(200f, 50f)
        assertFalse(state.up(200f, 50f))
        assertEquals(listOf(false, true), clicks)
        assertEquals(listOf(100f to 100f, 200f to 200f), positions)
        assertTrue(wheels.isEmpty())
    }

    @Test fun cancelAndSecondFingerNeverCommitThePendingClick() {
        state.down(100f, 100f)
        assertTrue(state.canStartMultiTouch())
        state.cancel()
        state.longPress()
        state.move(100f, 300f)
        assertFalse(state.up(100f, 300f))
        assertTrue(positions.isEmpty())
        assertTrue(clicks.isEmpty())
        state.down(100f, 100f)
        state.move(100f, 200f)
        assertFalse(state.canStartMultiTouch())
        state.cancel()
        val count = wheels.size
        assertFalse(state.up(100f, 300f))
        assertEquals(count, wheels.size)
    }

    @Test fun fractionalMovementAccumulatesAndMissingMovesDoNotTurnSwipesIntoClicks() {
        state.down(100f, 200f)
        state.move(100f, 180f)
        repeat(80) { state.move(100f, 180f - (it + 1) * .25f) }
        state.up(100f, 160f)
        assertEquals(-50, wheels.sumOf { it.first.toInt() })
        state.down(100f, 200f)
        assertFalse(state.up(100f, 104f))
        assertEquals(-120, wheels.last().first.toInt())
        assertTrue(clicks.isEmpty())
    }

    @Test fun invalidCoordinatesCancelInsteadOfClicking() {
        state.down(Float.NaN, 100f)
        assertFalse(state.up(100f, 100f))
        state.down(100f, 100f)
        assertFalse(state.up(Float.POSITIVE_INFINITY, 100f))
        assertTrue(positions.isEmpty())
        assertTrue(clicks.isEmpty())
    }

    @Test fun onlyChatGptUsesCompatibilityAndKnownForegroundOverridesLayout() {
        for (profile in DesktopProfile.values()) for (automatic in listOf(true, false)) {
            assertTrue(profile.usesPhoneScrollCompatibility("chatgpt", automatic, false))
            for (app in listOf("orca", "general", "stardew", "plateup", "unknown")) {
                assertFalse(profile.usesPhoneScrollCompatibility(app, automatic, false))
            }
            assertFalse(profile.usesPhoneScrollCompatibility("chatgpt", automatic, true))
            assertEquals(!automatic && profile == DesktopProfile.CHATGPT,
                profile.usesPhoneScrollCompatibility(null, automatic, false))
        }
    }
}
