package com.limelight.nvstream;

import org.json.JSONObject;
import org.json.JSONException;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/** Only plain Unicode text or a bounded PNG can cross the paired clipboard API. */
public final class ClipboardData {
    public static final int TEXT_LIMIT=1024*1024, IMAGE_LIMIT=8*1024*1024, MESSAGE_LIMIT=12*1024*1024;
    public final String text;
    public final byte[] png;
    private ClipboardData(String text,byte[] png) { this.text=text; this.png=png; }
    public static ClipboardData text(String text) throws JSONException {
        if (text==null || text.isEmpty() || text.length()>TEXT_LIMIT || text.indexOf(0)>=0) throw new JSONException("Invalid clipboard text");
        try {
            if (StandardCharsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
                    .encode(CharBuffer.wrap(text)).remaining()>TEXT_LIMIT) throw new JSONException("Clipboard text too large");
        } catch (java.nio.charset.CharacterCodingException e) { throw new JSONException("Invalid Unicode text"); }
        return new ClipboardData(text,null);
    }
    public static ClipboardData png(byte[] bytes) throws JSONException {
        if (bytes==null || bytes.length<33 || bytes.length>IMAGE_LIMIT) throw new JSONException("Invalid PNG size");
        ByteBuffer header=ByteBuffer.wrap(bytes);
        if (header.getLong()!=0x89504e470d0a1a0aL || header.getInt()!=13 || header.getInt()!=0x49484452) throw new JSONException("Invalid PNG header");
        int width=header.getInt(),height=header.getInt();
        if (width<=0 || height<=0 || width>4096 || height>4096 || (long)width*height>6000000) throw new JSONException("Invalid PNG dimensions");
        return new ClipboardData(null,bytes.clone());
    }
    public JSONObject request(String id) throws JSONException {
        if (id==null || !id.matches("[0-9a-f]{32}")) throw new JSONException("Invalid clipboard request ID");
        JSONObject value=new JSONObject().put("op","write").put("id",id).put("kind",text!=null?"text":"png");
        return text!=null?value.put("text",text):value.put("data",Base64.getEncoder().encodeToString(png));
    }
    public static ClipboardData parse(JSONObject value) throws JSONException {
        if (!Boolean.TRUE.equals(value.opt("ok"))) throw new JSONException("Clipboard request failed");
        if ("text".equals(value.opt("kind")) && value.opt("text") instanceof String && value.optString("data","").isEmpty())
            return text(value.getString("text"));
        if ("png".equals(value.opt("kind")) && value.opt("data") instanceof String && value.optString("text","").isEmpty()) {
            String data=value.getString("data");
            if (data.length()>11184812) throw new JSONException("Clipboard image too large");
            try { return png(Base64.getDecoder().decode(data)); }
            catch (IllegalArgumentException e) { throw new JSONException("Invalid clipboard image"); }
        }
        throw new JSONException("Unsupported clipboard content");
    }
}
