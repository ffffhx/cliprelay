package com.cliprelay.app

import com.limelight.binding.input.AutoKeyboardPolicy
import org.junit.Assert.assertEquals
import org.junit.Test

class AutoKeyboardPolicyTest {
    @Test fun opensOnceAfterStableEditFocus() {
        val policy = AutoKeyboardPolicy()
        assertEquals(0, policy.observe(true, true, true, "input-a", 180))
        assertEquals(0, policy.observe(true, true, true, "input-a", 230))
        assertEquals(1, policy.observe(true, true, true, "input-a", 360))
        // The same tap cannot reopen a keyboard dismissed with Back.
        assertEquals(0, policy.observe(true, true, true, "input-a", 700))
    }

    @Test fun delayedFocusAndUnknownResponsesDoNotMisfire() {
        val policy = AutoKeyboardPolicy()
        assertEquals(0, policy.observe(true, true, false, "", 180))
        assertEquals(0, policy.observe(true, true, false, "", 350))
        assertEquals(0, policy.observe(true, true, true, "input-a", 500))
        assertEquals(0, policy.observe(false, true, false, "", 700))
        assertEquals(0, policy.observe(true, true, true, "input-a", 850))
        assertEquals(1, policy.observe(true, true, true, "input-a", 1050))
    }

    @Test fun buttonsAndReadonlyAreasHideOnlyAfterSettling() {
        val policy = AutoKeyboardPolicy()
        assertEquals(0, policy.observe(true, true, false, "", 180))
        assertEquals(0, policy.observe(true, true, false, "", 500))
        assertEquals(2, policy.observe(true, true, false, "", 700))
        assertEquals(0, policy.observe(true, true, false, "", 900))
    }

    @Test fun changingOrMissingFocusIdentityDoesNotShowKeyboard() {
        val policy = AutoKeyboardPolicy()
        assertEquals(0, policy.observe(true, true, true, "", 180))
        assertEquals(0, policy.observe(true, true, true, "a", 300))
        assertEquals(0, policy.observe(true, true, true, "b", 450))
        assertEquals(1, policy.observe(true, true, true, "b", 620))
    }

    @Test fun legacyFocusWithoutHitTestNeverOpensKeyboard() {
        val policy = AutoKeyboardPolicy()
        for (time in listOf(180L, 400L, 700L, 1100L, 2000L)) {
            assertEquals(0, policy.observe(true, false, true, "sticky-input", time))
        }
    }

    @Test fun clickOutsideFocusedEditorHidesAndFreshTapCanReopenSameEditor() {
        val outside = AutoKeyboardPolicy()
        assertEquals(0, outside.observe(true, true, false, "", 180))
        assertEquals(2, outside.observe(true, true, false, "", 700))
        val inside = AutoKeyboardPolicy()
        assertEquals(0, inside.observe(true, true, true, "same-input", 180))
        assertEquals(1, inside.observe(true, true, true, "same-input", 360))
    }
}
