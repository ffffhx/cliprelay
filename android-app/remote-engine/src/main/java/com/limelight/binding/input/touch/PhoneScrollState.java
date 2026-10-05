package com.limelight.binding.input.touch;

/** Mouse-wheel fallback for desktop apps without native touch scrolling. */
public final class PhoneScrollState {
    public interface Sink {
        void position(float x, float y);
        void scroll(short vertical, short horizontal);
        void click(boolean right);
    }
    private final Sink sink;
    private final float slop, unitsPerPixel;
    private boolean active, scrolling, longPressed;
    private float downX, downY, lastX, lastY, remainder;
    private boolean vertical;
    public PhoneScrollState(Sink sink, float slop, float density) {
        this.sink = sink; this.slop = slop;
        // One Windows wheel notch (120) for 48dp of finger travel.
        unitsPerPixel = 120f / (48f * density);
    }
    public void down(float x, float y) {
        cancel(); active = true; downX = lastX = x; downY = lastY = y;
    }
    public void move(float x, float y) {
        if (!active || longPressed) return;
        if (!scrolling) {
            if (Math.hypot(x - downX, y - downY) <= slop) return;
            scrolling = true; vertical = Math.abs(y - downY) >= Math.abs(x - downX);
            sink.position(downX, downY);
        }
        float delta = vertical ? y - lastY : lastX - x;
        remainder += delta * unitsPerPixel;
        int units = Math.max(-32767, Math.min(32767, Math.round(remainder)));
        remainder -= units;
        if (units != 0) sink.scroll((short)(vertical ? units : 0), (short)(vertical ? 0 : units));
        lastX = x; lastY = y;
    }
    public void longPress() {
        if (!active || scrolling || longPressed) return;
        longPressed = true; sink.position(downX, downY); sink.click(true);
    }
    public boolean up(float x, float y) {
        if (!active) return false;
        move(x, y);
        boolean tap = !scrolling && !longPressed;
        if (tap) { sink.position(downX, downY); sink.click(false); }
        cancel(); return tap;
    }
    public void cancel() { active = scrolling = longPressed = false; remainder = 0; }
}
