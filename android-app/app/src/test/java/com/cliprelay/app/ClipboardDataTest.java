package com.cliprelay.app;

import com.limelight.nvstream.ClipboardData;
import org.json.JSONObject;
import org.json.JSONException;
import org.junit.Test;
import java.nio.ByteBuffer;
import java.util.Base64;
import static org.junit.Assert.*;

public class ClipboardDataTest {
    private static final String ID="0123456789abcdef0123456789abcdef";
    private static byte[] png() { return Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH20AAAAASUVORK5CYII="); }
    private interface Invalid { void run() throws Exception; }
    private static void rejects(Invalid work) throws Exception { try {work.run(); fail("Invalid clipboard accepted");} catch(JSONException expected){} }
    @Test public void unicodeTextIsPreservedAcrossRequestsAndReplies() throws Exception {
        String text="中文 👩‍💻\nquoted \" < > &";
        JSONObject request=ClipboardData.text(text).request(ID);
        assertEquals("write",request.getString("op")); assertEquals(ID,request.getString("id"));
        assertEquals(text,request.getString("text")); assertFalse(request.has("owner"));
        assertEquals(text,ClipboardData.parse(new JSONObject().put("ok",true).put("kind","text").put("text",text)).text);
    }
    @Test public void textBoundsUseUtf8AndRejectInvalidUnicode() throws Exception {
        rejects(()->ClipboardData.text("")); rejects(()->ClipboardData.text("bad\0value"));
        rejects(()->ClipboardData.text("\ud800"));
        char[] large=new char[ClipboardData.TEXT_LIMIT/3+1]; java.util.Arrays.fill(large,'中');
        rejects(()->ClipboardData.text(new String(large)));
        rejects(()->ClipboardData.text("value").request("bad-id"));
    }
    @Test public void pngBytesSurviveAndDimensionsAreBounded() throws Exception {
        byte[] original=png(); ClipboardData value=ClipboardData.png(original);
        original[0]=0; assertEquals((byte)0x89,value.png[0]);
        JSONObject reply=value.request(ID).put("ok",true);
        assertArrayEquals(png(),ClipboardData.parse(reply).png);
        byte[] oversized=png(); ByteBuffer.wrap(oversized).putInt(16,5000);
        rejects(()->ClipboardData.png(oversized)); rejects(()->ClipboardData.png(new byte[32]));
        byte[] manyPixels=png(); ByteBuffer.wrap(manyPixels).putInt(16,4096).putInt(20,4096);
        rejects(()->ClipboardData.png(manyPixels));
    }
    @Test public void remoteDataCannotCoerceTypesOrIntroduceOtherFormats() throws Exception {
        rejects(()->ClipboardData.parse(new JSONObject("{\"ok\":\"true\",\"kind\":\"text\",\"text\":\"x\"}")));
        rejects(()->ClipboardData.parse(new JSONObject("{\"ok\":true,\"kind\":\"text\",\"text\":123}")));
        rejects(()->ClipboardData.parse(new JSONObject("{\"ok\":true,\"kind\":\"html\",\"text\":\"<script>\"}")));
        rejects(()->ClipboardData.parse(new JSONObject("{\"ok\":true,\"kind\":\"text\",\"text\":\"x\",\"data\":\"extra\"}")));
        rejects(()->ClipboardData.parse(new JSONObject("{\"ok\":true,\"kind\":\"png\",\"data\":\"bad!\"}")));
    }
}
