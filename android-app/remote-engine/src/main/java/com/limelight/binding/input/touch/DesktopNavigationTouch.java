package com.limelight.binding.input.touch;

import android.view.MotionEvent;
import java.util.function.IntConsumer;

/** Claims only complete finger gestures, leaving one/two fingers and other input tools alone. */
public final class DesktopNavigationTouch {
    private final DesktopNavigationGesture gesture = new DesktopNavigationGesture();
    private final float density;
    private final Runnable claim;
    private final IntConsumer action;
    private boolean enabled;

    public DesktopNavigationTouch(float density, Runnable claim, IntConsumer action) {
        this.density = density; this.claim = claim; this.action = action;
    }

    public void cancel() { gesture.cancel(); }

    public boolean onTouch(MotionEvent event, boolean allowed) {
        int kind = event.getActionMasked();
        if (kind == MotionEvent.ACTION_DOWN) {
            enabled = allowed;
            gesture.begin(event.getX() / density, event.getY() / density, event.getEventTime());
        }
        if (!enabled) return false;
        boolean consumed = gesture.isClaimed();
        if (!allowed || kind == MotionEvent.ACTION_CANCEL || (event.getFlags() & 0x20) != 0) gesture.cancel();
        // FLAG_CANCELED (0x20) also covers a cancelled POINTER_UP on Android 13+.
        int count = event.getPointerCount();
        int[] ids = new int[count]; float[] x = new float[count], y = new float[count];
        for (int i = 0; i < count; i++) {
            ids[i] = event.getPointerId(i); x[i] = event.getX(i) / density; y[i] = event.getY(i) / density;
            if (event.getToolType(i) != MotionEvent.TOOL_TYPE_FINGER) gesture.cancel();
        }
        int result = DesktopNavigationGesture.NONE;
        if (kind == MotionEvent.ACTION_POINTER_DOWN) gesture.add(ids, x, y, event.getEventTime());
        else if (kind == MotionEvent.ACTION_MOVE) {
            for (int h = 0; h < event.getHistorySize(); h++) {
                float[] hx = new float[count], hy = new float[count];
                for (int i = 0; i < count; i++) {
                    hx[i] = event.getHistoricalX(i, h) / density; hy[i] = event.getHistoricalY(i, h) / density;
                }
                gesture.move(ids, hx, hy, event.getHistoricalEventTime(h));
            }
            gesture.move(ids, x, y, event.getEventTime());
        } else if (kind == MotionEvent.ACTION_UP || kind == MotionEvent.ACTION_POINTER_UP) {
            result = gesture.up(ids, x, y, event.getEventTime(), kind == MotionEvent.ACTION_UP);
        }
        if (!consumed && gesture.isClaimed()) { claim.run(); consumed = true; }
        if (result != DesktopNavigationGesture.NONE) action.accept(result);
        return consumed;
    }
}
