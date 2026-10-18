package com.cliprelay.app

import com.limelight.binding.input.ApplicationPolicy
import com.limelight.binding.input.touch.PhonePinchState
import org.junit.Assert.*
import org.junit.Test

class PhonePinchStateTest {
    private val zooms = mutableListOf<Boolean>()
    private val wheels = mutableListOf<Pair<Short, Short>>()
    private val positions = mutableListOf<Pair<Float, Float>>()
    private val state = PhonePinchState(object : PhonePinchState.Sink {
        override fun position(x: Float, y: Float) { positions += x to y }
        override fun scroll(vertical: Short, horizontal: Short) { wheels += vertical to horizontal }
        override fun zoom(inside: Boolean) { zooms += inside }
    }, 8f, 2f)

    @Test fun spreadAndPinchAdjustSizeInBothDirectionsWithoutScrolling() {
        state.begin(100f, 200f, 300f, 200f)
        state.move(85f, 200f, 315f, 200f)
        assertEquals(listOf(true), zooms)
        state.move(110f, 200f, 290f, 200f)
        assertEquals(listOf(true, false), zooms)
        assertTrue(wheels.isEmpty())
        assertTrue(positions.isEmpty())
    }

    @Test fun jitterRotationAndStationaryFramesDoNotChangeSize() {
        state.begin(100f, 200f, 300f, 200f)
        repeat(30) {
            state.move(98f, 202f, 302f, 202f)
            state.move(100f, 200f, 300f, 200f)
        }
        state.move(200f, 100f, 200f, 300f)
        assertTrue(zooms.isEmpty())
        assertTrue(wheels.isEmpty())
    }

    @Test fun oneStationaryFingerCanStillPinch() {
        state.begin(100f, 200f, 300f, 200f)
        state.move(100f, 200f, 350f, 200f)
        assertEquals(listOf(true), zooms)
        assertTrue(wheels.isEmpty())
    }

    @Test fun parallelVerticalSwipeKeepsScrollingEvenIfFingersLaterSeparate() {
        state.begin(100f, 200f, 300f, 200f)
        state.move(100f, 296f, 300f, 296f)
        state.move(20f, 392f, 380f, 392f)
        assertEquals(listOf(120.toShort() to 0.toShort(), 120.toShort() to 0.toShort()), wheels)
        assertTrue(positions.all { it == 200f to 200f })
        assertTrue(zooms.isEmpty())
    }

    @Test fun parallelHorizontalSwipeHasNaturalDirection() {
        state.begin(100f, 200f, 300f, 200f)
        state.move(4f, 200f, 204f, 200f)
        assertEquals(listOf(0.toShort() to 120.toShort()), wheels)
        assertTrue(zooms.isEmpty())
    }

    @Test fun zoomNeverTurnsIntoScrollMidGesture() {
        state.begin(100f, 200f, 300f, 200f)
        state.move(85f, 200f, 315f, 200f)
        state.move(85f, 500f, 315f, 500f)
        assertEquals(listOf(true), zooms)
        assertTrue(wheels.isEmpty())
    }

    @Test fun largeFrameIsBoundedAndDoesNotReplayOnStationaryFrames() {
        state.begin(100f, 200f, 300f, 200f)
        state.move(0f, 200f, 800f, 200f)
        assertEquals(3, zooms.size)
        repeat(30) { state.move(0f, 200f, 800f, 200f) }
        assertEquals(3, zooms.size)
    }

    @Test fun cancellationAndInvalidCoordinatesCannotEmitLaterInput() {
        state.begin(100f, 200f, 300f, 200f)
        state.cancel()
        state.move(0f, 200f, 800f, 200f)
        state.begin(100f, 200f, 300f, 200f)
        state.move(Float.NaN, 200f, 300f, 200f)
        state.move(0f, 200f, 800f, 200f)
        state.begin(100f, 200f, 101f, 200f)
        state.move(0f, 200f, 800f, 200f)
        assertTrue(zooms.isEmpty())
        assertTrue(wheels.isEmpty())
    }

    @Test fun crossingFingersCancelsUntilTheNextGesture() {
        state.begin(100f, 200f, 300f, 200f)
        state.move(199f, 200f, 201f, 200f)
        state.move(0f, 200f, 800f, 200f)
        assertTrue(zooms.isEmpty())
        state.begin(100f, 200f, 300f, 200f)
        state.move(85f, 200f, 315f, 200f)
        assertEquals(listOf(true), zooms)
    }

    @Test fun compatibilityOnlyAppliesToOrcaOutsideGameMode() {
        assertTrue(ApplicationPolicy.usesPhonePinchCompatibility("orca", false))
        for (app in listOf(null, "chatgpt", "general", "stardew", "plateup", "unknown")) {
            assertFalse(ApplicationPolicy.usesPhonePinchCompatibility(app, false))
        }
        assertFalse(ApplicationPolicy.usesPhonePinchCompatibility("orca", true))
    }
}
