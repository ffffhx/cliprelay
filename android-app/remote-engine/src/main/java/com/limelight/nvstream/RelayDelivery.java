package com.limelight.nvstream;

import org.json.JSONObject;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Iterator;

/** Receiver protocol with durable, content-bound receipts; never reads a local clipboard. */
public final class RelayDelivery {
    public interface Transport { JSONObject request(JSONObject request) throws Exception; }
    public interface Receipts {
        // empty = unseen; pending = outcome uncertain; applied = safe to acknowledge again.
        String state(String id, String hash) throws Exception;
        void save(String id, String hash, String state) throws Exception;
    }
    public interface Sink { void receive(String kind, byte[] bytes, String text) throws Exception; }
    public interface Active { boolean get(); }

    private RelayDelivery() {}

    public static void receive(JSONObject meta, Transport transport, Receipts receipts, Sink sink, Active active) throws Exception {
        if (!Boolean.TRUE.equals(meta.opt("ok"))) throw new IOException("RELAY_BAD_REPLY");
        if ("idle".equals(meta.optString("state"))) return;
        String id = meta.getString("id"), hash = meta.getString("sha256"), kind = meta.getString("kind");
        Object sizeValue = meta.get("size");
        if (!"queued".equals(meta.getString("state")) || !id.matches("[0-9a-f]{32}") || !hash.matches("[0-9a-f]{64}") ||
                !(sizeValue instanceof Integer) || !("json".equals(kind) || "jpeg".equals(kind))) throw new IOException("RELAY_BAD_REPLY");
        int size = (Integer) sizeValue;
        if (size < 1 || size > ("json".equals(kind) ? 1024 * 1024 : 25 * 1024 * 1024)) throw new IOException("RELAY_BAD_REPLY");
        if (!active.get()) throw new InterruptedException();
        String receipt = receipts.state(id, hash);
        if ("applied".equals(receipt)) { ack(transport, id, hash, active); return; }
        if (!receipt.isEmpty()) { reject(transport, id, active); return; }
        byte[] body = new byte[size];
        for (int offset = 0; offset < size;) {
            if (!active.get()) throw new InterruptedException();
            JSONObject chunk = transport.request(new JSONObject().put("op", "read").put("id", id).put("offset", offset));
            if (!Boolean.TRUE.equals(chunk.opt("ok")) || !id.equals(chunk.getString("id")) ||
                    (chunk.has("offset") ? chunk.getInt("offset") : 0) != offset) throw new IOException("RELAY_BAD_REPLY");
            String encoded = chunk.getString("data");
            if (encoded.length() > 349528) throw new IOException("RELAY_BAD_REPLY");
            byte[] bytes;
            try { bytes = Base64.getDecoder().decode(encoded); }
            catch (IllegalArgumentException e) { throw new IOException("RELAY_BAD_REPLY", e); }
            if (!Base64.getEncoder().encodeToString(bytes).equals(encoded) || bytes.length == 0 || bytes.length > 256 * 1024 || bytes.length > size - offset)
                throw new IOException("RELAY_BAD_REPLY");
            System.arraycopy(bytes, 0, body, offset, bytes.length); offset += bytes.length;
        }
        if (!sha256(body).equals(hash)) { reject(transport, id, active); throw new IOException("RELAY_HASH_MISMATCH"); }
        String text = null; boolean probe = false;
        try {
            if ("json".equals(kind)) {
                String raw = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(body)).toString();
                JSONObject value = new JSONObject(raw);
                for (Iterator<String> keys = value.keys(); keys.hasNext();) {
                    String key = keys.next(); if (!"text".equals(key) && !"probe".equals(key)) throw new IOException("RELAY_BAD_PAYLOAD");
                }
                if (!(value.get("text") instanceof String) || (value.has("probe") && !(value.get("probe") instanceof Boolean))) throw new IOException("RELAY_BAD_PAYLOAD");
                text = value.getString("text"); ClipboardData.text(text);
                probe = value.optBoolean("probe", false);
            } else if (body.length < 4 || (body[0] & 255) != 255 || (body[1] & 255) != 216) throw new IOException("RELAY_BAD_PAYLOAD");
        } catch (Exception e) { reject(transport, id, active); throw e; }
        if (!active.get()) throw new InterruptedException();
        if (!probe) {
            try { receipts.save(id, hash, "pending"); }
            catch (Exception e) { reject(transport, id, active); throw e; }
            if (!active.get()) throw new InterruptedException();
            try {
                sink.receive(kind, body, text);
                receipts.save(id, hash, "applied");
            } catch (Exception e) {
                // Keep pending: a retry must not overwrite a newer local clipboard
                // when a crash or partial failure makes the first outcome unknown.
                reject(transport, id, active); throw e;
            }
        }
        ack(transport, id, hash, active);
    }

    public static String sha256(byte[] bytes) {
        try { byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes); StringBuilder value = new StringBuilder(64);
            for (byte b : digest) value.append(String.format(java.util.Locale.ROOT, "%02x", b & 255)); return value.toString();
        } catch (java.security.NoSuchAlgorithmException e) { throw new AssertionError(e); }
    }
    private static void reject(Transport transport, String id, Active active) throws Exception {
        if (active.get()) transport.request(new JSONObject().put("op", "reject").put("id", id));
    }
    private static void ack(Transport transport, String id, String hash, Active active) throws Exception {
        if (!active.get()) throw new InterruptedException();
        JSONObject result = transport.request(new JSONObject().put("op", "ack").put("id", id).put("sha256", hash));
        if (!Boolean.TRUE.equals(result.opt("ok")) || !id.equals(result.optString("id")) || !"delivered".equals(result.optString("state"))) throw new IOException("RELAY_BAD_REPLY");
    }
}
