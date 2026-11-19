package com.cliprelay.app;

import com.limelight.herdr.HerdrProtocol;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import static org.junit.Assert.*;

public class HerdrTest {
    private static final String INSTANCE = "0123456789abcdef0123456789abcdef";
    @Test public void dynamicAgentMetadataIsAcceptedWithoutAProductAllowlist() throws Exception {
        JSONObject value=new JSONObject().put("id","cli-123abc").put("name","My Agent").put("available",true).put("source","cli").put("command","my-agent");
        HerdrProtocol.Agent agent=new HerdrProtocol.Agent(value);assertEquals("My Agent",agent.name);assertEquals("my-agent",agent.command);
        value.put("id","my-agent --execute");assertThrows(JSONException.class,()->new HerdrProtocol.Agent(value));
    }
    @Test public void closeRequiresStableTerminalIdentityAndRejectsAliases() throws Exception {
        JSONObject raw=new JSONObject().put("address","t1b").put("state","live").put("createdMs",1793768000000L);
        JSONObject close=HerdrProtocol.close(INSTANCE,"default","core-identity",new HerdrProtocol.Terminal(raw));
        assertEquals("close",close.getString("op"));assertEquals("t1b",close.getString("terminal"));
        assertEquals(1793768000000L,close.getLong("createdMs"));assertEquals("core-identity",close.getString("coreId"));
        assertFalse(close.has("text"));assertFalse(close.has("project"));
        for(String address:new String[]{"session-name","remote/t1","t1\n","t1;rm"}){
            raw.put("address",address);assertThrows(JSONException.class,()->HerdrProtocol.close(INSTANCE,"default","core-identity",new HerdrProtocol.Terminal(raw)));
        }
        raw.put("address","t1").remove("createdMs");
        assertThrows(JSONException.class,()->HerdrProtocol.close(INSTANCE,"default","core-identity",new HerdrProtocol.Terminal(raw)));
    }
    @Test public void creationSurvivesWorkerRestartAndRetainsCatalogSelection() throws Exception {
        JSONObject create=HerdrProtocol.create("default","sp-project","claude","中文任务");
        assertFalse(create.has("instance"));assertFalse(create.has("argv"));assertFalse(create.has("cwd"));
        JSONObject persisted=new JSONObject(create.toString());
        JSONObject result=new JSONObject().put("id",create.getString("id"));
        new HerdrProtocol.Reply(persisted,new JSONObject().put("ok",true).put("instance",HerdrProtocol.newId()).put("result",result));
        assertEquals("sp-project",persisted.getString("project"));assertEquals("claude",persisted.getString("agent"));
        assertEquals("gemini",HerdrProtocol.create("default","sp-project","gemini","").getString("agent"));
        assertEquals("cli-abc123",HerdrProtocol.create("default","sp-project","cli-abc123","").getString("agent"));
        assertThrows(JSONException.class,()->HerdrProtocol.create("default","sp-project","powershell -Command exit",""));
        assertThrows(JSONException.class,()->HerdrProtocol.create("default","sp-project","codex","bad\nname"));
    }
    @Test public void projectTitlesAndDirectoryFallbackDoNotUsePowerShell() throws Exception {
        JSONObject raw=new JSONObject().put("address","t1").put("state","live").put("title","powershell.exe")
            .put("cwd","C:\\projects\\中文项目").put("projectId","sp-project").put("projectName","My project").put("agentName","Claude Code");
        HerdrProtocol.Terminal terminal=new HerdrProtocol.Terminal(raw);
        assertEquals("My project",terminal.projectLabel());assertEquals("sp-project",terminal.group());assertEquals("Claude Code",terminal.agentName);
        raw.remove("projectName");assertEquals("中文项目",new HerdrProtocol.Terminal(raw).projectLabel());
    }
    private HerdrProtocol.Watch watch() {
        HerdrProtocol.Watch watch = new HerdrProtocol.Watch(INSTANCE, "default", "term:1");
        watch.attached = true;
        return watch;
    }
    private JSONObject read(long next, JSONArray chunks) throws Exception {
        return new JSONObject().put("next", next).put("chunks", chunks).put("state", "live");
    }
    @Test public void lostReplyKeepsOriginalInputUntilReceiptIsReconciled() throws Exception {
        HerdrProtocol.Watch watch = watch();
        watch.send("你好\nsecond line 🐕");
        String original = watch.pending.toString();
        assertEquals(1, watch.pending.getLong("sequence"));
        assertThrows(JSONException.class, () -> watch.send("a different command"));
        assertEquals(original, watch.pending.toString());
        watch.consume(read(0, new JSONArray())); // reconnect read never invents an acknowledgement
        assertEquals(original, watch.pending.toString());
        watch.acknowledge(new JSONObject().put("accepted", 1));
        assertNull(watch.pending);
        watch.key("ctrl+c");
        assertEquals(2, watch.pending.getLong("sequence"));
    }
    @Test public void unknownOutcomeIsAcknowledgedWithoutAutomaticReplay() throws Exception {
        HerdrProtocol.Watch watch = watch();
        watch.send("run task");
        watch.acknowledge(new JSONObject().put("accepted", 1).put("inputCode", "HERDR_OUTCOME_UNKNOWN"));
        assertNull(watch.pending);
        assertEquals("HERDR_OUTCOME_UNKNOWN", watch.inputCode);
        assertEquals(1, watch.accepted);
    }
    @Test public void wrongReceiptCannotClearPendingInput() throws Exception {
        HerdrProtocol.Watch watch = watch();
        watch.send("once");
        for (Object accepted : new Object[]{0, 2, "1", 1.5}) {
            assertThrows(JSONException.class, () -> watch.acknowledge(new JSONObject().put("accepted", accepted)));
            assertNotNull(watch.pending);
            assertEquals(0, watch.accepted);
        }
    }
    @Test public void restartedWorkerAndDifferentWatchCannotReceiveStaleInput() throws Exception {
        HerdrProtocol.Watch watch = watch();
        JSONObject result = new JSONObject().put("id", watch.id);
        JSONObject reply = new JSONObject().put("ok", true).put("instance", HerdrProtocol.newId()).put("result", result);
        assertThrows(JSONException.class, () -> new HerdrProtocol.Reply(watch.read(), reply));
        reply.put("instance", INSTANCE);
        result.put("id", HerdrProtocol.newId());
        assertThrows(JSONException.class, () -> new HerdrProtocol.Reply(watch.read(), reply));
    }
    @Test public void terminalBytesAndResizeAreConsumedInOrder() throws Exception {
        HerdrProtocol.Watch watch = watch();
        byte[] bytes = "\u001b[31m中文\u001b[0m".getBytes(StandardCharsets.UTF_8);
        JSONArray chunks = new JSONArray()
            .put(new JSONObject().put("sequence", 1).put("kind", "resize").put("columns", 160).put("rows", 48))
            .put(new JSONObject().put("sequence", 2).put("kind", "data").put("data", Base64.getEncoder().encodeToString(bytes)));
        var consumed = watch.consume(read(2, chunks));
        assertEquals(160, consumed.get(0).columns);
        assertArrayEquals(bytes, consumed.get(1).data);
        assertEquals(2, watch.after);
        assertThrows(JSONException.class, () -> watch.consume(read(2, chunks)));
        assertEquals(2, watch.after);
    }
    @Test public void truncatedOrMalformedBatchDoesNotAdvanceCursor() throws Exception {
        HerdrProtocol.Watch watch = watch();
        JSONArray chunks = new JSONArray().put(new JSONObject().put("sequence", 1).put("kind", "data").put("data", "not base64!"));
        assertThrows(JSONException.class, () -> watch.consume(read(1, chunks)));
        assertEquals(0, watch.after);
        chunks.put(0, new JSONObject().put("sequence", 2).put("kind", "resize").put("columns", 80).put("rows", 24));
        assertThrows(JSONException.class, () -> watch.consume(read(1, chunks)));
        assertEquals(0, watch.after);
    }
    @Test public void inputBoundsRejectControlSequencesAndInvalidUnicode() throws Exception {
        for (String text : new String[]{"", "\u001b[2J", "\u0000", "\uD800", "\uDC00", "中".repeat(5462)}) {
            HerdrProtocol.Watch watch = watch();
            assertThrows(JSONException.class, () -> watch.send(text));
            assertNull(watch.pending);
        }
        assertThrows(JSONException.class, () -> watch().key("exec"));
        HerdrProtocol.Watch finished = watch();
        finished.consume(read(0, new JSONArray()).put("state", "finished"));
        assertThrows(JSONException.class, () -> finished.send("after exit"));
    }
    @Test public void shiftLeftIsOneIdempotentChord() throws Exception {
        var watch=watch();watch.key("shift+left");
        assertEquals("keys",watch.pending.getString("op"));
        assertEquals("shift+left",watch.pending.getJSONArray("keys").getString(0));
        assertEquals(1,watch.pending.getJSONArray("keys").length());
        assertThrows(JSONException.class,()->watch.key("shift+left"));
        watch.acknowledge(new JSONObject().put("accepted",1));
        watch.key("enter");assertEquals(2,watch.pending.getLong("sequence"));
        for(String key:new String[]{"shift+","shift+left\n","ctrl+shift+left","shift+exec"})assertThrows(JSONException.class,()->watch().key(key));
    }
}
