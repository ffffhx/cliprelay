package com.cliprelay.app.data

import org.junit.Assert.assertEquals
import org.junit.Test

class FullscreenTextSizeTest {
    @Test
    fun defaultIsSmallerThanPreviousFullscreenSize() {
        assertEquals(17, FullscreenTextSize.DEFAULT_SP)
        assertEquals(26, FullscreenTextSize.lineHeight(FullscreenTextSize.DEFAULT_SP))
    }

    @Test
    fun valuesAreClampedAndSnappedToOddSteps() {
        assertEquals(13, FullscreenTextSize.normalize(5))
        assertEquals(19, FullscreenTextSize.normalize(18))
        assertEquals(19, FullscreenTextSize.normalize(19))
        assertEquals(29, FullscreenTextSize.normalize(40))
    }

    @Test
    fun steppingStopsAtReadableBounds() {
        assertEquals(13, FullscreenTextSize.decrease(13))
        assertEquals(15, FullscreenTextSize.decrease(17))
        assertEquals(19, FullscreenTextSize.increase(17))
        assertEquals(29, FullscreenTextSize.increase(29))
    }
}
