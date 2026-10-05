package com.limelight.binding.video;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class VideoStatsTest {
    @Test public void rolloverKeepsOnlyThePreviousAndActiveWindowBytes() {
        VideoStats active = new VideoStats();
        VideoStats previous = new VideoStats();
        active.receivedVideoBytes = 500_000;
        previous.copy(active);
        active.clear();
        assertEquals(0, active.receivedVideoBytes);
        active.receivedVideoBytes = 750_000;
        VideoStats combined = new VideoStats();
        combined.add(previous);
        combined.add(active);
        assertEquals(1_250_000, combined.receivedVideoBytes);
        previous.copy(active);
        active.clear();
        active.receivedVideoBytes = 250_000;
        combined.clear();
        combined.add(previous);
        combined.add(active);
        assertEquals(1_000_000, combined.receivedVideoBytes);
    }
}
