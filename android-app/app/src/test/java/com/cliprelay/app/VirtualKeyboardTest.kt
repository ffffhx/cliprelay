package com.cliprelay.app

import com.limelight.ui.VirtualKeyboardState
import org.junit.Assert.*
import org.junit.Test

class VirtualKeyboardTest {
    private data class Event(val key: Int, val down: Boolean, val modifiers: Int)
    private val events = mutableListOf<Event>()
    private val held = mutableSetOf<Int>()
    private val keyboard = VirtualKeyboardState { key, down, modifiers ->
        if (down) assertTrue(held.add(key)) else assertTrue(held.remove(key))
        events += Event(key, down, modifiers)
    }.apply { setEnabled(true) }

    @Test fun controlIsLocalUntilNextKeyAndReleasesAfterChord() {
        keyboard.press(0x11)
        assertTrue(keyboard.isSelected(0x11))
        assertTrue(events.isEmpty())
        keyboard.press(67)
        assertEquals(listOf(Event(17,true,2), Event(67,true,2),
            Event(67,false,2), Event(17,false,0)), events)
        assertFalse(keyboard.isSelected(17)); assertTrue(held.isEmpty())
        keyboard.press(86)
        assertEquals(listOf(Event(86,true,0), Event(86,false,0)), events.takeLast(2))
    }

    @Test fun multipleModifiersAndWindowsKeyPrecedeOrdinaryKeys() {
        keyboard.press(0x11); keyboard.press(0x10); keyboard.press(0x1B)
        assertEquals(Event(0x1B, true, 3), events[2])
        assertTrue(held.isEmpty())
        events.clear()
        keyboard.press(0x5B); keyboard.press(68)
        assertEquals(listOf(Event(0x5B,true,8), Event(68,true,8),
            Event(68,false,8), Event(0x5B,false,0)), events)
    }

    @Test fun deselectionAndInterruptionDiscardPendingModifiersAndDisabledInput() {
        keyboard.press(0x11); keyboard.press(0x11); keyboard.press(65)
        assertEquals(listOf(Event(65,true,0), Event(65,false,0)), events)
        events.clear()
        keyboard.press(0x12); keyboard.setEnabled(false); keyboard.press(0x73)
        assertTrue(events.isEmpty()); assertFalse(keyboard.isSelected(0x12))
        keyboard.setEnabled(true); keyboard.press(0x73)
        assertEquals(listOf(Event(0x73,true,0), Event(0x73,false,0)), events)
    }

    @Test fun modifierAloneDoesNotRetainAKeyOrAnEarlierCombination() {
        keyboard.press(0x11); keyboard.pressAlone(0x5B)
        assertEquals(listOf(Event(0x5B,true,8), Event(0x5B,false,0)), events)
        assertFalse(keyboard.isSelected(0x11)); assertTrue(held.isEmpty())
    }
}
