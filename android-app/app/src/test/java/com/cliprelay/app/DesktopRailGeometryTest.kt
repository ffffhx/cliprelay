package com.cliprelay.app

import com.limelight.ui.DesktopRailGeometry
import org.junit.Assert.*
import org.junit.Test

class DesktopRailGeometryTest {
    @Test fun phoneLandscapeUsesOnlyExistingBlackBars() {
        // Phone's safe content rectangle with a centered 16:9 stream, at its display density.
        val rails = requireNotNull(DesktopRailGeometry.fit(2548, 1184, 222, 2326, 0, 0, 2548, 1184, 3.5f))
        assertTrue(rails.left >= 0)
        assertTrue(rails.left + rails.width < 222)
        assertTrue(rails.right > 2326)
        assertTrue(rails.right + rails.width <= 2548)
        assertTrue(rails.width >= 48 * 3.5f)
        assertTrue(rails.top >= 0 && rails.top + rails.height <= 1184)
    }

    @Test fun portraitFullScreenAndNarrowBarsKeepTheCompactToolbar() {
        assertNull(DesktopRailGeometry.fit(1080, 2400, 100, 980, 0, 0, 1080, 2400, 3f))
        assertNull(DesktopRailGeometry.fit(2400, 1080, 0, 2400, 0, 0, 2400, 1080, 3f))
        assertNull(DesktopRailGeometry.fit(2400, 1080, 100, 2300, 0, 0, 2400, 1080, 3f))
        assertNull(DesktopRailGeometry.fit(2400, 1080, 400, 2380, 0, 0, 2400, 1080, 3f))
    }

    @Test fun cutoutAndKeyboardStayOutsideButtonHitAreas() {
        val rails = requireNotNull(DesktopRailGeometry.fit(2800, 1240, 360, 2440, 112, 40, 2688, 750, 3.5f))
        assertTrue(rails.left >= 112)
        assertTrue(rails.right + rails.width <= 2688)
        assertTrue(rails.top >= 40)
        assertTrue(rails.top + rails.height <= 750)
        assertNull(DesktopRailGeometry.fit(2800, 1240, 360, 2440, 112, 40, 2688, 150, 3.5f))
    }

    @Test fun layoutsAcrossAspectRatiosNeverOverlapVideoOrUnsafeEdges() {
        for (density in listOf(1f, 2f, 2.75f, 3.5f)) {
            for (width in listOf(1280, 1920, 2400, 2772, 3200)) {
                for (ratio in listOf(4.0/3, 16.0/9, 21.0/9)) {
                    val height = 1080
                    val videoWidth = minOf(width, (height * ratio).toInt())
                    val videoLeft = (width - videoWidth) / 2
                    val videoRight = videoLeft + videoWidth
                    val rails = DesktopRailGeometry.fit(width, height, videoLeft, videoRight,
                        30, 20, width - 60, height - 40, density) ?: continue
                    assertTrue(rails.left >= 30 && rails.left + rails.width <= videoLeft)
                    assertTrue(rails.right >= videoRight && rails.right + rails.width <= width - 60)
                    assertTrue(rails.top >= 20 && rails.top + rails.height <= height - 40)
                    assertTrue(rails.width >= 48 * density)
                }
            }
        }
    }
}
