package com.limelight.nvstream;

import org.json.JSONException;
import org.json.JSONObject;

/** Strict response validation. An acknowledgment alone never implies protection. */
public final class PrivacyState {
    public final boolean supported, active;
    public final String lease;
    public final long expiresMs;
    public PrivacyState(JSONObject value) throws JSONException {
        if (!Boolean.TRUE.equals(value.get("ok")) || !(value.get("supported") instanceof Boolean) ||
                !(value.get("active") instanceof Boolean)) throw new JSONException("PRIVACY_INVALID_RESPONSE");
        supported = value.getBoolean("supported"); active = value.getBoolean("active");
        lease = value.optString("lease", "");
        Object expires = value.get("expiresMs");
        if (!(expires instanceof Integer) && !(expires instanceof Long)) throw new JSONException("PRIVACY_INVALID_RESPONSE");
        expiresMs = ((Number) expires).longValue();
        if (expiresMs < 0 || expiresMs > 15000 || (active && (!supported || !lease.matches("[0-9a-f]{32}") || expiresMs == 0)) ||
                (!active && (!lease.isEmpty() || expiresMs != 0))) throw new JSONException("PRIVACY_INVALID_RESPONSE");
    }
    public boolean confirms(String expected) { return active && lease.equals(expected); }
    public static JSONObject request(String op, String instance, long stream, String lease) throws JSONException {
        if ((!op.equals("start") && !op.equals("renew") && !op.equals("stop")) || instance == null ||
                !instance.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}") ||
                stream <= 0 || lease == null || !lease.matches("[0-9a-f]{32}")) throw new JSONException("PRIVACY_BAD_REQUEST");
        return new JSONObject().put("op", op).put("instance", instance).put("stream", stream).put("lease", lease);
    }
}
