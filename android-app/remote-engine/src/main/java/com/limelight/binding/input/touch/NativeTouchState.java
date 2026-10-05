package com.limelight.binding.input.touch;

import com.limelight.nvstream.jni.MoonBridge;
import java.util.HashSet;
import java.util.Set;

/** Tracks remote contacts by pointer ID, including cancellation across focus/mode changes. */
public final class NativeTouchState {
    public interface Sink {
        int send(byte type, int id, float x, float y);
    }

    private final Sink sink;
    private final Set<Integer> contacts = new HashSet<>();
    private boolean accepting;
    private boolean cleanupPending;

    public NativeTouchState(Sink sink) { this.sink = sink; }

    public void begin() {
        cancel();
        accepting = !cleanupPending;
    }

    public int down(int id, float x, float y) {
        // Ignore fingers that start in the black bars, rather than clicking a screen edge.
        if (!accepting || id < 0 || contacts.contains(id) || contacts.size() >= 10 ||
                !Float.isFinite(x) || !Float.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return 0;
        int result = sink.send(MoonBridge.LI_TOUCH_EVENT_DOWN, id, x, y);
        if (result == 0) contacts.add(id);
        else cancel();
        return result;
    }

    public void move(int id, float x, float y) {
        if (accepting && contacts.contains(id)) send(MoonBridge.LI_TOUCH_EVENT_MOVE, id, x, y);
    }

    public void up(int id, float x, float y, boolean cancelled) {
        if (accepting && contacts.contains(id)) {
            send(cancelled ? MoonBridge.LI_TOUCH_EVENT_CANCEL : MoonBridge.LI_TOUCH_EVENT_UP, id, x, y);
            contacts.remove(id);
        }
    }

    private void send(byte type, int id, float x, float y) {
        if (!Float.isFinite(x) || !Float.isFinite(y) ||
                sink.send(type, id, Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))) != 0) {
            cancel();
        }
    }

    public void cancel() {
        accepting = false;
        if (!contacts.isEmpty() || cleanupPending) {
            int result = sink.send(MoonBridge.LI_TOUCH_EVENT_CANCEL_ALL, 0, 0, 0);
            cleanupPending = result != 0 && result != MoonBridge.LI_ERR_UNSUPPORTED;
        }
        contacts.clear();
    }
}
