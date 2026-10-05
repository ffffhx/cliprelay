package com.limelight.binding.input;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import com.limelight.nvstream.http.NvHTTP;
import org.json.JSONObject;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/** Short, cancellable focus checks after a tap; never blocks touch dispatch. */
public final class AutoKeyboardMonitor implements AutoCloseable {
    public interface Listener { void decision(int action); }
    public interface FocusSource { JSONObject read(float x, float y) throws Exception; }
    private final FocusSource source;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ScheduledThreadPoolExecutor worker = new ScheduledThreadPoolExecutor(1);
    private final AtomicLong generation = new AtomicLong();
    private volatile boolean closed;
    // Main-thread gesture intent. App recognition may invalidate a response, but
    // must not erase the tap that requested it. Back/pause/disconnect do erase it.
    private long tapStartedAt = -1;
    private float tapX, tapY;

    public AutoKeyboardMonitor(NvHTTP http, Listener listener) {
        this(http::getInputFocus, listener);
    }

    public AutoKeyboardMonitor(FocusSource source, Listener listener) {
        this.source = source; this.listener = listener;
        worker.setRemoveOnCancelPolicy(true);
    }

    public void cancel() {
        tapStartedAt = -1;
        generation.incrementAndGet();
        worker.getQueue().clear();
        main.removeCallbacksAndMessages(null);
    }

    public void tap(float x, float y) {
        cancel();
        if (!closed && Float.isFinite(x) && Float.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1) {
            tapX = x; tapY = y;
            tapStartedAt = SystemClock.uptimeMillis();
            schedule(generation.get(), tapStartedAt, x, y, new AutoKeyboardPolicy(), 180);
        }
    }

    public void foregroundChanged() {
        long start = tapStartedAt;
        cancel();
        if (!closed && start >= 0 && SystemClock.uptimeMillis() - start < 2200) {
            tapStartedAt = start;
            schedule(generation.get(), start, tapX, tapY, new AutoKeyboardPolicy(), 180);
        }
    }

    private void schedule(long token, long start, float x, float y, AutoKeyboardPolicy policy, int delay) {
        if (closed || token != generation.get()) return;
        worker.schedule(() -> {
            if (closed || token != generation.get()) return;
            try {
                JSONObject value = source.read(x, y);
                if (closed || token != generation.get()) return;
                long elapsed = SystemClock.uptimeMillis() - start;
                if (elapsed > 3000) return;
                int action = policy.observe(value.optBoolean("supported"), value.optBoolean("targeted"), value.optBoolean("editable"),
                        value.optString("focusId"), elapsed);
                if (action != AutoKeyboardPolicy.NONE) {
                    main.post(() -> {
                        if (!closed && token == generation.get()) {
                            tapStartedAt = -1;
                            listener.decision(action);
                        }
                    });
                    return;
                }
                if (elapsed < 2200) schedule(token, start, x, y, policy, 160);
            } catch (Exception ignored) {
                // Allow a cold TLS/peer connection one bounded retry. Older
                // hosts keep manual keyboard control intact, without dialogs.
                if (SystemClock.uptimeMillis() - start < 2200) schedule(token, start, x, y, policy, 200);
            }
        }, delay, TimeUnit.MILLISECONDS);
    }

    @Override public void close() { closed = true; cancel(); worker.shutdownNow(); }
}
