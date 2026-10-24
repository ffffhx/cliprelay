package com.limelight.ui;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.widget.Toast;
import com.limelight.R;
import com.limelight.nvstream.http.NvHTTP;
import com.limelight.nvstream.wol.WakeState;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.BooleanSupplier;

/** Reads host OS from existing paired, read-only status; input uses the encrypted stream. */
public final class RemoteDesktops implements AutoCloseable {
    private final Activity activity;
    private final NvHTTP http;
    private final BooleanSupplier allowed;
    private final GameInputState keys;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private boolean closed, loading;
    private String platform;
    private int pending;
    private long lastAttempt, pendingAt;

    public RemoteDesktops(Activity activity, NvHTTP http, BooleanSupplier allowed, GameInputState.KeySink sink) {
        this.activity = activity; this.http = http; this.allowed = allowed;
        keys = new GameInputState(sink); keys.setEnabled(true);
    }

    public void prepare() {
        if (closed || loading || platform != null || !allowed.getAsBoolean()
                || (lastAttempt != 0 && SystemClock.uptimeMillis() - lastAttempt < 15000)) return;
        loading = true; lastAttempt = SystemClock.uptimeMillis();
        worker.execute(() -> {
            String found = null;
            try {
                // This is only op=status: it never sends a wake packet or changes power settings.
                JSONObject status = http.wakeRequest(WakeState.statusRequest());
                String os = status.optString("platform");
                if (status.optBoolean("ok") && status.optBoolean("supported")
                        && DesktopShortcut.keys(os, 1).length != 0) found = os;
            } catch (Exception ignored) { }
            final String value = found;
            main.post(() -> {
                loading = false;
                if (closed) return;
                platform = value;
                int direction = pending; pending = 0;
                if (direction == 0 || !allowed.getAsBoolean()) return;
                if (platform == null) unavailable();
                else if (SystemClock.uptimeMillis() - pendingAt > 1500)
                    Toast.makeText(activity, R.string.desktop_gesture_retry, Toast.LENGTH_SHORT).show();
                else send(direction);
            });
        });
    }

    public void switchRelative(int direction) {
        if (closed || !allowed.getAsBoolean() || (direction != -1 && direction != 1)) return;
        if (platform != null) { send(direction); return; }
        prepare();
        if (loading) { pending = direction; pendingAt = SystemClock.uptimeMillis(); }
        else unavailable();
    }

    private void send(int direction) {
        try { keys.update("desktop", DesktopShortcut.keys(platform, direction)); }
        finally { keys.releaseAll(); }
    }
    private void unavailable() {
        Toast.makeText(activity, R.string.desktop_gesture_host_unavailable, Toast.LENGTH_LONG).show();
    }
    public void cancel() { pending = 0; keys.releaseAll(); }
    @Override public void close() {
        closed = true; cancel(); http.cancelWakeRequests(); worker.shutdownNow();
        main.removeCallbacksAndMessages(null);
    }
}
