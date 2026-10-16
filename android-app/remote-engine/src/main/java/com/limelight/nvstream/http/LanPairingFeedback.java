package com.limelight.nvstream.http;

import java.io.IOException;
import org.json.JSONObject;

/** Observations only: success still requires the native PIN and certificate proof. */
public final class LanPairingFeedback {
    public final String id, receipt;
    public final long expires;
    private LanPairingFeedback(String id, String receipt, long expires) {
        this.id=id; this.receipt=receipt; this.expires=expires;
    }
    private static boolean integer(Object value) { return value instanceof Integer || value instanceof Long; }
    private static boolean token(Object value) { return value instanceof String && ((String)value).matches("[0-9a-f]{32}"); }
    private static IOException invalid() { return new IOException("电脑返回的配对状态无效，已停止配对"); }
    public static LanPairingFeedback fromBootstrap(JSONObject value) throws IOException {
        if (!value.has("feedback")) return null;
        try {
            JSONObject feedback=value.getJSONObject("feedback");
            Object protocol=feedback.get("protocol"), expires=value.get("expires");
            if (feedback.length()!=2 || !integer(protocol) || ((Number)protocol).longValue()!=1 ||
                    !token(feedback.get("receipt")) || !token(value.get("id")) || !integer(expires) || ((Number)expires).longValue()<=0) throw invalid();
            return new LanPairingFeedback(value.getString("id"),feedback.getString("receipt"),((Number)expires).longValue());
        } catch (org.json.JSONException error) { throw invalid(); }
    }
    public JSONObject query() throws IOException {
        try { return new JSONObject().put("id",id).put("receipt",receipt); }
        catch (org.json.JSONException error) { throw invalid(); }
    }
    public void observe(JSONObject value) throws IOException {
        final String state;
        try {
            Object protocol=value.get("protocol"), expiration=value.get("expires");
            if (value.length()!=5 || !integer(protocol) || ((Number)protocol).longValue()!=1 ||
                    !id.equals(value.get("id")) || !receipt.equals(value.get("receipt")) || !integer(expiration) ||
                    ((Number)expiration).longValue()!=expires || !(value.get("state") instanceof String)) throw invalid();
            state=value.getString("state");
        } catch (org.json.JSONException error) { throw invalid(); }
        switch (state) {
            case "waiting": case "approving": case "handshake": return;
            case "rejected": throw new IOException("电脑已拒绝本次配对，可重新发起请求");
            case "expired": throw new IOException("配对请求已过期，请重新发起");
            case "cancelled": throw new IOException("电脑已结束本次配对，请重新发起");
            default: throw invalid();
        }
    }
}
