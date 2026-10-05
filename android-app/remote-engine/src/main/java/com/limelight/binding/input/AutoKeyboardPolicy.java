package com.limelight.binding.input;

/** One decision per tap; never reopens an IME after the user dismisses it. */
public final class AutoKeyboardPolicy {
    public static final int NONE = 0, SHOW = 1, HIDE = 2;
    private String lastId;
    private boolean lastEditable, done;
    private long firstAt;

    public int observe(boolean supported, boolean targeted, boolean editable, String id, long elapsedMs) {
        if (done) return NONE;
        // A legacy host reports focus only: it cannot establish that this tap hit
        // the editor. Never use sticky or programmatically assigned focus alone.
        if (!supported || !targeted || (editable && (id == null || id.isEmpty()))) {
            lastId = null;
            return NONE;
        }
        String value = editable ? id : "";
        if (lastId == null || lastEditable != editable || !lastId.equals(value)) {
            lastId = value; lastEditable = editable; firstAt = elapsedMs;
            return NONE;
        }
        if (elapsedMs - firstAt < 120 || (!editable && elapsedMs < 650)) return NONE;
        done = true;
        return editable ? SHOW : HIDE;
    }
}
