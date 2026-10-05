package com.limelight.nvstream;

/** Content-aware probing of the real video stream, without synthetic speed-test traffic.
 * Rates include transport overhead, just like the bitrate preference.
 * All methods are called on the UI thread. This class has no Android dependencies. */
public final class AdaptiveBitrateController {
    public static final long WARMUP_MS = 10_000;
    public static final long LOWER_INTERVAL_MS = 30_000;
    public static final long RECOVERY_MS = 180_000;
    private final int ceilingKbps;
    private final int floorKbps;
    private int bitrateKbps;
    private long connectedAt;
    private long lastChangeAt = -LOWER_INTERVAL_MS;
    private long lastSampleAt = -1;
    private long poorMs, severeMs, healthyMs, queuedMs;
    private int baselineRttMs = -1;
    private int previousProbeKbps;
    private long increaseAllowedAt;
    private long recoveryBackoffMs = 600_000;

    /** Immutable sample published by the video receive thread, independent of the stats overlay. */
    public static final class Sample {
        public final long atMs, durationMs;
        public final int totalFrames, lostFrames, rttMs;
        public final long receivedVideoBytes;
        public Sample(long atMs, long durationMs, int totalFrames, int lostFrames, int rttMs,
                      long receivedVideoBytes) {
            this.atMs = atMs;
            this.durationMs = durationMs;
            this.totalFrames = totalFrames;
            this.lostFrames = lostFrames;
            this.rttMs = rttMs;
            this.receivedVideoBytes = receivedVideoBytes;
        }
    }

    public AdaptiveBitrateController(int initialKbps, int ceilingKbps) {
        this.ceilingKbps = Math.max(500, Math.min(150_000, ceilingKbps));
        floorKbps = Math.min(1_000, Math.min(this.ceilingKbps, Math.max(500, initialKbps)));
        bitrateKbps = Math.max(floorKbps, Math.min(initialKbps, this.ceilingKbps));
    }

    public int getBitrateKbps() { return bitrateKbps; }
    public int getCeilingKbps() { return ceilingKbps; }
    public int getFloorKbps() { return floorKbps; }

    public void onConnected(long nowMs) {
        connectedAt = nowMs;
        lastSampleAt = -1;
        resetObservation();
    }

    /** A dialog, backgrounding, stale sample, or silence is not proof of a healthy network. */
    public void resetObservation() {
        poorMs = severeMs = healthyMs = queuedMs = 0;
    }

    /** Returns a new session bitrate, or zero when no reconnect should occur. */
    public int observe(Sample sample, long nowMs) {
        if (sample == null || sample.atMs > nowMs || nowMs - sample.atMs > 2_500 ||
                sample.durationMs < 500 || sample.durationMs > 2_500 ||
                sample.totalFrames < 10 || sample.lostFrames < 0 ||
                sample.lostFrames > sample.totalFrames || sample.receivedVideoBytes < 0) {
            resetObservation();
            return 0;
        }
        if (sample.atMs <= lastSampleAt) return 0;
        if (lastSampleAt >= 0 && sample.atMs - lastSampleAt > 2_500) resetObservation();
        lastSampleAt = sample.atMs;
        if (sample.rttMs >= 0 && (baselineRttMs < 0 || sample.rttMs < baselineRttMs)) {
            baselineRttMs = sample.rttMs;
        }
        if (nowMs - connectedAt < WARMUP_MS) {
            resetObservation();
            return 0;
        }
        double loss = (double) sample.lostFrames / sample.totalFrames;
        long duration = Math.min(1_500, sample.durationMs);
        poorMs = loss >= 0.03 ? poorMs + duration : 0;
        severeMs = loss >= 0.15 ? severeMs + duration : 0;
        // Payload bytes exclude FEC/transport overhead. Only sustained use of
        // the current budget justifies probing higher: a static 0.4 Mbps desktop
        // is application-limited, not evidence that a faster network is available.
        double receivedKbps = sample.receivedVideoBytes * 8.0 / sample.durationMs;
        boolean loaded = receivedKbps >= bitrateKbps * 0.55;
        boolean healthyRtt = sample.rttMs >= 0 &&
                sample.rttMs <= baselineRttMs + Math.max(20, baselineRttMs / 4);
        healthyMs = loaded && loss <= 0.003 && healthyRtt ? healthyMs + duration : 0;
        // High absolute RTT alone isn't congestion. A sustained increase from
        // this route's baseline while video is flowing can indicate queueing.
        boolean queued = loaded && baselineRttMs >= 0 &&
                sample.rttMs > baselineRttMs + Math.max(50, baselineRttMs / 2);
        queuedMs = queued ? queuedMs + duration : 0;

        if (bitrateKbps > floorKbps && nowMs - lastChangeAt >= LOWER_INTERVAL_MS &&
                (poorMs >= 3_000 || severeMs >= 2_000 || queuedMs >= 5_000)) {
            int target = (int) (bitrateKbps * (severeMs >= 2_000 ? 0.60 : 0.75)) / 500 * 500;
            if (previousProbeKbps > 0) {
                target = Math.min(target, previousProbeKbps);
                increaseAllowedAt = nowMs + recoveryBackoffMs;
                recoveryBackoffMs = Math.min(1_800_000, recoveryBackoffMs * 2);
            }
            previousProbeKbps = 0;
            return change(Math.max(floorKbps, target), nowMs);
        }
        // Validate a probe under real load, never just because time has passed
        // while the user is reading a static page.
        if (previousProbeKbps > 0 && healthyMs >= 15_000) previousProbeKbps = 0;
        if (previousProbeKbps == 0 && bitrateKbps < ceilingKbps && healthyMs >= RECOVERY_MS &&
                nowMs >= increaseAllowedAt && nowMs - lastChangeAt >= RECOVERY_MS) {
            previousProbeKbps = bitrateKbps;
            int step = Math.max(500, (bitrateKbps / 10) / 500 * 500);
            return change(Math.min(ceilingKbps, bitrateKbps + step), nowMs);
        }
        return 0;
    }

    private int change(int target, long nowMs) {
        bitrateKbps = target;
        lastChangeAt = nowMs;
        resetObservation();
        return target;
    }
}
