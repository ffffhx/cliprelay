package com.limelight.binding.input;

/** Require consecutive foreground observations; errors never mean desktop. */
public final class ApplicationPolicy {
    public static boolean usesPhoneScrollCompatibility(String app, boolean gameMode) {
        return !gameMode && "chatgpt".equals(app);
    }

    public static boolean usesPhonePinchCompatibility(String app, boolean gameMode) {
        return !gameMode && "orca".equals(app);
    }

    private String candidate;
    private long since;
    public String observe(boolean supported, String app, long now) {
        if (!supported || !("general".equals(app) || "orca".equals(app) || "chatgpt".equals(app)
                || "stardew".equals(app) || "plateup".equals(app))) {
            candidate = null;
            return null;
        }
        if (!app.equals(candidate)) { candidate = app; since = now; return null; }
        return now - since >= 500 ? app : null;
    }
}
