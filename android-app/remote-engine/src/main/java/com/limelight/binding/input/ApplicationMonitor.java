package com.limelight.binding.input;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import com.limelight.nvstream.http.NvHTTP;
import org.json.JSONObject;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.function.Consumer;

/** Lifecycle-bound, one request at a time. Never polls accessibility or app contents. */
public final class ApplicationMonitor implements AutoCloseable {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final NvHTTP http;
    private final Consumer<String> listener;
    private ApplicationPolicy policy = new ApplicationPolicy();
    private volatile boolean active, closed;
    private volatile long generation;
    public ApplicationMonitor(NvHTTP http, Consumer<String> listener) { this.http = http; this.listener = listener; }
    public void setActive(boolean value) {
        if (closed || active == value) return;
        active = value; generation++;
        main.removeCallbacksAndMessages(null);
        policy = new ApplicationPolicy();
        if (active) poll();
    }
    private void poll() {
        if (!active || closed) return;
        long token = generation;
        worker.execute(() -> {
            if (closed || !active || token != generation) return;
            JSONObject response = null;
            try { response = http.getForegroundApp(); } catch (Exception ignored) {}
            JSONObject value = response;
            main.post(() -> {
                if (closed || !active || token != generation) return;
                String app = policy.observe(value != null && value.optBoolean("supported"),
                        value == null ? "" : value.optString("appId"), SystemClock.uptimeMillis());
                if (app != null) listener.accept(app);
                main.postDelayed(this::poll, value == null ? 2500 : 750);
            });
        });
    }
    @Override public void close() { setActive(false); closed = true; worker.shutdownNow(); }
}
