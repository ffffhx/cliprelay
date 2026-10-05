package com.cliprelay.app

import com.limelight.binding.video.StreamStatistics
import org.junit.Assert.*
import org.junit.Test

class StreamStatisticsTest {
    private fun sample(elapsed: Long = 2_000, bytes: Long = 1_500_000) =
        StreamStatistics(10_000, elapsed, 1920, 1080, "HEVC", bytes, 118, 116, 120, 2, 35)

    @Test fun measuresBitsPerSecondAndDistinctReceiveRenderFrameRates() {
        val s = sample()
        assertEquals(6.0, s.videoMbps, 0.0001)
        assertEquals(59.0, s.receivedFps, 0.0001)
        assertEquals(58.0, s.renderedFps, 0.0001)
        assertEquals(100.0 / 60, s.lossPercent, 0.0001)
    }

    @Test fun delayedWindowUsesElapsedTimeInsteadOfAssumingOneSecond() {
        val s = sample(4_000)
        assertEquals(3.0, s.videoMbps, 0.0001)
        assertEquals(29.5, s.receivedFps, 0.0001)
    }

    @Test fun emptyWindowHasNoInfiniteOrNaNValues() {
        val s = StreamStatistics(10_000, 0, 1920, 1080, "HEVC", 0, 0, 0, 0, 0, 0)
        assertEquals(0.0, s.videoMbps, 0.0)
        assertEquals(0.0, s.receivedFps, 0.0)
        assertEquals(0.0, s.renderedFps, 0.0)
        assertEquals(0.0, s.lossPercent, 0.0)
    }

    @Test fun stalledOrOutOfOrderSamplesAreNotPresentedAsLive() {
        val s = sample()
        assertTrue(s.isFresh(10_000))
        assertTrue(s.isFresh(12_999))
        assertFalse(s.isFresh(13_000))
        assertFalse(s.isFresh(9_999))
    }

    @Test fun byteCountersDoNotOverflowAtIntegerLimit() {
        assertEquals(24_000.0, sample(1_000, 3_000_000_000).videoMbps, 0.0001)
    }
}
