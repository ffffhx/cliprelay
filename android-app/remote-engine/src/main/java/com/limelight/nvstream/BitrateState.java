package com.limelight.nvstream;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Immutable, certificate-filtered live bitrate state. Never guess a stream ID. */
public final class BitrateState {
    public final boolean supported, encoderSupported;
    public final String instance, result, error;
    public final long stream, revision, requestId, appliedFrame;
    public final int budgetKbps, videoKbps, requestedKbps;

    public BitrateState(JSONObject json) throws JSONException {
        supported = json.optBoolean("supported") && json.optInt("protocol") == 1;
        instance = json.optString("instance");
        if (supported && !instance.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))
            throw new JSONException("Invalid engine identity");
        JSONArray streams = json.optJSONArray("streams");
        if (streams != null && streams.length() > 64) throw new JSONException("Too many streams");
        JSONObject s = streams != null && streams.length() == 1 ? streams.getJSONObject(0) : null;
        stream = s == null ? 0 : integer(s, "id", 1, Long.MAX_VALUE);
        revision = s == null ? 0 : integer(s, "revision", 1, Long.MAX_VALUE);
        requestId = s == null ? 0 : integer(s, "requestId", 0, Long.MAX_VALUE);
        appliedFrame = s == null ? 0 : integer(s, "appliedFrame", 0, Long.MAX_VALUE);
        budgetKbps = s == null ? 0 : (int) integer(s, "budgetKbps", 0, 1_000_000);
        videoKbps = s == null ? 0 : (int) integer(s, "videoKbps", 1, 1_000_000);
        requestedKbps = s == null ? 0 : (int) integer(s, "requestedKbps", 0, 150_000);
        encoderSupported = s != null && s.optBoolean("supported");
        result = s == null ? "" : s.getString("result");
        error = s == null ? "" : s.getString("error");
        if (!java.util.Arrays.asList("", "pending", "applied", "failed").contains(result) || error.length() > 64)
            throw new JSONException("Invalid bitrate result");
        if ("applied".equals(result) && (appliedFrame == 0 || requestId == 0 || budgetKbps != requestedKbps))
            throw new JSONException("Unconfirmed bitrate");
    }

    private static long integer(JSONObject object, String key, long minimum, long maximum) throws JSONException {
        Object value = object.get(key);
        if (!(value instanceof Integer) && !(value instanceof Long)) throw new JSONException("Invalid " + key);
        long number = ((Number)value).longValue();
        if (number < minimum || number > maximum) throw new JSONException("Invalid " + key);
        return number;
    }

    public boolean matches(DisplayState display) {
        return supported && stream > 0 && display != null && display.supported &&
                instance.equals(display.instance) && stream == display.stream;
    }

    public JSONObject selection(int budget) throws JSONException {
        if (!supported || !encoderSupported || stream == 0 || budget < 500 || budget > 150000)
            throw new JSONException("Bitrate unavailable");
        return new JSONObject().put("instance", instance).put("stream", stream)
                .put("revision", revision).put("budgetKbps", budget);
    }

    public boolean confirms(BitrateState before, int budget, long presentedFrame) {
        return before != null && supported && instance.equals(before.instance) && stream == before.stream && stream > 0 &&
                requestId > before.requestId && "applied".equals(result) && budgetKbps == budget &&
                requestedKbps == budget && appliedFrame > 0 && presentedFrame >= appliedFrame;
    }

    public boolean rejects(BitrateState before, int budget) {
        return before != null && instance.equals(before.instance) && stream == before.stream && stream > 0 &&
                requestId > before.requestId && requestedKbps == budget && "failed".equals(result);
    }
}
