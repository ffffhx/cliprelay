package com.limelight.nvstream;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Immutable view of the paired control service's filtered display snapshot. */
public final class DisplayState {
    public static final int SWITCH_WAIT = 0, SWITCH_DONE = 1, SWITCH_FAILED = 2;
    public final boolean supported, shared;
    public final String instance, phase, capture, error, result, requested;
    public final long revision, generation, stream, firstFrame, streamGeneration, requestId;
    public final String audioCapture;
    public final long audioGeneration;
    public final boolean audioReady;
    public final List<String> displays;

    public DisplayState(JSONObject json) throws JSONException {
        supported = json.optBoolean("supported") && json.optInt("protocol") == 1;
        shared = json.optBoolean("shared");
        instance = json.optString("instance");
        phase = json.optString("phase", "idle");
        revision = json.optLong("revision");
        generation = json.optLong("generation");
        error = json.optString("error"); result = json.optString("result");
        requested = json.optString("requested"); requestId = json.optLong("requestId");
        if (supported && (!instance.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
                || revision < 0 || generation < 0 || !java.util.Arrays.asList("idle", "starting", "switching", "active").contains(phase)))
            throw new JSONException("Invalid display state");
        JSONObject geometry = json.optJSONObject("capture");
        capture = geometry == null ? "" : geometry.optString("id");
        ArrayList<String> ids = new ArrayList<>();
        JSONArray list = json.optJSONArray("displays");
        if (list != null) {
            if (list.length() > 64) throw new JSONException("Too many displays");
            for (int i = 0; i < list.length(); i++) {
                String id = list.getString(i);
                if (id.isEmpty() || id.length() > 256 || ids.contains(id)) throw new JSONException("Invalid display ID");
                ids.add(id);
            }
        }
        displays = Collections.unmodifiableList(ids);
        JSONArray streams = json.optJSONArray("streams");
        // A phone normally owns one live stream. Do not guess between two
        // connections sharing a certificate and unrelated frame counters.
        JSONObject current = streams != null && streams.length() == 1 ? streams.getJSONObject(0) : null;
        stream = current == null ? 0 : current.optLong("id");
        firstFrame = current == null ? 0 : current.optLong("firstFrame");
        streamGeneration = current == null ? 0 : current.optLong("generation");
        if (stream < 0 || firstFrame < 0 || streamGeneration < 0) throw new JSONException("Invalid stream state");
        JSONObject audio = current == null ? null : current.optJSONObject("audio");
        if (current != null && current.has("audio") && audio == null) throw new JSONException("Invalid audio state");
        audioCapture = audio == null ? "" : audio.getString("capture");
        Object audioId = audio == null ? 0 : audio.get("generation");
        if (!(audioId instanceof Integer) && !(audioId instanceof Long)) throw new JSONException("Invalid audio generation");
        audioGeneration = ((Number) audioId).longValue();
        if (audio != null && (!(audio.get("capture") instanceof String) || !(audio.get("ready") instanceof Boolean)))
            throw new JSONException("Invalid audio state");
        audioReady = audio != null && audio.getBoolean("ready");
        if (audioGeneration < 0 || (!audioCapture.equals("") && !audioCapture.equals("process") && !audioCapture.equals("system-tap") && !audioCapture.equals("endpoint")) ||
                (audioCapture.isEmpty() && (audioGeneration != 0 || audioReady)) ||
                (!audioCapture.isEmpty() && audioGeneration == 0) || (audioCapture.equals("endpoint") && audioReady))
            throw new JSONException("Invalid audio state");
    }

    public boolean ready(long renderedFrame) {
        return supported && "active".equals(phase) && !capture.isEmpty() && stream > 0 && generation > 0
                && streamGeneration == generation && firstFrame > 0 && renderedFrame >= firstFrame;
    }

    public boolean sameBinding(DisplayState other) {
        return other != null && instance.equals(other.instance) && stream == other.stream && generation == other.generation;
    }

    public boolean safeHostMute() {
        return supported && !shared && "active".equals(phase) && stream > 0 && firstFrame > 0 && generation > 0 &&
                streamGeneration == generation && ("process".equals(audioCapture) || "system-tap".equals(audioCapture)) && audioGeneration > 0 && audioReady;
    }

    public boolean sameAudioBinding(String expectedInstance, long expectedStream, long expectedAudioGeneration) {
        return safeHostMute() && instance.equals(expectedInstance) && stream == expectedStream && audioGeneration == expectedAudioGeneration;
    }

    public int switchOutcome(DisplayState starting, String target, boolean rejected, long renderedFrame) {
        if (starting == null || !instance.equals(starting.instance) || stream != starting.stream || !ready(renderedFrame))
            return SWITCH_WAIT;
        if (target == null) return SWITCH_DONE; // capture recovery/hotplug: any newly presented output
        boolean failed = "failed".equals(result) && target.equals(requested) && requestId > starting.requestId;
        if (failed || rejected) return SWITCH_FAILED;
        return target.equals(capture) ? SWITCH_DONE : SWITCH_WAIT;
    }

    public JSONObject selection(String display) throws JSONException {
        if (!supported || stream == 0 || !displays.contains(display)) throw new JSONException("Display unavailable");
        return new JSONObject().put("instance", instance).put("stream", stream).put("display", display).put("revision", revision);
    }
}
