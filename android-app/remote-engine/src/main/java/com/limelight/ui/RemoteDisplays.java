package com.limelight.ui;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.widget.Toast;
import com.limelight.R;
import com.limelight.nvstream.DisplayState;
import com.limelight.nvstream.http.NvHTTP;
import org.json.JSONObject;
import java.io.IOException;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;

/** Display switching keeps the video connection alive and waits for presentation. */
public final class RemoteDisplays implements AutoCloseable {
    public interface Controls {
        void pauseInput(boolean paused);
        void disconnect();
    }
    private final Activity activity;
    private final NvHTTP http;
    private final LongSupplier renderedFrame;
    private final Controls controls;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ScheduledThreadPoolExecutor worker = new ScheduledThreadPoolExecutor(1);
    private volatile boolean active, monitoring, closed, legacy;
    private volatile DisplayState state;
    private static final class PollState {
        final DisplayState value; final long requestedAt;
        PollState(DisplayState value, long requestedAt) { this.value = value; this.requestedAt = requestedAt; }
    }
    private volatile PollState lastPoll;
    // Main-thread UI and switch state.
    private AlertDialog dialog;
    private int dialogToken;
    private boolean waiting, rejected;
    private DisplayState starting;
    private volatile DisplayState lastReady;
    private String target;
    private long startedAt;

    public RemoteDisplays(Activity activity, NvHTTP http, LongSupplier renderedFrame, Controls controls) {
        this.activity = activity; this.http = http; this.renderedFrame = renderedFrame; this.controls = controls;
        worker.setRemoveOnCancelPolicy(true);
        worker.scheduleWithFixedDelay(this::poll, 0, 750, TimeUnit.MILLISECONDS);
    }

    public void setActive(boolean value) { active = value; }
    public void setMonitoring(boolean value) { monitoring = value; }
    public DisplayState currentState() { return state; }

    public boolean readyAfterNetworkPause(long pausedAt, long presentedFrame) {
        if (legacy) return true; // older hosts have no display-generation API
        PollState poll = lastPoll;
        DisplayState ready = lastReady;
        return poll != null && poll.requestedAt >= pausedAt && poll.value.ready(presentedFrame) &&
                (ready == null || (poll.value.instance.equals(ready.instance) && poll.value.stream == ready.stream));
    }

    private boolean usable() { return !closed && !activity.isFinishing() && !activity.isDestroyed(); }

    private void poll() {
        if (!monitoring || closed || legacy) return;
        try {
            long requestedAt = SystemClock.uptimeMillis();
            DisplayState value = http.getDisplays(false);
            lastPoll = new PollState(value, requestedAt);
            state = value; legacy = !value.supported;
            main.post(() -> accept(value));
        } catch (IOException e) {
            if ("DISPLAY_UNSUPPORTED".equals(e.getMessage())) legacy = true;
            main.post(this::updateWaitingMessage);
        }
    }

    /** Used by AutoKeyboardMonitor; stale/unknown capture never opens the IME. */
    public JSONObject focus(float x, float y) throws Exception {
        if (legacy) return http.getInputFocus(x, y);
        DisplayState before = state;
        long frame = renderedFrame.getAsLong();
        if (before == null || !before.sameBinding(lastReady) || !before.ready(frame)) return unknownFocus();
        JSONObject value = http.getDisplayFocus(x, y, before, frame);
        return before.sameBinding(state) ? value : unknownFocus();
    }

    private static JSONObject unknownFocus() throws Exception {
        return new JSONObject().put("supported", false).put("targeted", true);
    }

    public void showPicker() {
        if (!usable() || !active || waiting) return;
        dismiss();
        final int token = ++dialogToken;
        dialog = new AlertDialog.Builder(activity).setTitle(R.string.displays_title)
                .setMessage(R.string.displays_loading).setNegativeButton(android.R.string.cancel, null).create();
        dialog.setOnCancelListener(d -> ++dialogToken);
        dialog.setOnDismissListener(d -> { if (dialogToken == token) ++dialogToken; });
        dialog.show();
        worker.execute(() -> {
            try {
                DisplayState value = http.getDisplays(true);
                state = value; legacy = !value.supported;
                main.post(() -> {
                    if (!usable() || dialogToken != token) return;
                    // Replace this particular loading dialog, preserving cancel intent.
                    dialog.setOnDismissListener(null);
                    dismiss();
                    if (!value.supported) { toast(R.string.displays_update_host); return; }
                    if (value.stream == 0 || value.displays.isEmpty()) { toast(R.string.displays_not_ready); return; }
                    String[] labels = new String[value.displays.size()];
                    for (int i = 0; i < labels.length; i++) {
                        String id = value.displays.get(i);
                        String number = id.replaceFirst("^.*DISPLAY", "");
                        if (!number.matches("[0-9]{1,3}")) number = Integer.toString(i + 1);
                        labels[i] = activity.getString(R.string.displays_name, number)
                                + (id.equals(value.capture) ? activity.getString(R.string.displays_current) : "");
                    }
                    AlertDialog.Builder picker = new AlertDialog.Builder(activity).setTitle(R.string.displays_title)
                            .setItems(labels, (d, index) -> beginSwitch(value, value.displays.get(index)))
                            .setNeutralButton(R.string.displays_refresh, (d, which) -> showPicker())
                            .setNegativeButton(android.R.string.cancel, null);
                    // A separate message in a list AlertDialog can hide the list
                    // on some Android versions, so put the shared-session notice in the title.
                    if (value.shared) picker.setTitle(R.string.displays_shared_title);
                    dialog = picker.show();
                });
            } catch (IOException e) {
                main.post(() -> {
                    if (!usable() || dialogToken != token) return;
                    dismiss();
                    toast("DISPLAY_UNSUPPORTED".equals(e.getMessage()) ? R.string.displays_update_host : R.string.displays_unavailable);
                });
            }
        });
    }

    private void beginSwitch(DisplayState before, String display) {
        if (!usable() || !active || waiting) return;
        dismiss();
        if (display.equals(before.capture) && before.ready(renderedFrame.getAsLong())) return;
        starting = before; target = display; waiting = true; rejected = false;
        startedAt = SystemClock.uptimeMillis();
        controls.pauseInput(true);
        showWaitingDialog(R.string.displays_switching);
        worker.execute(() -> {
            try {
                DisplayState value = http.selectDisplay(before, display);
                state = value;
                main.post(() -> accept(value));
            } catch (IOException e) {
                main.post(() -> {
                    if (!usable() || !waiting) return;
                    // A 409 or 429 proves the selection was rejected. A network timeout
                    // does not: keep input paused until the resulting frame is known.
                    rejected = "DISPLAY_STALE".equals(e.getMessage()) || "DISPLAY_BUSY".equals(e.getMessage());
                    updateWaitingMessage();
                });
            }
        });
    }

    private void showWaitingDialog(int message) {
        dialog = new AlertDialog.Builder(activity).setTitle(R.string.displays_title)
                .setMessage(message).setCancelable(false)
                .setNegativeButton(R.string.desktop_disconnect, (d, which) -> controls.disconnect()).show();
    }

    private void accept(DisplayState value) {
        if (!usable() || !active) return;
        if (!waiting) {
            boolean sameSession = lastReady == null || (value.instance.equals(lastReady.instance) && value.stream == lastReady.stream);
            if (sameSession && value.ready(renderedFrame.getAsLong())) { lastReady = value; return; }
            if (lastReady == null || !value.supported) return;
            // Hotplug and host keyboard shortcuts can also replace capture.
            // Once observed, keep input away from the previous frozen picture.
            dismiss();
            starting = lastReady; target = null; waiting = true; rejected = false;
            startedAt = SystemClock.uptimeMillis();
            controls.pauseInput(true);
            showWaitingDialog(R.string.displays_recovering);
        }
        int outcome = value.switchOutcome(starting, target, rejected, renderedFrame.getAsLong());
        if (outcome != DisplayState.SWITCH_WAIT) {
            waiting = false;
            lastReady = value;
            dismiss();
            controls.pauseInput(false);
            if (outcome == DisplayState.SWITCH_FAILED) toast(R.string.displays_switch_failed);
        } else updateWaitingMessage();
    }

    private void updateWaitingMessage() {
        if (usable() && waiting && dialog != null && SystemClock.uptimeMillis() - startedAt > 15000)
            dialog.setMessage(activity.getString(R.string.displays_waiting));
    }

    private void toast(int message) { if (usable()) Toast.makeText(activity, message, Toast.LENGTH_LONG).show(); }
    private void dismiss() { if (dialog != null) { dialog.dismiss(); dialog = null; } }

    @Override public void close() {
        closed = true; active = false;
        http.cancelDisplayRequests(); worker.shutdownNow(); main.removeCallbacksAndMessages(null);
        dismiss();
        // Game closes the connection. Do not re-enable input to a stale picture.
    }
}
