package com.limelight.binding.input.touch;

/** One selected-modifier tap becomes a mouse click, never a native touch. */
public final class ModifierClickState {
    public interface Sink {
        boolean hasModifiers();
        void click(float x, float y);
    }
    private final Sink sink;
    private final float slopSquared;
    private final long tapTimeout;
    private boolean captured, cancelled;
    private int pointer;
    private float downX, downY;
    private long downTime;

    public ModifierClickState(Sink sink, float slop, long tapTimeout) {
        this.sink = sink;
        slopSquared = slop * slop;
        this.tapTimeout = tapTimeout;
    }
    public boolean down(int id, float x, float y, long time, boolean insideVideo) {
        captured = insideVideo && sink.hasModifiers();
        cancelled = false;
        pointer = id; downX = x; downY = y; downTime = time;
        return captured;
    }
    public boolean isCaptured() { return captured; }
    public void move(int id, float x, float y) {
        float dx = x - downX, dy = y - downY;
        if (id != pointer || dx * dx + dy * dy > slopSquared) cancelled = true;
    }
    // Retain ownership until UP so a cancelled gesture cannot fall through to native input.
    public void cancel() { cancelled = true; }
    public boolean up(int id, float x, float y, long time) {
        if (!captured) return false;
        move(id, x, y);
        captured = false;
        if (!cancelled && time >= downTime && time - downTime < tapTimeout && sink.hasModifiers()) {
            sink.click(downX, downY);
        }
        return true;
    }
}
