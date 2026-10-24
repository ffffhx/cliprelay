package com.limelight.ui;

/** Host shortcuts, deliberately refusing to guess the OS of an unknown host. */
public final class DesktopShortcut {
    private DesktopShortcut() {}
    public static int[] keys(String platform, int direction) {
        if (direction != -1 && direction != 1) return new int[0];
        int arrow = direction < 0 ? 0x25 : 0x27;
        if ("windows".equals(platform)) return new int[]{0x11, 0x5B, arrow};
        if ("macos".equals(platform)) return new int[]{0x11, arrow};
        return new int[0];
    }
}
