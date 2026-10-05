package com.cliprelay.app

import com.limelight.ui.GameInputState
import org.junit.Assert.*
import org.junit.Test

class GameInputStateTest {
    private data class Key(val code: Int, val down: Boolean, val modifiers: Int = 0)
    private val events = mutableListOf<Key>()
    private val state = GameInputState { key, down, modifiers -> events += Key(key, down, modifiers) }
        .apply { setEnabled(true) }

    @Test fun movementAndActionStayHeldUntilTheirOwnFingerLifts() {
        state.update("stick", 87, 68)
        state.update("action", 79)
        repeat(60) { state.update("stick", 87, 68) }
        assertEquals(3, events.size)
        state.update("action")
        assertEquals(Key(79, false), events.last())
        state.update("stick", 68)
        assertEquals(Key(87, false), events.last())
        state.update("stick")
        assertEquals(Key(68, false), events.last())
        assertEquals(6, events.size)
    }

    @Test fun overlappingMappingsReleaseOnlyAfterLastSource() {
        state.update("stick", 80)
        state.update("button:1", 80)
        state.update("button:2", 80)
        state.update("stick")
        state.update("button:1")
        assertEquals(listOf(Key(80, true)), events)
        state.update("button:2")
        assertEquals(Key(80, false), events.last())
    }

    @Test fun interruptionReleasesAllAndDoesNotReplayStaleHolds() {
        state.update("stick", 87, 65)
        state.update("action", 79)
        state.setEnabled(false)
        val released = events.size
        assertEquals(3, events.count { !it.down })
        state.update("stick", 87)
        state.releaseAll()
        state.setEnabled(true)
        assertEquals(released, events.size)
        state.update("fresh", 80)
        assertEquals(Key(80, true), events.last())
    }

    @Test fun modifiersRemainPresentForTheKeyTheyModify() {
        state.update("combination", 0x11, 0x0D)
        state.releaseAll()
        assertEquals(listOf(Key(0x11, true, 2), Key(0x0D, true, 2),
            Key(0x0D, false, 2), Key(0x11, false)), events)
    }

    @Test fun joystickHasDeadZoneAndEightDirections() {
        assertEquals(0, GameInputState.direction(.1f, -.1f))
        assertEquals(0, GameInputState.direction(Float.NaN, 1f))
        val directions = listOf(Triple(-1f, 0f, 1), Triple(1f, 0f, 2),
            Triple(0f, -1f, 4), Triple(0f, 1f, 8), Triple(-1f, -1f, 5),
            Triple(1f, -1f, 6), Triple(-1f, 1f, 9), Triple(1f, 1f, 10))
        directions.forEach { (x, y, expected) -> assertEquals(expected, GameInputState.direction(x, y)) }
        assertEquals(4, GameInputState.direction(.1f, -1f))
    }
}
