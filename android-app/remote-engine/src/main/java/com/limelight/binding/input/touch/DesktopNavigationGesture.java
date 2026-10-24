package com.limelight.binding.input.touch;

/** Three fingers change desktops; four change displays. Coordinates are in dp. */
public final class DesktopNavigationGesture {
    public static final int NONE = 0, DESKTOP_PREVIOUS = 1, DESKTOP_NEXT = 2,
            DISPLAY_PREVIOUS = 3, DISPLAY_NEXT = 4, KEYBOARD_TAP = 5;
    private static final long JOIN_MS = 300, SWIPE_MS = 1500, TAP_MS = 300;
    private static final float DISTANCE = 64, SLOP = 16;
    private final int[] ids = new int[4];
    private final float[] startX = new float[4], startY = new float[4];
    private boolean started, claimed, invalid, lifting;
    private int fingers, pending;
    private long downAt, claimedAt;
    private float firstX, firstY, maxMovement;

    public void begin(float x, float y, long time) {
        started = true; claimed = invalid = lifting = false;
        fingers = pending = 0; maxMovement = 0;
        downAt = time; firstX = x; firstY = y;
    }

    public boolean isClaimed() { return claimed; }

    /** Once claimed, cancellation still consumes remaining contacts until the next DOWN. */
    public void cancel() { invalid = true; pending = NONE; }

    public void add(int[] pointerIds, float[] x, float[] y, long time) {
        if (!started) return;
        int count = pointerIds.length;
        if (count < 3) return;
        if (!claimed) { claimed = true; claimedAt = time; }
        if (count > 4 || lifting || time - downAt > JOIN_MS) { cancel(); return; }
        fingers = count; maxMovement = 0;
        for (int i = 0; i < count; i++) {
            ids[i] = pointerIds[i]; startX[i] = x[i]; startY[i] = y[i];
        }
    }

    public void move(int[] pointerIds, float[] x, float[] y, long time) {
        if (!started || invalid || lifting) return;
        if (!claimed) {
            // A third finger added to an established drag/scroll must not navigate.
            if (Math.hypot(x[0] - firstX, y[0] - firstY) > SLOP) invalid = true;
            return;
        }
        if (time - downAt > SWIPE_MS || pointerIds.length != fingers) { cancel(); return; }
        float min = Float.MAX_VALUE, max = -Float.MAX_VALUE, vertical = 0;
        for (int i = 0; i < fingers; i++) {
            int index = -1;
            for (int j = 0; j < pointerIds.length; j++) if (pointerIds[j] == ids[i]) index = j;
            if (index < 0) { cancel(); return; }
            float dx = x[index] - startX[i], dy = y[index] - startY[i];
            if (!Float.isFinite(dx) || !Float.isFinite(dy)) { cancel(); return; }
            min = Math.min(min, dx); max = Math.max(max, dx);
            vertical = Math.max(vertical, Math.abs(dy));
            maxMovement = Math.max(maxMovement, (float)Math.hypot(dx, dy));
        }
        pending = NONE;
        if (vertical > DISTANCE) { cancel(); return; }
        boolean left = max <= -DISTANCE && -max >= vertical * 1.5f;
        boolean right = min >= DISTANCE && min >= vertical * 1.5f;
        if (left) pending = fingers == 3 ? DESKTOP_NEXT : DISPLAY_NEXT;
        if (right) pending = fingers == 3 ? DESKTOP_PREVIOUS : DISPLAY_PREVIOUS;
    }

    public int up(int[] pointerIds, float[] x, float[] y, long time, boolean last) {
        if (!started) return NONE;
        if (!lifting) {
            move(pointerIds, x, y, time);
            lifting = true; // Freeze the complete group before Android removes any IDs.
            if (!invalid && fingers == 3 && pending == NONE && maxMovement <= SLOP
                    && time - claimedAt < TAP_MS) pending = KEYBOARD_TAP;
        }
        if (!last) return NONE;
        int result = claimed && !invalid && time - downAt <= SWIPE_MS ? pending : NONE;
        if (result == KEYBOARD_TAP && time - claimedAt >= TAP_MS) result = NONE;
        started = claimed = false; pending = NONE;
        return result;
    }
}
