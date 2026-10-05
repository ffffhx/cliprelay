package com.cliprelay.app

import com.limelight.ui.DesktopInput
import com.limelight.ui.GameBindings
import org.junit.Assert.*
import org.junit.Test

class ApplicationControlsTest {
    private class RecordingSink : DesktopInput.Sink {
        val events = mutableListOf<String>()
        val held = mutableSetOf<Int>()
        override fun send(key: Int, down: Boolean, modifiers: Int) {
            if (down) assertTrue(held.add(key)) else assertTrue(held.remove(key))
            events += "$key:$down:$modifiers"
        }
        override fun text(value: String) { assertTrue(held.isEmpty()); events += "text:$value" }
        override fun rightClick() {}
        override fun scroll(clicks: Byte) {}
    }

    @Test fun multilineFillPreservesUnicodeAndBlankLinesWithoutSubmitting() {
        val sink = RecordingSink()
        DesktopInput(sink).type("你好🙂\r\n\r第二行\n", true, false)
        val newline = listOf("16:true:1", "13:true:1", "13:false:1", "16:false:0")
        assertEquals(listOf("text:你好🙂") + newline + newline + listOf("text:第二行") + newline, sink.events)
        assertTrue(sink.held.isEmpty())
    }

    @Test fun submitOnlyFollowsExplicitNonEmptySend() {
        val sink = RecordingSink()
        val input = DesktopInput(sink)
        input.type("", true, true)
        assertTrue(sink.events.isEmpty())
        input.type("hello", true, true)
        assertEquals(listOf("text:hello", "13:true:0", "13:false:0"), sink.events)
        input.tap(0x11, 'V'.code)
        assertEquals(listOf("17:true:2", "86:true:2", "86:false:2", "17:false:0"), sink.events.takeLast(4))
        assertTrue(sink.held.isEmpty())
    }

    @Test fun gameProfilesKeepLegacyBindingsAndIndependentDefaults() {
        val plateup = GameBindings.Profile.PLATEUP
        val stardew = GameBindings.Profile.STARDEW
        assertEquals("cliprelay_game_controls", GameBindings.preferencesName(plateup))
        assertNotEquals(GameBindings.preferencesName(plateup), GameBindings.preferencesName(stardew))
        assertArrayEquals(intArrayOf(87,83,65,68,80,79,75,13,27), GameBindings.defaults(plateup))
        assertArrayEquals(intArrayOf(87,83,65,68,67,88,69,9,27,70,77), GameBindings.defaults(stardew))
        GameBindings.defaults(stardew)[4] = 32
        assertEquals(67, GameBindings.defaults(stardew)[4])
        assertEquals(plateup, GameBindings.Profile.fromId("obsolete"))
        GameBindings.INVENTORY_KEYS.forEach { assertEquals(it, GameBindings.sanitize(it, -1)) }
    }
}
