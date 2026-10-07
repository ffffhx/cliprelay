package com.cliprelay.app

import com.limelight.binding.input.ApplicationPolicy
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

}
