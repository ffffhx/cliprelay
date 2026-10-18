package com.limelight.terminal;

import java.util.*;
import java.util.function.LongSupplier;
import org.json.*;

/** Main-thread typed mouse queue. Network activity never renews foreground evidence. */
public final class TerminalMouseState {
    public static final class Event {
        public final String action;
        public final long epoch,revision;
        public final int column,row,button,modifiers;
        public Event(String action,long epoch,long revision,int column,int row,int button,int modifiers){
            this.action=action;this.epoch=epoch;this.revision=revision;this.column=column;this.row=row;this.button=button;this.modifiers=modifiers;
        }
    }
    private static final class Queued {
        final Event event;final long gesture,created;
        Queued(Event event,long gesture,long created){this.event=event;this.gesture=gesture;this.created=created;}
    }
    public TerminalProtocol.Mouse snapshot;
    private final LongSupplier clock;
    private final ArrayDeque<Queued> queue=new ArrayDeque<>();
    private JSONObject pending;
    private long gesture,lastBeat=Long.MIN_VALUE,lastSent=Long.MIN_VALUE;
    private int buttons;
    private long revision;
    private boolean abandoned,cancelWanted;
    public TerminalMouseState(TerminalProtocol.Mouse snapshot,LongSupplier clock){this.snapshot=snapshot;this.clock=clock;}
    public long revision(){return revision;}
    public int buttons(){return buttons;}
    public boolean busy(){return pending!=null || !queue.isEmpty() || buttons!=0 || cancelWanted;}
    public boolean cancelling(){return cancelWanted;}
    private static void check(boolean ok,String code) throws JSONException {if(!ok)throw new JSONException(code);}
    private static boolean due(long now,long then,long delay){return then==Long.MIN_VALUE || now-then>=delay;}
    public void stop(){
        queue.clear();buttons=0;lastBeat=Long.MIN_VALUE;abandoned=true;revision++;
        cancelWanted=gesture!=0 || snapshot!=null && (snapshot.buttons!=0 || snapshot.remainingMs!=0);
    }
    public void refresh(TerminalProtocol.Mouse next) throws JSONException {
        if(next!=null && snapshot!=null)TerminalProtocol.require(next.epoch>=snapshot.epoch && next.accepted>=snapshot.accepted && next.written>=snapshot.written);
        if(pending!=null && next!=null)check(next.accepted<=pending.getLong("sequence"),"TERMINAL_MOUSE_SEQUENCE");
        boolean changed=(snapshot==null?0:snapshot.epoch)!=(next==null?0:next.epoch);
        boolean ended=next!=null && gesture!=0 && Arrays.asList("expired","cancelled","mode-changed","closed").contains(next.phase)
                && (snapshot==null || !next.phase.equals(snapshot.phase) || next.gesture!=snapshot.gesture);
        snapshot=next;
        if(changed || next==null || ended)stop();
        // Inventory reconciles an uncertain request; never retransmit an abandoned press.
        if(abandoned)pending=null;
        if(next!=null && gesture!=0 && next.gesture==gesture && next.buttons==0 && next.remainingMs==0 && queue.isEmpty() && pending==null){gesture=0;cancelWanted=false;}
    }
    public void heartbeat(long expectedRevision) throws JSONException {
        check(expectedRevision==revision && buttons!=0 && !abandoned,"TERMINAL_MOUSE_GESTURE");lastBeat=clock.getAsLong();
    }
    public void enqueue(Event e) throws JSONException {
        TerminalProtocol.Mouse s=snapshot;
        check(s!=null && s.available() && e.epoch==s.epoch,"TERMINAL_MOUSE_MODE");
        check(e.revision==revision,"TERMINAL_MOUSE_GESTURE");
        check(Arrays.asList("press","release","move","wheel").contains(e.action) && e.column>=1 && e.column<=65535 && e.row>=1 && e.row<=65535
                && e.button>=0 && e.button<=((e.action.equals("move") || e.action.equals("wheel"))?3:2) && e.modifiers>=0 && e.modifiers<=28 && e.modifiers%4==0,"TERMINAL_BAD_REQUEST");
        boolean press=e.action.equals("press"),move=e.action.equals("move"),stateless=s.mode==9 || e.action.equals("wheel") || move && e.button==3;
        if(stateless && abandoned){check(pending==null && !cancelWanted && s.buttons==0 && s.remainingMs==0,"TERMINAL_BUSY");abandoned=false;}
        if(move)check(s.mode==1003 || s.mode==1002 && e.button!=3,"TERMINAL_MOUSE_MODE");
        if(s.mode==9)check(press,"TERMINAL_MOUSE_MODE");
        if(move && e.button==3)check(buttons==0 && s.buttons==0,"TERMINAL_MOUSE_GESTURE");
        if(!stateless){
            if(press){
                check((buttons & 1<<e.button)==0,"TERMINAL_MOUSE_GESTURE");
                if(buttons==0){
                    check(!cancelWanted && (gesture!=0 && !abandoned || pending==null && queue.isEmpty() && s.buttons==0 && s.remainingMs==0),"TERMINAL_BUSY");
                    gesture=Math.max(s.nextGesture,gesture!=0?gesture+1:0);check(gesture<TerminalProtocol.MAX,"TERMINAL_MOUSE_GESTURE");abandoned=false;
                }
                buttons|=1<<e.button;
            } else {
                check(!abandoned && gesture!=0 && (buttons & 1<<e.button)!=0,"TERMINAL_MOUSE_GESTURE");
                if(e.action.equals("release"))buttons&=~(1<<e.button);
            }
            lastBeat=clock.getAsLong();
        }
        Queued item=new Queued(e,stateless?0:gesture,clock.getAsLong()),previous=queue.peekLast();
        if(move && previous!=null && previous.event.action.equals("move") && previous.gesture==item.gesture && previous.event.button==e.button && previous.event.epoch==e.epoch)queue.removeLast();
        else if(queue.size()>=32){stop();throw new JSONException("TERMINAL_MOUSE_FULL");}
        queue.addLast(item);
    }
    public JSONObject command(String instance,String id) throws JSONException {
        TerminalProtocol.Mouse s=snapshot;if(s==null)return null;
        long now=clock.getAsLong();
        if(buttons!=0 && due(now,lastBeat,601) || queue.stream().anyMatch(item->due(now,item.created,601)))stop();
        if(pending!=null)return abandoned?null:new JSONObject(pending.toString());
        Queued item=null;
        if(cancelWanted){
            if(s.gesture!=0 && s.remainingMs>0 && (s.phase.equals("pending") || s.phase.equals("held")))
                item=new Queued(new Event("cancel",s.epoch,revision,0,0,0,0),s.gesture,now);
            else if(s.buttons==0){cancelWanted=false;gesture=0;}
        }
        if(item==null && !abandoned && !queue.isEmpty()){
            Queued first=queue.peek();
            if(first.event.action.equals("press") && first.gesture>s.gesture && (s.buttons!=0 || s.remainingMs!=0))return null;
            item=queue.remove();
        }
        if(item==null && !abandoned && buttons!=0 && due(now,lastSent,350))item=new Queued(new Event("renew",s.epoch,revision,0,0,0,0),gesture,now);
        if(item==null)return null;
        check(s.accepted<TerminalProtocol.MAX,"TERMINAL_MOUSE_SEQUENCE");Event e=item.event;
        pending=TerminalProtocol.request("mouse",instance,id).put("sequence",s.accepted+1).put("action",e.action).put("epoch",e.epoch)
                .put("gesture",item.gesture).put("column",e.column).put("row",e.row).put("button",e.button).put("modifiers",e.modifiers);
        return new JSONObject(pending.toString());
    }
    public void acknowledge(TerminalProtocol.Reply reply) throws JSONException {
        TerminalProtocol.require(pending!=null && reply.instance.equals(pending.getString("instance")) && reply.session.id.equals(pending.getString("id"))
                && reply.session.mouse!=null && reply.session.mouse.accepted==pending.getLong("sequence"));
        pending=null;lastSent=clock.getAsLong();refresh(reply.session.mouse);
    }
}
