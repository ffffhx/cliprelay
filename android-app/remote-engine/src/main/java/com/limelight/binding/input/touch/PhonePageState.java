package com.limelight.binding.input.touch;

/** Orca terminal paging: a one-finger swipe becomes Page Up/Down key taps. */
public final class PhonePageState {
    public interface Sink {
        void position(float x, float y);
        void page(boolean pageDown);
        void click(boolean right);
    }

    /** Orca's sidebar occupies the left edge; anything left of it keeps native touch. */
    public static final float SIDEBAR_FRACTION = .25f;
    // One page per 48dp of finger travel, matching the wheel route's notch spacing.
    private static final float PAGE_TRAVEL_DP = 48f;
    // A fast flick must not flood the host with key down/up pairs.
    private static final long MIN_PAGE_INTERVAL_MS = 70;

    private final Sink sink;
    private final float slop, travelPerPage;
    private boolean active, scrolling, vertical, longPressed;
    private float downX, downY, lastY, travel;
    private long nextPageAt;

    public PhonePageState(Sink sink, float slop, float density) {
        this.sink = sink;
        this.slop = slop;
        travelPerPage = PAGE_TRAVEL_DP * density;
    }

    /** Pure geometry so the sidebar rule stays testable without a View. */
    public static boolean isTerminalArea(float x, float width) {
        return Float.isFinite(x) && Float.isFinite(width) && width > 0 && x > width * SIDEBAR_FRACTION;
    }

    public void down(float x, float y, long time) {
        cancel();
        if (!Float.isFinite(x) || !Float.isFinite(y)) return;
        active = true;
        downX = x;
        downY = lastY = y;
        nextPageAt = time;
    }

    public void move(float x, float y, long time) {
        if (!Float.isFinite(x) || !Float.isFinite(y)) { cancel(); return; }
        if (!active || longPressed) return;
        if (!scrolling) {
            if (Math.hypot(x - downX, y - downY) <= slop) return;
            scrolling = true;
            vertical = Math.abs(y - downY) >= Math.abs(x - downX);
        }
        // Only vertical swipes page; horizontal ones stay inert for the whole gesture.
        if (!vertical) { lastY = y; return; }
        travel += y - lastY;
        int pages = (int)(travel / travelPerPage);
        if (pages != 0) {
            // Converted travel is discarded rather than replayed after a pause.
            travel -= pages * travelPerPage;
            if (time >= nextPageAt) {
                // Finger up (negative delta) asks for newer output: Page Down.
                sink.page(pages < 0);
                nextPageAt = time + MIN_PAGE_INTERVAL_MS;
            }
        }
        lastY = y;
    }

    /** Native multi-touch may start only before a page has been sent. */
    public boolean canStartMultiTouch() { return active && !scrolling && !longPressed; }

    public void longPress() {
        if (!canStartMultiTouch()) return;
        longPressed = true;
        sink.position(downX, downY);
        sink.click(true);
    }

    public boolean up(float x, float y, long time) {
        if (!active) return false;
        move(x, y, time);
        boolean tap = active && !scrolling && !longPressed;
        if (tap) { sink.position(downX, downY); sink.click(false); }
        cancel();
        return tap;
    }

    public void cancel() { active = scrolling = vertical = longPressed = false; travel = 0; }
}
