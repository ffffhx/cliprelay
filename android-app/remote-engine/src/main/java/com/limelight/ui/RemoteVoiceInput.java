package com.limelight.ui;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.widget.Toast;
import com.limelight.R;
import com.limelight.nvstream.http.NvHTTP;
import java.io.IOException;
import java.util.Arrays;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** A foreground-only microphone session. No keyboard, audio files, background recording or retries. */
public final class RemoteVoiceInput {
    public static final int PERMISSION = 8031;
    public enum State { IDLE, STARTING, LISTENING, STOPPING }
    public interface Listener { void changed(State state); }
    private final Activity activity;
    private final NvHTTP http;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable beforeStart;
    private Session session;
    private boolean permissionPending, closed;

    private static final class Session {
        final String id = UUID.randomUUID().toString().replace("-", "");
        volatile boolean ending, abort, captureDone;
        final ArrayBlockingQueue<byte[]> audio = new ArrayBlockingQueue<>(10);
        final AtomicReference<String> error = new AtomicReference<>();
        volatile AudioRecord recorder;
        volatile long recordingAt;
        synchronized boolean begin(AudioRecord next) {
            if (ending) return false;
            recorder = next;
            next.startRecording();
            recordingAt = SystemClock.elapsedRealtime();
            return next.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING;
        }
        synchronized void end(boolean cancel) {
            abort |= cancel;
            ending = true;
            AudioRecord current = recorder;
            if (current != null) try { current.stop(); } catch (IllegalStateException ignored) { }
        }
    }

    public RemoteVoiceInput(Activity activity, NvHTTP http, Runnable beforeStart, Listener listener) {
        this.activity = activity; this.http = http; this.beforeStart = beforeStart; this.listener = listener;
    }

    public boolean isActive() { return session != null || permissionPending; }
    public void toggle() {
        if (session != null) end(false);
        else if (!permissionPending) start();
    }
    private void changed(State state) { if (!closed) listener.changed(state); }
    public void start() {
        if (closed || isActive() || http == null || activity.isFinishing()) return;
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            permissionPending = true;
            changed(State.STARTING);
            activity.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, PERMISSION);
            return;
        }
        beforeStart.run();
        Session next = new Session(); session = next;
        changed(State.STARTING);
        new Thread(() -> run(next), "ClipRelay voice transport").start();
    }
    public void permissionResult(boolean granted, boolean ready) {
        boolean requested = permissionPending; permissionPending = false;
        if (!requested || closed) return;
        if (granted && ready) start();
        else {
            changed(State.IDLE);
            if (!granted) Toast.makeText(activity, R.string.voice_permission, Toast.LENGTH_LONG).show();
        }
    }
    public void end(boolean abort) {
        Session current = session;
        if (current == null) return;
        changed(State.STOPPING);
        current.end(abort);
    }
    public void pause() { end(true); }
    public void close() { closed = true; permissionPending = false; pause(); main.removeCallbacksAndMessages(null); }

    private void record(Session current, AudioRecord recorder) {
        try {
            byte[] buffer = new byte[6400]; // 200 ms, mono PCM16, 16 kHz.
            int used = 0;
            while (!current.ending) {
                int count = recorder.read(buffer, used, buffer.length - used, AudioRecord.READ_BLOCKING);
                if (count <= 0) {
                    if (!current.ending) throw new IOException("VOICE_MIC_FAILED");
                    break;
                }
                used += count;
                if (used == buffer.length) {
                    if (!current.audio.offer(Arrays.copyOf(buffer, used))) throw new IOException("VOICE_AUDIO_BACKLOG");
                    used = 0;
                }
                if (SystemClock.elapsedRealtime() - current.recordingAt >= 175000) current.ending = true;
            }
            if (!current.abort && used >= 2 && !current.audio.offer(Arrays.copyOf(buffer, used & ~1)))
                throw new IOException("VOICE_AUDIO_BACKLOG");
        } catch (Exception error) {
            current.error.compareAndSet(null, error instanceof IOException ? error.getMessage() : "VOICE_MIC_FAILED");
            current.abort = true;
        } finally {
            current.captureDone = true;
        }
    }

    @SuppressWarnings("MissingPermission") // start() checks permission; failures are surfaced and the host is ended.
    private void run(Session current) {
        boolean attempted = false;
        Thread capture = null;
        AudioRecord recorder = null;
        String failure = null;
        try {
            http.voiceRequest("status", current.id, 0, null);
            if (current.ending) return;
            int minimum = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (minimum <= 0) throw new IOException("VOICE_MIC_FAILED");
            recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, 16000,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minimum, 12800));
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) throw new IOException("VOICE_MIC_FAILED");
            attempted = true;
            http.voiceRequest("start", current.id, 0, null);
            if (current.ending) return;
            if (!current.begin(recorder)) {
                if (current.ending) return;
                throw new IOException("VOICE_MIC_FAILED");
            }
            AudioRecord activeRecorder = recorder;
            capture = new Thread(() -> record(current, activeRecorder), "ClipRelay microphone");
            capture.start();
            main.post(() -> { if (session == current && !current.ending) changed(State.LISTENING); });
            int sequence = 0;
            while (!current.abort && (!current.captureDone || !current.audio.isEmpty())) {
                byte[] data = current.audio.poll(250, TimeUnit.MILLISECONDS);
                if (data != null) http.voiceRequest("audio", current.id, sequence++, data);
            }
            if (current.error.get() != null) throw new IOException(current.error.get());
            main.post(() -> { if (session == current) changed(State.STOPPING); });
            http.voiceRequest(current.abort ? "cancel" : "stop", current.id, sequence, null);
            attempted = false;
        } catch (Exception error) {
            failure = error instanceof IOException ? error.getMessage() : "VOICE_MIC_FAILED";
        } finally {
            current.end(true);
            if (capture != null) try { capture.join(1500); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            current.recorder = null;
            if (recorder != null) recorder.release();
            if (attempted) try { http.voiceRequest("cancel", current.id, 0, null); } catch (IOException ignored) { /* Host's independent six-second watchdog ends it. */ }
            String result = failure;
            main.post(() -> {
                if (session != current) return;
                session = null; changed(State.IDLE);
                if (!closed && result != null && !activity.isFinishing())
                    Toast.makeText(activity, message(result), Toast.LENGTH_LONG).show();
            });
        }
    }

    private int message(String code) {
        if (code == null) return R.string.voice_failed;
        switch (code) {
            case "UPDATE_HOST": return R.string.voice_update_host;
            case "DOUBAO_REQUIRED": return R.string.voice_doubao_required;
            case "DOUBAO_VERSION_UNSUPPORTED": return R.string.voice_version_unsupported;
            case "VIRTUAL_MIC_REQUIRED": case "VOICE_AUDIO_DEVICE_FAILED": return R.string.voice_virtual_mic_required;
            case "VOICE_BUSY": return R.string.voice_busy;
            case "VOICE_FOCUS_REQUIRED": return R.string.voice_focus_required;
            case "VOICE_MIC_FAILED": return R.string.voice_mic_failed;
            case "VOICE_AUDIO_BACKLOG": return R.string.voice_backlog;
            default: return R.string.voice_failed;
        }
    }
}
