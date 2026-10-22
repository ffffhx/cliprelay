package com.cliprelay.app

import com.limelight.ui.FloatingKeyboardGeometry as Geometry
import org.junit.Assert.*
import org.junit.Test

class FloatingKeyboardGeometryTest {
    @Test fun realmeLandscapeLeavesDesktopVisibleAndKeepsKeysUsable() {
        val panel = requireNotNull(Geometry.fit(112, 0, 2772, 1184, 3.5f, false))
        assertTrue(panel.width < 2772 * .67f)
        assertTrue(panel.height < 1184 * .55f)
        assertTrue(panel.width >= 320 * 3.5f)
        assertTrue(panel.height >= 180 * 3.5f)
    }

    @Test fun tabletUsesHalfWidthAndAboutThirtyPercentHeight() {
        val panel = requireNotNull(Geometry.fit(0, 0, 2944, 1840, 2.125f, true))
        assertEquals(2944 * .5f, panel.width.toFloat(), 25f)
        assertEquals(1840 * .3f, panel.height.toFloat(), 25f)
    }

    @Test fun dragClampsAtEveryEdgeAndPositionSurvivesRotationAndInsets() {
        val landscape = requireNotNull(Geometry.fit(112, 0, 2772, 1184, 3.5f, false))
        val x = landscape.movedX(1f, -300f)
        val y = landscape.movedY(1f, -200f)
        assertEquals(landscape.x(1f) - 300f, landscape.x(x), .01f)
        assertEquals(landscape.y(1f) - 200f, landscape.y(y), .01f)
        for ((w, h) in listOf(2772 to 1184, 1240 to 2600, 1240 to 1000, 480 to 260)) {
            val panel = requireNotNull(Geometry.fit(40, 30, w - 50, h - 40, 3.5f, false))
            assertInside(panel, x, y)
            assertEquals(panel.left.toFloat(), panel.x(panel.movedX(x, -10000f)), .01f)
            assertEquals((panel.right - panel.width).toFloat(), panel.x(panel.movedX(x, 10000f)), .01f)
            assertEquals(panel.top.toFloat(), panel.y(panel.movedY(y, -10000f)), .01f)
            assertEquals((panel.bottom - panel.height).toFloat(), panel.y(panel.movedY(y, 10000f)), .01f)
        }
    }

    @Test fun smallWindowsAndInvalidSavedPositionsNeverPutPanelOffscreen() {
        for (tablet in listOf(false, true)) for (density in listOf(1f, 2.125f, 3.5f)) {
            for ((w, h) in listOf(1 to 1, 320 to 160, 1080 to 2400, 2400 to 1080, 2944 to 1840)) {
                val panel = requireNotNull(Geometry.fit(0, 0, w, h, density, tablet))
                for (fraction in listOf(-4f, 0f, .35f, 1f, 4f, Float.NaN, Float.POSITIVE_INFINITY)) {
                    assertInside(panel, fraction, fraction)
                    assertInside(panel, panel.movedX(fraction, 200f), panel.movedY(fraction, -200f))
                }
            }
        }
        assertNull(Geometry.fit(0, 0, 0, 100, 1f, false))
        assertNull(Geometry.fit(0, 0, 100, 0, 1f, false))
        assertNull(Geometry.fit(0, 0, 100, 100, Float.NaN, false))
    }

    private fun assertInside(panel: Geometry, x: Float, y: Float) {
        assertTrue(panel.width > 0 && panel.height > 0)
        assertTrue(panel.x(x) >= panel.left && panel.x(x) + panel.width <= panel.right + .01f)
        assertTrue(panel.y(y) >= panel.top && panel.y(y) + panel.height <= panel.bottom + .01f)
    }
}
