package com.limelight.ui;

/** Coordinates relative to the stream's parent; never reserves space inside the video. */
public final class DesktopRailGeometry {
    public static final class Layout {
        public final int left, right, top, width, height;
        private Layout(int left, int right, int top, int width, int height) {
            this.left = left; this.right = right; this.top = top;
            this.width = width; this.height = height;
        }
    }

    private DesktopRailGeometry() {}

    public static final class BottomLayout {
        public final int left, top, width, height;
        private BottomLayout(int left, int top, int width, int height) {
            this.left = left; this.top = top; this.width = width; this.height = height;
        }
    }

    public static BottomLayout fitBottom(int width, int height, int videoBottom,
                                         int safeLeft, int safeTop, int safeRight, int safeBottom, float density) {
        if (width <= 0 || height <= 0 || videoBottom <= 0 || videoBottom > height ||
                !Float.isFinite(density) || density <= 0) return null;
        int left = Math.max(0, safeLeft), right = Math.min(width, safeRight);
        int bottom = Math.min(height, safeBottom);
        // Allow a compact 40–44dp row: 16:10 tablets can miss 44dp by a few pixels.
        int barHeight = Math.min(Math.round(44 * density), bottom - Math.max(videoBottom, safeTop));
        if (right - left < Math.round(48 * density) || barHeight < Math.round(40 * density)) return null;
        return new BottomLayout(left, bottom - barHeight, right - left, barHeight);
    }

    public static Layout fit(int width, int height, int videoLeft, int videoRight,
                             int safeLeft, int safeTop, int safeRight, int safeBottom, float density) {
        if (width <= height || height <= 0 || !Float.isFinite(density) || density <= 0 ||
                videoLeft < 0 || videoRight <= videoLeft || videoRight > width) return null;
        safeLeft = Math.max(0, safeLeft);
        safeRight = Math.min(width, safeRight);
        int gap = Math.round(2 * density);
        int top = Math.max(0, safeTop) + Math.round(4 * density);
        int bottom = Math.min(height, safeBottom) - Math.round(4 * density);
        int leftSpace = videoLeft - safeLeft - 2 * gap;
        int rightSpace = safeRight - videoRight - 2 * gap;
        int railWidth = Math.min(Math.round(64 * density), Math.min(leftSpace, rightSpace));
        if (railWidth < Math.round(48 * density) || bottom - top < Math.round(96 * density)) return null;
        return new Layout(safeLeft + gap + (leftSpace - railWidth) / 2,
                videoRight + gap + (rightSpace - railWidth) / 2, top, railWidth, bottom - top);
    }
}
