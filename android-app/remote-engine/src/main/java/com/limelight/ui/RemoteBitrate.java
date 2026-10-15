package com.limelight.ui;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import com.limelight.nvstream.BitrateState;
import com.limelight.nvstream.DisplayState;
import com.limelight.nvstream.http.NvHTTP;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/** A rate update never pauses input or changes the streaming connection itself. */
public final class RemoteBitrate implements AutoCloseable {
    public enum Result { APPLIED, UNSUPPORTED, REJECTED, UNCONFIRMED }
    public interface Callback { void completed(Result result, int actualBudget); }
    private final NvHTTP http;
    private final Supplier<DisplayState> display;
    private final LongSupplier presented;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean closed;
    private boolean busy;

    public RemoteBitrate(NvHTTP http, Supplier<DisplayState> display, LongSupplier presented) {
        this.http = http; this.display = display; this.presented = presented;
    }

    /** Called on the UI thread; serialize requests and keep work off the decoder. */
    public boolean request(int budget, Callback callback) {
        if (closed || busy) return false;
        busy = true;
        worker.execute(() -> update(budget, callback));
        return true;
    }

    private void complete(Callback callback, Result result, int budget) {
        main.post(() -> {
            busy = false;
            if (!closed) callback.completed(result, budget);
        });
    }

    private void update(int budget, Callback callback) {
        try {
            BitrateState before = http.getBitrate();
            if (!before.supported) { complete(callback, Result.UNSUPPORTED, 0); return; }
            if (!before.matches(display.get())) { complete(callback, Result.REJECTED, 0); return; }
            if (!before.encoderSupported) { complete(callback, Result.UNSUPPORTED, before.budgetKbps); return; }
            if ("pending".equals(before.result)) { complete(callback, Result.REJECTED, 0); return; }
            if (before.budgetKbps == budget && presented.getAsLong() >= before.appliedFrame) {
                complete(callback, Result.APPLIED, budget); return;
            }
            boolean definitelyRejected = false;
            long deadline = SystemClock.uptimeMillis() + 15_000;
            try { http.setBitrate(before, budget); }
            catch (IOException error) {
                String code = error.getMessage();
                if ("BITRATE_UNSUPPORTED".equals(code)) { complete(callback, Result.UNSUPPORTED, 0); return; }
                definitelyRejected = "BITRATE_STALE".equals(code) || "BITRATE_BUSY".equals(code);
                // A lost POST response may already have changed the encoder.
                // Read the result before choosing any recovery action.
            }
            while (!closed && SystemClock.uptimeMillis() < deadline) {
                try {
                    BitrateState current = http.getBitrate();
                    if (!current.matches(display.get()) || !current.instance.equals(before.instance) || current.stream != before.stream) {
                        complete(callback, Result.UNCONFIRMED, 0); return;
                    }
                    if (current.confirms(before, budget, presented.getAsLong())) {
                        complete(callback, Result.APPLIED, budget); return;
                    }
                    if (current.rejects(before, budget) || (definitelyRejected && !"pending".equals(current.result))) {
                        complete(callback, Result.REJECTED, current.budgetKbps); return;
                    }
                } catch (IOException ignored) { }
                Thread.sleep(150);
            }
            if (!closed) complete(callback, Result.UNCONFIRMED, 0);
        } catch (IOException error) {
            complete(callback, "BITRATE_UNSUPPORTED".equals(error.getMessage()) ? Result.UNSUPPORTED : Result.UNCONFIRMED, 0);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    @Override public void close() {
        closed = true;
        http.cancelBitrateRequests();
        worker.shutdownNow();
        main.removeCallbacksAndMessages(null);
    }
}
