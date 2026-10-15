package com.limelight.ui;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;
import com.limelight.R;
import com.limelight.nvstream.DisplayState;
import com.limelight.nvstream.PrivacyState;
import com.limelight.nvstream.SessionLockState;
import com.limelight.nvstream.AudioMuteState;
import com.limelight.nvstream.http.NvHTTP;
import org.json.JSONObject;
import java.util.UUID;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/** Foreground privacy/mute leases and a separate host-owned final-lock intent. */
public final class RemotePrivacy implements AutoCloseable {
    private final Activity activity;
    private final NvHTTP http;
    private final Supplier<DisplayState> display;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ScheduledThreadPoolExecutor worker = new ScheduledThreadPoolExecutor(1);
    private volatile boolean active, closed;
    // The worker owns the current lease, including cleanup of a lost start reply.
    private String lease, instance;
    private long stream;
    private String lockLease, lockInstance;
    private long lockStream;
    private String audioLease, audioInstance;
    private long audioStream, audioGeneration;
    private AlertDialog dialog;
    private int dialogToken;

    public RemotePrivacy(Activity activity, NvHTTP http, Supplier<DisplayState> display) {
        this.activity = activity; this.http = http; this.display = display;
        worker.setRemoveOnCancelPolicy(true);
        worker.setExecuteExistingDelayedTasksAfterShutdownPolicy(false);
        worker.scheduleWithFixedDelay(this::renew, 3, 3, TimeUnit.SECONDS);
    }
    public void setActive(boolean value) {
        if (closed || active == value) return;
        active = value;
        if (!value) { dismiss(); enqueue(this::restoreForeground); }
    }
    private boolean usable() { return active && !closed && !activity.isFinishing() && !activity.isDestroyed(); }
    private void enqueue(Runnable task) {
        if (closed) return;
        try { worker.execute(task); } catch (RejectedExecutionException ignored) { /* activity closed before dispatch */ }
    }
    public void show() {
        if (!usable()) return;
        dismiss(); final int token = ++dialogToken;
        dialog = new AlertDialog.Builder(activity).setTitle(R.string.privacy_title).setMessage(R.string.privacy_loading)
                .setNegativeButton(android.R.string.cancel, null).create();
        dialog.setOnDismissListener(d -> { if (dialogToken == token) ++dialogToken; }); dialog.show();
        enqueue(() -> {
            try {
                PrivacyState state = new PrivacyState(http.privacyRequest(new JSONObject().put("op", "status")));
                boolean mine = lease != null && state.confirms(lease);
                if (!mine && lease != null) stop();
                SessionLockState lock = new SessionLockState(http.sessionLockRequest(new JSONObject().put("op", "status")));
                DisplayState currentDisplay = display.get();
                boolean lockMine = lock.armedFor(currentDisplay);
                if (lock.belongsTo(currentDisplay)) { lockLease = lock.lease; lockInstance = lock.instance; lockStream = lock.stream; }
                else { lockLease = null; lockInstance = null; lockStream = 0; }
                AudioMuteState audio = null;
                // Older hosts can still provide screen and lock controls.
                try { audio = new AudioMuteState(http.audioMuteRequest(new JSONObject().put("op", "status"))); }
                catch (Exception ignored) { /* shown as unavailable, without claiming mute */ }
                boolean audioMine = audio != null && audioLease != null && audio.confirms(audioLease);
                if (!audioMine && audioLease != null) stopAudio();
                final AudioMuteState audioState = audio;
                main.post(() -> {
                    if (!usable() || token != dialogToken) return;
                    dismiss();
                    dialog = new AlertDialog.Builder(activity).setTitle(R.string.privacy_title)
                            .setItems(new String[]{option(R.string.privacy_screen_option, state.supported, mine),
                                    option(R.string.audio_mute_title, audioState != null && audioState.supported, audioMine),
                                    option(R.string.session_lock_enable, lock.supported, lockMine)}, (d, which) -> {
                                if (which == 0) showMask(state, mine);
                                else if (which == 1) showAudio(audioState, audioMine);
                                else showLock(lock, lockMine);
                            })
                            .setNegativeButton(android.R.string.cancel, null).show();
                });
            } catch (Exception e) {
                int message = "PRIVACY_UNSUPPORTED".equals(e.getMessage()) ? R.string.privacy_unsupported : R.string.privacy_unavailable;
                main.post(() -> { if (token == dialogToken) { dismiss(); toast(message); } });
            }
        });
    }
    private String option(int title, boolean supported, boolean enabled) {
        return activity.getString(title) + " · " + activity.getString(!supported ? R.string.privacy_option_unavailable :
                enabled ? R.string.privacy_option_on : R.string.privacy_option_off);
    }
    private void showMask(PrivacyState state, boolean mine) {
        if (!usable()) return;
        dismiss();
        dialog = new AlertDialog.Builder(activity).setTitle(R.string.privacy_screen_option)
                .setMessage(!state.supported ? R.string.privacy_unsupported : mine ? R.string.privacy_active : R.string.privacy_description)
                .setPositiveButton(mine ? R.string.privacy_disable : R.string.privacy_enable,
                        (d, which) -> enqueue(() -> { if (mine) stop(); else start(); }))
                .setNegativeButton(android.R.string.cancel, null).show();
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(state.supported || mine);
    }
    private void showLock(SessionLockState state, boolean mine) {
        if (!usable()) return;
        dismiss();
        dialog = new AlertDialog.Builder(activity).setTitle(R.string.session_lock_enable)
                .setMessage(!state.supported ? R.string.session_lock_unavailable : mine ? R.string.session_lock_armed : R.string.session_lock_description)
                .setPositiveButton(mine ? R.string.session_lock_disable : R.string.session_lock_enable,
                        (d, which) -> enqueue(() -> { if (mine) disarmLock(true); else armLock(); }))
                .setNegativeButton(android.R.string.cancel, null).show();
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(state.supported || mine);
    }
    private void showAudio(AudioMuteState state, boolean mine) {
        if (!usable()) return;
        dismiss();
        int message = state != null && state.recovering ? R.string.audio_mute_recovering :
                state == null || !state.supported ? R.string.audio_mute_unsupported : mine ? R.string.audio_mute_active : R.string.audio_mute_description;
        dialog = new AlertDialog.Builder(activity).setTitle(R.string.audio_mute_title).setMessage(message)
                .setPositiveButton(mine ? R.string.audio_mute_disable : R.string.audio_mute_enable,
                        (d, which) -> enqueue(() -> { if (mine) stopAudio(); else startAudio(); }))
                .setNegativeButton(android.R.string.cancel, null).show();
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(mine || (state != null && state.supported));
    }
    private void start() {
        if (!usable()) return;
        DisplayState state = display.get();
        if (state == null || !state.supported || state.shared || state.stream == 0 || !"active".equals(state.phase)) {
            main.post(() -> toast(R.string.privacy_exclusive)); return;
        }
        stop(); instance = state.instance; stream = state.stream; lease = UUID.randomUUID().toString().replace("-", "");
        try {
            PrivacyState result = new PrivacyState(http.privacyRequest(PrivacyState.request("start", instance, stream, lease)));
            if (!result.confirms(lease)) throw new IllegalStateException();
            if (!usable()) { stop(); return; }
            main.post(() -> toast(R.string.privacy_enabled));
        } catch (Exception e) { stop(); main.post(() -> toast(R.string.privacy_unavailable)); }
    }
    private void renew() {
        renewMask();
        renewAudio();
    }
    private void renewMask() {
        if (lease == null) return;
        if (!usable()) { stop(); return; }
        try {
            PrivacyState state = new PrivacyState(http.privacyRequest(PrivacyState.request("renew", instance, stream, lease)));
            if (!state.confirms(lease)) throw new IllegalStateException();
        } catch (Exception e) { stop(); main.post(() -> { dismiss(); toast(R.string.privacy_restored); }); }
    }
    private void stop() {
        if (lease == null) return;
        try { http.privacyRequest(PrivacyState.request("stop", instance, stream, lease)); } catch (Exception ignored) { /* host expires independently */ }
        finally { lease = null; instance = null; stream = 0; }
    }
    private void startAudio() {
        if (!usable()) return;
        DisplayState current = display.get();
        if (current == null || !current.safeHostMute()) { main.post(() -> toast(R.string.audio_mute_unsupported)); return; }
        stopAudio();
        audioInstance = current.instance; audioStream = current.stream; audioGeneration = current.audioGeneration;
        audioLease = UUID.randomUUID().toString().replace("-", "");
        try {
            AudioMuteState result = new AudioMuteState(http.audioMuteRequest(AudioMuteState.request("start", audioInstance, audioStream, audioGeneration, audioLease)));
            if (!result.confirms(audioLease)) throw new IllegalStateException();
            if (!usable()) { stopAudio(); return; }
            main.post(() -> toast(R.string.audio_mute_enabled));
        } catch (Exception e) { stopAudio(); main.post(() -> toast(R.string.audio_mute_unavailable)); }
    }
    private void renewAudio() {
        if (audioLease == null) return;
        DisplayState current = display.get();
        if (!usable()) { stopAudio(); return; }
        try {
            if (current == null || !current.sameAudioBinding(audioInstance, audioStream, audioGeneration)) throw new IllegalStateException();
            AudioMuteState state = new AudioMuteState(http.audioMuteRequest(AudioMuteState.request("renew", audioInstance, audioStream, audioGeneration, audioLease)));
            if (!state.confirms(audioLease)) throw new IllegalStateException();
        } catch (Exception e) { stopAudio(); main.post(() -> { dismiss(); toast(R.string.audio_mute_restored); }); }
    }
    private void stopAudio() {
        if (audioLease == null) return;
        try { http.audioMuteRequest(AudioMuteState.request("stop", audioInstance, audioStream, audioGeneration, audioLease)); }
        catch (Exception ignored) { /* independent host expiry and durable recovery remain active */ }
        finally { audioLease = null; audioInstance = null; audioStream = 0; audioGeneration = 0; }
    }
    private void restoreForeground() { stop(); stopAudio(); }
    private void armLock() {
        if (!usable()) return;
        DisplayState state = display.get();
        if (state == null || !state.supported || state.shared || state.stream == 0 || !"active".equals(state.phase)) {
            main.post(() -> toast(R.string.privacy_exclusive)); return;
        }
        if (!disarmLock(false)) return;
        lockInstance = state.instance; lockStream = state.stream; lockLease = UUID.randomUUID().toString().replace("-", "");
        try {
            SessionLockState result = new SessionLockState(http.sessionLockRequest(SessionLockState.request("arm", lockInstance, lockStream, lockLease)));
            if (!result.confirms(lockLease, lockInstance, lockStream)) throw new IllegalStateException();
            main.post(() -> toast(R.string.session_lock_enabled));
        } catch (Exception e) { disarmLock(false); main.post(() -> toast(R.string.session_lock_unavailable)); }
    }
    private boolean disarmLock(boolean announce) {
        if (lockLease == null) return true;
        try {
            SessionLockState result = new SessionLockState(http.sessionLockRequest(SessionLockState.request("disarm", lockInstance, lockStream, lockLease)));
            if (!"off".equals(result.state)) throw new IllegalStateException();
            lockLease = null; lockInstance = null; lockStream = 0;
            if (announce) main.post(() -> toast(R.string.session_lock_disabled));
            return true;
        } catch (Exception e) { main.post(() -> toast(R.string.session_lock_unavailable)); return false; }
    }
    private void toast(int message) { if (usable()) Toast.makeText(activity, message, Toast.LENGTH_LONG).show(); }
    private void dismiss() { ++dialogToken; if (dialog != null) { dialog.dismiss(); dialog = null; } }
    @Override public synchronized void close() {
        if (closed) return;
        closed = true; active = false; dismiss();
        // The host owns a successfully armed end-of-stream intent. Closing this
        // UI restores mask and sound; it must not disarm the requested final lock.
        worker.execute(() -> { restoreForeground(); http.cancelPrivacyRequests(); }); worker.shutdown();
    }
}
