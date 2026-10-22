package com.limelight.ui;

/** Keyboard dimensions and travel inside the window's safe area, in pixels. */
public final class FloatingKeyboardGeometry {
    public final int width, height, left, top, right, bottom;

    private FloatingKeyboardGeometry(int width, int height, int left, int top, int right, int bottom) {
        this.width = width; this.height = height;
        this.left = left; this.top = top; this.right = right; this.bottom = bottom;
    }

    public static FloatingKeyboardGeometry fit(int left, int top, int right, int bottom,
                                               float density, boolean tablet) {
        if (right <= left || bottom <= top || !Float.isFinite(density) || density <= 0) return null;
        int margin = Math.min(Math.round(8 * density), Math.min(right - left, bottom - top) / 8);
        left += margin; top += margin; right -= margin; bottom -= margin;
        int availableWidth = right - left, availableHeight = bottom - top;
        boolean landscape = availableWidth >= availableHeight;
        float widthFraction = tablet ? .50f : landscape ? .65f : .92f;
        int width = Math.min(availableWidth, Math.max(Math.round((tablet ? 440 : 320) * density),
                Math.min(Math.round((tablet ? 720 : 600) * density), Math.round(availableWidth * widthFraction))));
        // Keep all five key rows usable on short phones; exceptionally small windows scroll.
        int height = Math.min(availableHeight, Math.max(Math.round((tablet ? 224 : 180) * density),
                Math.min(Math.round((tablet ? 300 : 244) * density),
                        Math.round(availableHeight * (tablet ? .30f : .45f)))));
        return new FloatingKeyboardGeometry(width, height, left, top, right, bottom);
    }

    public static float fraction(float value) {
        return Float.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
    }
    public float x(float fraction) { return left + fraction(fraction) * (right - left - width); }
    public float y(float fraction) { return top + fraction(fraction) * (bottom - top - height); }
    public float movedX(float startFraction, float distance) {
        int travel = right - left - width;
        return travel > 0 ? fraction(startFraction + distance / travel) : fraction(startFraction);
    }
    public float movedY(float startFraction, float distance) {
        int travel = bottom - top - height;
        return travel > 0 ? fraction(startFraction + distance / travel) : fraction(startFraction);
    }
}
