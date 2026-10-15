package com.limelight.terminal;

import org.json.*;
import java.util.*;

/** Main-thread state. An uncertain write retains its exact bytes and sequence. */
public final class TerminalSessionState {
    public final String instance, id;
    public TerminalProtocol.Session snapshot;
    public long offset;
    private final ArrayDeque<byte[]> queued=new ArrayDeque<>();
    private int queuedBytes;
    private JSONObject pending;
    public TerminalSessionState(String instance,TerminalProtocol.Session session){this.instance=instance;id=session.id;snapshot=session;}
    public boolean enqueue(byte[] bytes) {
        if(!snapshot.running() || bytes.length==0 || bytes.length>16384 || queuedBytes+bytes.length>32768)return false;
        for(int i=0;i<bytes.length;i+=4096)queued.add(Arrays.copyOfRange(bytes,i,Math.min(bytes.length,i+4096)));
        queuedBytes+=bytes.length;return true;
    }
    public boolean hasInput(){return pending!=null || !queued.isEmpty();}
    public boolean uncertain(){return pending!=null;}
    public JSONObject write() throws JSONException {
        if(pending==null && !queued.isEmpty()) {
            TerminalProtocol.require(snapshot.accepted<TerminalProtocol.MAX);
            pending=TerminalProtocol.request("write",instance,id).put("sequence",snapshot.accepted+1)
                    .put("data",Base64.getEncoder().encodeToString(queued.peek()));
        }
        return pending==null?null:new JSONObject(pending.toString());
    }
    public void acknowledge(TerminalProtocol.Reply reply) throws JSONException {
        TerminalProtocol.require(pending!=null && reply.instance.equals(instance) && reply.session.id.equals(id) && reply.session.accepted==pending.getLong("sequence"));
        queuedBytes-=queued.remove().length;pending=null;snapshot=reply.session;
    }
    public void refresh(String actualInstance,TerminalProtocol.Session session) throws JSONException {
        TerminalProtocol.require(instance.equals(actualInstance) && id.equals(session.id) && session.accepted>=snapshot.accepted && session.written>=snapshot.written);
        if(pending!=null)TerminalProtocol.require(session.accepted==pending.getLong("sequence") || session.accepted==pending.getLong("sequence")-1);
        snapshot=session;
    }
    /** Backgrounding discards never-sent keystrokes; retain only an uncertain request for dedup retry. */
    public boolean discardUnsent() {
        byte[] first=pending!=null?queued.peek():null;
        boolean discarded=queued.size()>(first==null?0:1);queued.clear();queuedBytes=0;
        if(first!=null){queued.add(first);queuedBytes=first.length;}return discarded;
    }
    public JSONObject read() throws JSONException {return TerminalProtocol.request("read",instance,id).put("offset",offset);}
    public void consume(TerminalProtocol.Reply reply) throws JSONException {
        TerminalProtocol.require(reply.instance.equals(instance) && reply.session.id.equals(id) && reply.offset>=offset && reply.gap==(reply.offset!=offset));
        refresh(reply.instance,reply.session);offset=reply.next;
    }
}
