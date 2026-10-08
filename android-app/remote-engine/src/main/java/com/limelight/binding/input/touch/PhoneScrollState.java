package com.limelight.binding.input.touch;

/** Single-finger mouse fallback for apps that disable native touch panning. */
public final class PhoneScrollState {
    public interface Sink {
        void position(float x, float y);
        void scroll(short vertical, short horizontal);
        void click(boolean right);
    }

    private final Sink sink;
    private final float slop, unitsPerPixel;
    private boolean active, scrolling, longPressed, vertical;
    private float downX, downY, lastX, lastY, remainder;

    public PhoneScrollState(Sink sink, float slop, float density) {
        this.sink = sink;
        this.slop = slop;
        // One Windows wheel notch (120) per 48dp of finger travel.
        unitsPerPixel = 120f / (48f * density);
    }

    public void down(float x, float y) {
        cancel();
        if (!Float.isFinite(x) || !Float.isFinite(y)) return;
        active = true;
        downX = lastX = x;
        downY = lastY = y;
    }

    public void move(float x, float y) {
        if (!Float.isFinite(x) || !Float.isFinite(y)) { cancel(); return; }
        if (!active || longPressed) return;
        if (!scrolling) {
            if (Math.hypot(x - downX, y - downY) <= slop) return;
            scrolling = true;
            vertical = Math.abs(y - downY) >= Math.abs(x - downX);
        }
        // Lock the axis and target at the start, even when a swipe leaves the sidebar.
        remainder += (vertical ? y - lastY : lastX - x) * unitsPerPixel;
        int units = (int)Math.max(-32767, Math.min(32767, remainder));
        remainder -= units;
        if (units != 0) {
            sink.position(downX, downY);
            sink.scroll((short)(vertical ? units : 0), (short)(vertical ? 0 : units));
        }
        lastX = x;
        lastY = y;
    }

    /** Native multi-touch may start only before a mouse gesture has been committed. */
    public boolean canStartMultiTouch() { return active && !scrolling && !longPressed; }

    public void longPress() {
        if (!canStartMultiTouch()) return;
        longPressed = true;
        sink.position(downX, downY);
        sink.click(true);
    }

    public boolean up(float x, float y) {
        if (!active) return false;
        move(x, y);
        boolean tap = active && !scrolling && !longPressed;
        if (tap) { sink.position(downX, downY); sink.click(false); }
        cancel();
        return tap;
    }

    public void cancel() { active = scrolling = longPressed = false; remainder = 0; }
}
