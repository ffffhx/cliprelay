package com.limelight.binding.video;

/** Immutable, published once per sampling window. Rates describe video payload only. */
public final class StreamStatistics {
    public final long timestampMs;
    public final int width, height, rttMs;
    public final String codec;
    public final double videoMbps, receivedFps, renderedFps, lossPercent;

    public StreamStatistics(long nowMs, long elapsedMs, int width, int height, String codec,
                            long receivedBytes, int receivedFrames, int renderedFrames,
                            int totalFrames, int lostFrames, int rttMs) {
        timestampMs = nowMs;
        this.width = width;
        this.height = height;
        this.codec = codec;
        this.rttMs = rttMs;
        videoMbps = elapsedMs > 0 ? receivedBytes * 8.0 / (elapsedMs * 1000.0) : 0;
        receivedFps = elapsedMs > 0 ? receivedFrames * 1000.0 / elapsedMs : 0;
        renderedFps = elapsedMs > 0 ? renderedFrames * 1000.0 / elapsedMs : 0;
        lossPercent = totalFrames > 0 ? lostFrames * 100.0 / totalFrames : 0;
    }

    public boolean isFresh(long nowMs) {
        return nowMs >= timestampMs && nowMs - timestampMs < 3000;
    }
}
