package com.limelight.terminal;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.IOException;
import java.util.*;

/** Strict, bounded terminal wire format. No command or output is persisted. */
public final class TerminalProtocol {
    private TerminalProtocol() {}
    public static final long MAX = 9007199254740991L;
    public static final class Mouse {
        public final int mode,format,buttons;
        public final long epoch,offset,gesture,nextGesture,accepted,written,remainingMs;
        public final String phase,outcome;
        public Mouse(JSONObject value,long end) throws JSONException {
            mode=(int)number(value,"mode",-1,1003);format=(int)number(value,"format",-1,1016);
            require(Arrays.asList(-1,0,9,1000,1001,1002,1003).contains(mode));
            require(Arrays.asList(-1,0,1005,1006,1015,1016).contains(format));
            epoch=number(value,"epoch",1,MAX);offset=number(value,"offset",0,end);
            gesture=number(value,"gesture",0,MAX);nextGesture=number(value,"nextGesture",gesture+1,MAX);
            accepted=number(value,"acceptedSequence",0,MAX);written=number(value,"writtenSequence",0,accepted);
            buttons=(int)number(value,"buttons",0,7);remainingMs=number(value,"remainingMs",0,1500);
            phase=text(value,"phase");outcome=text(value,"outcome");
            require(Arrays.asList("idle","pending","held","expired","cancelled","mode-changed","closed").contains(phase));
            require(Arrays.asList("none","queued","written","renewed","cancelled","expired","mode-changed").contains(outcome));
            require(!phase.equals("closed") || buttons==0 && remainingMs==0);
        }
        public boolean available(){return (mode==9 || mode==1000 || mode==1002 || mode==1003) && format>=0;}
    }
    public static final class Session {
        public final String id, shell, state;
        public final int columns, rows, exitCode;
        public final long openSequence, accepted, written, start, end, remainingMs;
        public final Mouse mouse;
        public Session(JSONObject value) throws JSONException {
            id = id(value, "id"); shell = text(value,"shell"); state = text(value,"state");
            require(shell.equals("cmd") || shell.equals("powershell"));
            require(Arrays.asList("running","closed","exited","failed","expired","revoked").contains(state));
            columns=(int)number(value,"columns",20,240); rows=(int)number(value,"rows",5,120);
            exitCode=(int)number(value,"exitCode",Integer.MIN_VALUE,Integer.MAX_VALUE);
            openSequence=number(value,"openSequence",1,MAX); accepted=number(value,"acceptedSequence",0,MAX);
            written=number(value,"writtenSequence",0,accepted);
            start=number(value,"start",0,MAX); end=number(value,"end",start,MAX);
            require(end-start<=1048576); remainingMs=number(value,"remainingMs",0,1800000);
            mouse=value.isNull("mouse")?null:new Mouse(value.getJSONObject("mouse"),end);
        }
        public boolean running(){return state.equals("running");}
    }
    public static final class Reply {
        public final String instance;
        public final List<Session> sessions;
        public final Session session;
        public final long nextOpen, offset, next;
        public final boolean gap;
        public final byte[] data;
        public final int mouseProtocol;
        public Reply(JSONObject request, JSONObject value) throws JSONException {
            require(Boolean.TRUE.equals(value.get("ok"))); instance=id(value,"instance");
            String op=text(request,"op");
            if (!op.equals("list")) require(instance.equals(request.getString("instance")));
            ArrayList<Session> list=new ArrayList<>();
            if(op.equals("list")) {
                mouseProtocol=value.has("mouseProtocol")?(int)number(value,"mouseProtocol",0,1):0;
                nextOpen=number(value,"nextOpen",1,MAX);
                JSONArray array=value.has("sessions")?value.getJSONArray("sessions"):new JSONArray(); require(array.length()<=32);
                Set<String> ids=new HashSet<>(); Set<Long> sequences=new HashSet<>();
                for(int i=0;i<array.length();i++) {
                    Session item=new Session(array.getJSONObject(i));
                    require(mouseProtocol!=1 || item.mouse!=null);
                    require(ids.add(item.id) && sequences.add(item.openSequence) && item.openSequence<nextOpen); list.add(item);
                }
                session=null;
            } else {
                mouseProtocol=0;
                nextOpen=0; session=new Session(value.getJSONObject("session"));
                require(session.id.equals(request.getString("id")));
                if(op.equals("open")) require(session.openSequence==request.getLong("sequence") && session.shell.equals(request.getString("shell")));
                if(op.equals("write")) require(session.accepted==request.getLong("sequence"));
                if(op.equals("mouse")) require(session.mouse!=null && session.mouse.accepted==request.getLong("sequence"));
                if(op.equals("resize")) require(session.columns==request.getInt("columns") && session.rows==request.getInt("rows"));
            }
            sessions=Collections.unmodifiableList(list);
            if(op.equals("read")) {
                offset=number(value,"offset",0,MAX); next=number(value,"next",offset,MAX);
                require(value.get("gap") instanceof Boolean); gap=value.getBoolean("gap");
                String encoded=value.has("data")?text(value,"data"):""; require(encoded.length()<=43692);
                try { data=Base64.getDecoder().decode(encoded); } catch(IllegalArgumentException e){throw new JSONException("TERMINAL_INVALID_RESPONSE");}
                require(data.length<=32768 && Base64.getEncoder().encodeToString(data).equals(encoded));
                long requested=request.getLong("offset");
                require(offset>=requested && gap==(offset!=requested) && next-offset==data.length && next<=session.end);
            } else {offset=next=0;gap=false;data=new byte[0];}
        }
        public Session find(String id){for(Session item:sessions)if(item.id.equals(id))return item;return null;}
    }
    public static JSONObject request(String op, String instance, String id) throws JSONException {
        JSONObject result=new JSONObject().put("op",op);
        if(!op.equals("list")){require(instance!=null && instance.matches("[0-9a-f]{32}") && id!=null && id.matches("[0-9a-f]{32}"));result.put("instance",instance).put("id",id);}
        return result;
    }
    public static JSONObject list() throws JSONException {return request("list",null,null);}
    public static void checkHttp(int status, JSONObject body) throws IOException {
        if(status==200 && Boolean.TRUE.equals(body.opt("ok")))return;
        String code=body.optString("code","");
        String allowed="TERMINAL_(BUSY|CAPACITY|UNPAIRED|STALE|NOT_FOUND|CLOSED|OFFSET|SEQUENCE|ID_CONFLICT|INPUT_CONFLICT|MOUSE_MODE|MOUSE_GESTURE|MOUSE_SEQUENCE|MOUSE_CONFLICT|USER_REQUIRED|UNSUPPORTED|UNAVAILABLE|INVALID_RESPONSE|BAD_REQUEST)";
        if(code.matches(allowed))throw new IOException(code);
        throw new IOException(status==404?"TERMINAL_UNSUPPORTED":status==403?"TERMINAL_UNPAIRED":"TERMINAL_UNAVAILABLE");
    }
    static String text(JSONObject object,String key) throws JSONException {Object value=object.get(key);require(value instanceof String);return (String)value;}
    static String id(JSONObject value,String key) throws JSONException {String result=text(value,key);require(result.matches("[0-9a-f]{32}"));return result;}
    static long number(JSONObject value,String key,long min,long max) throws JSONException {
        Object n=value.get(key);require(n instanceof Integer || n instanceof Long);long result=((Number)n).longValue();require(result>=min && result<=max);return result;
    }
    static void require(boolean condition) throws JSONException {if(!condition)throw new JSONException("TERMINAL_INVALID_RESPONSE");}
}
