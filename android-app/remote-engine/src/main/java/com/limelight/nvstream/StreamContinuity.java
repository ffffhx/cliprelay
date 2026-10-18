package com.limelight.nvstream;

/** Main-thread policy driven by actual receive/presentation times, never UI ticks. */
public final class StreamContinuity {
    public enum Action { FLOWING, WAITING, PAUSED, RECONNECT }
    public static final long FRESH_MS = 1000, STALL_MS = 2000, RECOVERY_WAIT_MS = 6000;
    private boolean active, paused, routePending, reconnectIssued;
    private long activatedAt, lastFrame, lastReceivedAt, changedAt, changedFrame, pausedAt, pausedFrame;

    public void activate(long now, long frame) {
        active = true;
        activatedAt = now; lastFrame = frame; lastReceivedAt = 0;
        reconnectIssued = false;
        if (paused) { pausedAt = now; pausedFrame = frame; }
    }

    public void suspend() { active = false; }
    public boolean routePending() { return routePending; }
    public boolean inputPaused() { return paused; }
    public long pausedAt() { return pausedAt; }

    public void networkChanged(long now, long frame, boolean available) {
        routePending = true; changedAt = now; changedFrame = frame;
        if (active && !available) pause(now, frame);
    }

    private void pause(long now, long frame) {
        if (paused) return;
        paused = true; pausedAt = now; pausedFrame = frame;
        if (!routePending) { routePending = true; changedAt = now; changedFrame = frame; }
    }

    public Action observe(long now, long frame, long receivedAt, boolean captureConfirmed) {
        if (!active) return paused ? Action.PAUSED : Action.WAITING;
        // Delayed presentation callbacks for buffered pre-handover frames do
        // not prove recovery. Only a newly received, actually presented frame does.
        if (frame > lastFrame && receivedAt >= activatedAt && receivedAt <= now) {
            lastFrame = frame;
            lastReceivedAt = Math.max(lastReceivedAt, receivedAt);
        }
        boolean fresh = lastReceivedAt > 0 && now >= lastReceivedAt && now - lastReceivedAt <= FRESH_MS;
        if (routePending && fresh && lastFrame > changedFrame && lastReceivedAt >= changedAt) routePending = false;
        if (now - Math.max(activatedAt, lastReceivedAt) >= STALL_MS) pause(now, frame);
        if (paused && fresh && lastFrame > pausedFrame && lastReceivedAt >= pausedAt && captureConfirmed) {
            paused = false;
            reconnectIssued = false;
        }
        if (paused && now - pausedAt >= RECOVERY_WAIT_MS && !reconnectIssued) {
            reconnectIssued = true;
            return Action.RECONNECT;
        }
        return paused ? Action.PAUSED : fresh ? Action.FLOWING : Action.WAITING;
    }

    /** Retained across Activity recreation, without keeping an Activity/connection. */
    public static final class RecoveryBudget {
        private long firstAttempt;
        private int attempts;
        public boolean take(long now) {
            if (attempts == 0 || now - firstAttempt >= 60000 || now < firstAttempt) {
                firstAttempt = now; attempts = 0;
            }
            if (attempts >= 2) return false;
            attempts++;
            return true;
        }
        public void reset() { attempts = 0; }
    }
}
