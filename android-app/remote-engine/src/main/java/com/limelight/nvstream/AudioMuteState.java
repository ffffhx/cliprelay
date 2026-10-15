package com.limelight.nvstream;

import org.json.JSONException;
import org.json.JSONObject;

/** A host mute is confirmed only by a valid current lease, never just HTTP 200. */
public final class AudioMuteState {
    public final boolean supported, active, recovering;
    public final String lease;
    public final long expiresMs;
    public final int outputs;

    public AudioMuteState(JSONObject value) throws JSONException {
        PrivacyState base = new PrivacyState(value);
        supported = base.supported; active = base.active; lease = base.lease; expiresMs = base.expiresMs;
        Object count = value.get("outputs");
        if (!(value.get("recovering") instanceof Boolean) || (!(count instanceof Integer) && !(count instanceof Long)))
            throw new JSONException("AUDIO_INVALID_RESPONSE");
        recovering = value.getBoolean("recovering");
        long number = ((Number) count).longValue();
        if (number < 0 || number > 32 || (recovering && (active || supported)) || (supported && number == 0))
            throw new JSONException("AUDIO_INVALID_RESPONSE");
        outputs = (int) number;
    }
    public boolean confirms(String expected) { return active && lease.equals(expected); }
    public static JSONObject request(String op, String instance, long stream, long generation, String lease) throws JSONException {
        if (generation <= 0) throw new JSONException("AUDIO_BAD_REQUEST");
        return PrivacyState.request(op, instance, stream, lease).put("audioGeneration", generation);
    }
}
