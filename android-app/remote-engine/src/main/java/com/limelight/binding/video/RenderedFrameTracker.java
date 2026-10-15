package com.limelight.binding.video;

import java.util.TreeMap;

/** Links a host frame number to actual MediaCodec presentation, not packet arrival. */
public final class RenderedFrameTracker {
    private static final int LIMIT = 512;
    public static final class Presentation {
        public final long frame, receivedAtMs;
        Presentation(long frame, long receivedAtMs) { this.frame = frame; this.receivedAtMs = receivedAtMs; }
    }
    private final TreeMap<Long, Presentation> pending = new TreeMap<>();
    private Presentation rendered = new Presentation(0, 0);

    public synchronized void queued(long timestampUs, int frameNumber) {
        queued(timestampUs, frameNumber, 0);
    }

    public synchronized void queued(long timestampUs, int frameNumber, long receivedAtMs) {
        if (timestampUs <= 0) return; // codec configuration has no video frame
        pending.put(timestampUs, new Presentation(Integer.toUnsignedLong(frameNumber), Math.max(0, receivedAtMs)));
        while (pending.size() > LIMIT) pending.pollFirstEntry();
    }

    public synchronized void discarded(long timestampUs) { pending.remove(timestampUs); }

    public synchronized void rendered(long timestampUs) {
        Presentation frame = pending.get(timestampUs);
        if (frame == null) return;
        if (frame.frame > rendered.frame) rendered = frame;
        pending.headMap(timestampUs, true).clear();
    }

    public synchronized long lastRendered() { return rendered.frame; }
    public synchronized Presentation presentation() { return rendered; }

    public synchronized void reset() { pending.clear(); rendered = new Presentation(0, 0); }
}
