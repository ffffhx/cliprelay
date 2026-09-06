package com.cliprelay.app.ui

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.unit.IntSize
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageZoomMathTest {
    @Test
    fun horizontalSwipeAtEitherEdgeBelongsToPagerEvenWithVerticalDrift() {
        for (direction in listOf(-1f, 1f)) {
            assertFalse(shouldImageOwnPan(Offset(80f * direction, 12f), Offset(0f, 12f)))
        }
    }

    @Test
    fun horizontalSwipeInsideImageRemainsAnImagePan() {
        assertTrue(shouldImageOwnPan(Offset(-80f, 12f), Offset(-40f, 12f)))
        assertTrue(shouldImageOwnPan(Offset(80f, 12f), Offset(40f, 12f)))
    }

    @Test
    fun verticalDragDoesNotBecomePageSwipe() {
        assertTrue(shouldImageOwnPan(Offset(12f, 80f), Offset(0f, 80f)))
    }

    @Test
    fun fittedImageLeavesHorizontalSwipesToPager() {
        assertFalse(shouldImageOwnPan(Offset(80f, 12f), Offset.Zero))
    }

    @Test
    fun zoomKeepsGestureFocusInPlaceAndAppliesPan() {
        val result = transformImageOffset(
            offset = Offset.Zero,
            scaleRatio = 2f,
            previousCentroid = Offset(250f, 500f),
            panChange = Offset(100f, 0f),
            viewportSize = IntSize(1_000, 1_000),
        )

        assertEquals(350f, result.x, 0.001f)
        assertEquals(0f, result.y, 0.001f)
    }

    @Test
    fun minimumScaleAlwaysCentersImage() {
        val result = clampImageOffset(
            offset = Offset(320f, -210f),
            scale = 1f,
            viewportSize = IntSize(1_000, 1_000),
            imageWidth = 100,
            imageHeight = 200,
        )

        assertEquals(Offset.Zero, result)
    }

    @Test
    fun portraitImageClampsVerticalPanAndStaysCenteredHorizontally() {
        val result = clampImageOffset(
            offset = Offset(250f, -900f),
            scale = 2f,
            viewportSize = IntSize(1_000, 1_000),
            imageWidth = 100,
            imageHeight = 200,
        )

        assertEquals(0f, result.x, 0.001f)
        assertEquals(-500f, result.y, 0.001f)
    }

    @Test
    fun landscapeImageClampsHorizontalPanAndStaysCenteredVertically() {
        val result = clampImageOffset(
            offset = Offset(900f, -250f),
            scale = 2f,
            viewportSize = IntSize(1_000, 1_000),
            imageWidth = 200,
            imageHeight = 100,
        )

        assertEquals(500f, result.x, 0.001f)
        assertEquals(0f, result.y, 0.001f)
    }

    @Test
    fun invalidViewportReturnsCenteredImage() {
        val result = clampImageOffset(
            offset = Offset(100f, 100f),
            scale = 3f,
            viewportSize = IntSize.Zero,
            imageWidth = 200,
            imageHeight = 100,
        )

        assertEquals(Offset.Zero, result)
    }
}
