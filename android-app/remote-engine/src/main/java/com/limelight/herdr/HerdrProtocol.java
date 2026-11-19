package com.limelight.herdr;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

/** Bounded Herdr protocol: catalog IDs, idempotent creation, and terminal input. */
public final class HerdrProtocol {
    private HerdrProtocol() {}
    public static final long MAX = 9007199254740991L;
    public static void require(boolean value) throws JSONException {
        if (!value) throw new JSONException("HERDR_INVALID_RESPONSE");
    }
    public static boolean id(String value) { return value != null && value.matches("[0-9a-f]{32}"); }
    public static boolean agentId(String value){return value!=null&&value.matches("[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}");}
    public static String newId() { return UUID.randomUUID().toString().replace("-", ""); }
    private static long number(JSONObject value, String key) throws JSONException {
        Object raw = value.get(key);
        require(raw instanceof Integer || raw instanceof Long);
        return ((Number) raw).longValue();
    }
    public static JSONObject request(String op, String instance, String id) throws JSONException {
        return new JSONObject().put("op", op).put("instance", instance).put("id", id);
    }
    public static final class Terminal {
        public final long turn,createdMs,updatedMs;
        public final boolean unread;
        public final String address, title, cwd, state, status, program, projectId, projectName, agent, agentName;
        public Terminal(JSONObject value) throws JSONException {
            address = value.getString("address");
            require(!address.isEmpty() && address.length() <= 256);
            String name = value.optString("name", "");
            title = !name.isEmpty() ? name : value.optString("title", "");
            cwd = value.optString("cwd", "");
            state = value.getString("state");
            program = value.optString("program", "");
            projectId = value.optString("projectId", "");
            projectName = value.optString("projectName", folderName(cwd));
            agent = value.optString("agent", "");
            agentName = value.optString("agentName", "终端");
            JSONObject report = value.optJSONObject("status");
            status = report == null ? "" : report.optString("state", "");
            turn = value.has("turn") ? number(value,"turn") : 0;
            createdMs = value.has("createdMs") ? number(value,"createdMs") : 0;
            updatedMs = value.has("updatedMs") ? number(value,"updatedMs") : createdMs;
            unread = value.optBoolean("unread",false);
            require(title.length() <= 16384 && cwd.length() <= 32768 && program.length() <= 4096 && projectId.length()<=128 && projectName.length()<=32768 && agentName.length()<=128);
        }
        public String label() { return !title.isEmpty() ? title : !program.isEmpty() ? program : address; }
        public String projectLabel() { return projectName.isEmpty()?folderName(cwd):projectName; }
        public String group() { return projectId.isEmpty()?"folder:"+cwd:projectId; }
    }
    public static String folderName(String path) {
        String clean=path.replace('\\','/').replaceAll("/+$", "");
        if(clean.isEmpty())return "未归属项目";
        return clean.substring(clean.lastIndexOf('/')+1);
    }
    public static final class Project {
        public final String id,name,folder,reason;
        public final boolean available;
        public Project(JSONObject value) throws JSONException {
            id=value.getString("id");folder=value.getString("folder");name=value.optString("name",folderName(folder));
            available=value.getBoolean("available");reason=value.optString("reason", "");
            require(!id.isEmpty()&&id.length()<=128&&folder.length()<=32768&&name.length()<=32768);
        }
    }
    public static final class Agent {
        public final String id,name,reason,source,command;
        public final boolean available;
        public Agent(JSONObject value) throws JSONException {
            id=value.getString("id");name=value.getString("name");available=value.getBoolean("available");reason=value.optString("reason", "");
            source=value.optString("source", "detected");command=value.optString("command",id);
            require(agentId(id)&&name.length()<=128&&reason.length()<=1024&&source.length()<=32&&command.length()<=128);
        }
    }
    public static JSONObject create(String core,String project,String agent,String name) throws JSONException {
        require(!project.isEmpty()&&project.length()<=128&&agentId(agent)&&name.length()<=80);
        for(int i=0;i<name.length();i++)require(!Character.isISOControl(name.charAt(i)));
        // Creation is independent of the worker instance so the same request
        // can be reconciled after a host restart without starting it again.
        return new JSONObject().put("op","create").put("id",newId()).put("coreSession",core).put("project",project).put("agent",agent).put("name",name.trim());
    }
    public static JSONObject close(String instance,String core,String coreId,Terminal terminal) throws JSONException {
        require(id(instance)&&!coreId.isEmpty()&&coreId.length()<=128&&terminal.address.matches("t[0-9a-z]{1,63}")&&terminal.createdMs>0&&terminal.createdMs<MAX);
        return request("close",instance,newId()).put("coreSession",core).put("coreId",coreId).put("terminal",terminal.address).put("createdMs",terminal.createdMs);
    }
    public static final class Reply {
        public final String instance;
        public final JSONObject result;
        public Reply(JSONObject request, JSONObject value) throws JSONException {
            require(value.has("ok") && value.get("ok") instanceof Boolean);
            if (!value.getBoolean("ok")) throw new JSONException(value.optString("code", "HERDR_UNAVAILABLE"));
            instance = value.getString("instance");
            require(id(instance));
            if (request.has("instance")) require(instance.equals(request.getString("instance")));
            result = value.getJSONObject("result");
            if (request.has("id")) require(request.getString("id").equals(result.getString("id")));
        }
        public List<Terminal> terminals() throws JSONException {
            JSONArray values = result.getJSONArray("terminals");
            require(values.length() <= 1024);
            List<Terminal> result = new ArrayList<>();
            java.util.HashSet<String> unique = new java.util.HashSet<>();
            for (int i = 0; i < values.length(); i++) {
                Terminal terminal = new Terminal(values.getJSONObject(i));
                require(unique.add(terminal.address));
                result.add(terminal);
            }
            return result;
        }
        public List<Project> projects() throws JSONException {
            JSONArray values=result.optJSONArray("projects");List<Project> list=new ArrayList<>();if(values==null)return list;
            require(values.length()<=1024);java.util.HashSet<String> ids=new java.util.HashSet<>();
            for(int i=0;i<values.length();i++){Project p=new Project(values.getJSONObject(i));require(ids.add(p.id));list.add(p);}return list;
        }
        public List<Agent> agents() throws JSONException {
            JSONArray values=result.optJSONArray("agents");List<Agent> list=new ArrayList<>();if(values==null)return list;
            require(values.length()<=128);java.util.HashSet<String> ids=new java.util.HashSet<>();
            for(int i=0;i<values.length();i++){Agent a=new Agent(values.getJSONObject(i));require(ids.add(a.id));list.add(a);}return list;
        }
    }
    public static final class Chunk {
        public final String kind;
        public final byte[] data;
        public final int columns, rows;
        public Chunk(JSONObject value) throws JSONException {
            kind = value.getString("kind");
            columns = value.optInt("columns"); rows = value.optInt("rows");
            require(kind.equals("data") || kind.equals("resize") || kind.equals("end"));
            if (kind.equals("resize")) dimensions(columns, rows);
            byte[] decoded = new byte[0];
            if (kind.equals("data")) {
                String encoded = value.getString("data");
                try { decoded = Base64.getDecoder().decode(encoded); }
                catch (IllegalArgumentException e) { throw new JSONException("HERDR_INVALID_RESPONSE"); }
                require(decoded.length <= 8192 && Base64.getEncoder().encodeToString(decoded).equals(encoded));
            }
            data = decoded;
        }
    }
    public static void dimensions(int columns, int rows) throws JSONException {
        require(columns >= 1 && columns <= 1000 && rows >= 1 && rows <= 500);
    }
    public static final class Watch {
        public final String instance, id, terminal, core;
        public long after, accepted;
        public JSONObject pending;
        public boolean attached;
        public String state = "live", inputCode = "";
        public Watch(String instance, String core, String terminal) {
            this.instance = instance; this.core = core; this.terminal = terminal; this.id = newId();
        }
        public JSONObject attach() throws JSONException {
            return request("watch", instance, id).put("coreSession", core).put("terminal", terminal);
        }
        public JSONObject read() throws JSONException { return request("read", instance, id).put("after", after); }
        public void send(String text) throws JSONException {
            require(pending == null && attached && state.equals("live") && accepted < MAX);
            require(!text.isEmpty() && text.getBytes(StandardCharsets.UTF_8).length <= 16384);
            for (int i=0; i<text.length(); i++) {
                char c=text.charAt(i);
                require(!(Character.isISOControl(c) && c!='\r' && c!='\n' && c!='\t'));
                if(Character.isHighSurrogate(c)){require(i+1<text.length() && Character.isLowSurrogate(text.charAt(++i)));}
                else require(!Character.isLowSurrogate(c));
            }
            pending = request("send", instance, id).put("sequence", accepted + 1).put("text", text);
        }
        public void key(String key) throws JSONException {
            require(pending == null && attached && state.equals("live") && accepted < MAX);
            require(key != null && key.matches("(?:enter|esc|tab|backspace|delete|up|down|left|right|home|end|pageup|pagedown|shift\\+left|[a-z0-9]|ctrl\\+[a-z])"));
            pending = request("keys", instance, id).put("sequence", accepted + 1).put("keys", new JSONArray().put(key));
        }
        public void acknowledge(JSONObject value) throws JSONException {
            long sequence = number(value, "accepted");
            require(sequence >= accepted && sequence <= MAX);
            if (pending != null) require(sequence == pending.getLong("sequence"));
            else require(sequence == accepted);
            accepted = sequence;
            inputCode = value.optString("inputCode", "");
            pending = null;
        }
        public List<Chunk> consume(JSONObject value) throws JSONException {
            long next = number(value, "next");
            JSONArray values = value.getJSONArray("chunks");
            require(next >= after && next < MAX && values.length() <= 2048 && next == after + values.length());
            List<Chunk> chunks = new ArrayList<>();
            int size = 0;
            for(int i=0; i<values.length(); i++) {
                JSONObject raw=values.getJSONObject(i);
                require(number(raw, "sequence") == after + i + 1);
                Chunk chunk=new Chunk(raw); size+=chunk.data.length; chunks.add(chunk);
            }
            require(size <= 49152);
            String current=value.getString("state");
            require(current.equals("live") || current.equals("finished") || current.equals("disconnected"));
            after=next; state=current;
            return chunks;
        }
    }
}
