package com.limelight.binding.input.touch;

/** Orca's two-finger gestures: classify once, then emit zoom steps or wheel scrolling. */
public final class PhonePinchState {
    public interface Sink {
        void position(float x, float y);
        void scroll(short vertical, short horizontal);
        void zoom(boolean in);
    }

    private static final double ZOOM_STEP = Math.log(1.12);
    private final Sink sink;
    private final float slop, unitsPerPixel;
    private boolean active, zooming, scrolling, vertical;
    private float startX, startY, lastX, lastY, startSpan, lastSpan, wheelRemainder;
    private double zoomRemainder;

    public PhonePinchState(Sink sink, float slop, float density) {
        this.sink = sink;
        this.slop = slop;
        unitsPerPixel = 120f / (48f * density);
    }

    public void begin(float x1, float y1, float x2, float y2) {
        cancel();
        if (!valid(x1, y1, x2, y2)) return;
        startSpan = lastSpan = (float)Math.hypot(x2 - x1, y2 - y1);
        if (startSpan <= slop * 2) return;
        startX = lastX = (x1 + x2) / 2;
        startY = lastY = (y1 + y2) / 2;
        active = true;
    }

    public void move(float x1, float y1, float x2, float y2) {
        if (!valid(x1, y1, x2, y2)) { cancel(); return; }
        if (!active) return;
        float x = (x1 + x2) / 2, y = (y1 + y2) / 2;
        float span = (float)Math.hypot(x2 - x1, y2 - y1);
        // Crossing fingers is not a request for an unbounded zoom-out.
        if (span <= slop) { cancel(); return; }
        if (!zooming && !scrolling) {
            float spanChange = Math.abs(span - startSpan);
            double pan = Math.hypot(x - startX, y - startY);
            if (spanChange > Math.max(2 * slop, startSpan * .08f) && spanChange > pan * 1.5) {
                zooming = true;
            } else if (pan > slop * 2 && pan > spanChange * .75) {
                scrolling = true;
                vertical = Math.abs(y - startY) >= Math.abs(x - startX);
            } else return;
        }
        if (zooming) {
            zoomRemainder += Math.log(span / lastSpan);
            int steps = (int)(zoomRemainder / ZOOM_STEP);
            // Bound a dropped/coalesced frame, and discard excess rather than replaying it later.
            int bounded = Math.max(-3, Math.min(3, steps));
            zoomRemainder -= steps * ZOOM_STEP;
            for (int i = 0; i < Math.abs(bounded); i++) sink.zoom(bounded > 0);
        } else {
            wheelRemainder += (vertical ? y - lastY : lastX - x) * unitsPerPixel;
            int units = (int)Math.max(-32767, Math.min(32767, wheelRemainder));
            wheelRemainder -= units;
            if (units != 0) {
                sink.position(startX, startY);
                sink.scroll((short)(vertical ? units : 0), (short)(vertical ? 0 : units));
            }
        }
        lastX = x; lastY = y; lastSpan = span;
    }

    private boolean valid(float x1, float y1, float x2, float y2) {
        return Float.isFinite(x1) && Float.isFinite(y1) && Float.isFinite(x2) && Float.isFinite(y2);
    }

    public void cancel() {
        active = zooming = scrolling = false;
        zoomRemainder = wheelRemainder = 0;
    }
}
