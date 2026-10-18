package com.limelight.nvstream;

import org.json.JSONException;
import org.json.JSONObject;
import java.util.Arrays;

/** An opt-in intent for one specific stream, not a persistent device preference. */
public final class SessionLockState {
    public final boolean supported;
    public final String state, lease, instance;
    public final long stream, expiresMs;
    public SessionLockState(JSONObject value) throws JSONException {
        if (!Boolean.TRUE.equals(value.get("ok")) || !(value.get("supported") instanceof Boolean)) throw invalid();
        supported = value.getBoolean("supported");
        state = value.getString("state"); lease = value.optString("lease", ""); instance = value.optString("instance", "");
        stream = integer(value, "stream", 0); expiresMs = integer(value, "expiresMs", -1);
        if (!Arrays.asList("off", "armed", "requested", "locked", "failed", "cancelled").contains(state) ||
                expiresMs < 0 || expiresMs > 15000) throw invalid();
        if (state.equals("off")) {
            if (!lease.isEmpty() || !instance.isEmpty() || stream != 0 || expiresMs != 0) throw invalid();
        } else {
            if (!supported || !lease.matches("[0-9a-f]{32}") || !validInstance(instance) || stream <= 0) throw invalid();
            if ((state.equals("armed") || state.equals("requested")) != (expiresMs > 0)) throw invalid();
        }
    }
    private static long integer(JSONObject value, String key, long fallback) throws JSONException {
        if (!value.has(key)) return fallback;
        Object n = value.get(key); if (!(n instanceof Integer) && !(n instanceof Long)) throw invalid();
        return ((Number) n).longValue();
    }
    private static JSONException invalid() { return new JSONException("LOCK_INVALID_RESPONSE"); }
    private static boolean validInstance(String value) { return value != null && value.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"); }
    public boolean belongsTo(DisplayState display) { return display != null && stream == display.stream && instance.equals(display.instance) && !lease.isEmpty(); }
    public boolean armedFor(DisplayState display) { return state.equals("armed") && belongsTo(display); }
    public boolean confirms(String expected, String hostInstance, long hostStream) {
        return state.equals("armed") && lease.equals(expected) && instance.equals(hostInstance) && stream == hostStream;
    }
    public static JSONObject request(String op, String instance, long stream, String lease) throws JSONException {
        if ((!op.equals("arm") && !op.equals("disarm")) || !validInstance(instance) || stream <= 0 ||
                lease == null || !lease.matches("[0-9a-f]{32}")) throw new JSONException("LOCK_BAD_REQUEST");
        return new JSONObject().put("op", op).put("instance", instance).put("stream", stream).put("lease", lease);
    }
}
