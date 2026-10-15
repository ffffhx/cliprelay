package com.cliprelay.app;

import com.limelight.terminal.*;
import org.json.*;
import org.junit.Test;
import java.util.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import static org.junit.Assert.*;

public class TerminalTypedMouseTest {
    static final String INSTANCE=TerminalTest.INSTANCE,ID=TerminalTest.ID;
    final TerminalTest helpers=new TerminalTest();
    JSONObject mouse() throws Exception {return new JSONObject().put("mode",1002).put("format",1006).put("epoch",1).put("offset",0)
            .put("gesture",0).put("nextGesture",1).put("buttons",0).put("remainingMs",0).put("acceptedSequence",0).put("writtenSequence",0).put("phase","idle").put("outcome","none");}
    TerminalProtocol.Mouse snapshot(JSONObject value) throws Exception {return new TerminalProtocol.Mouse(value,100);}
    interface Checked {void run() throws Exception;}
    void rejects(String code,Checked work) throws Exception {try{work.run();fail("accepted invalid input");}catch(JSONException error){assertEquals(code,error.getMessage());}}
    final class Fixture {
        long now=10000;JSONObject wire=mouse();TerminalMouseState state=new TerminalMouseState(snapshot(wire),()->now);
        Fixture() throws Exception {}
        void event(String action,int button,int x,int mods) throws Exception {state.enqueue(new TerminalMouseState.Event(action,state.snapshot.epoch,state.revision(),x,7,button,mods));}
        JSONObject command() throws Exception {return state.command(INSTANCE,ID);}
        void acknowledge(JSONObject c,int held,int remaining,String phase) throws Exception {
            wire.put("acceptedSequence",c.getLong("sequence")).put("writtenSequence",c.getLong("sequence"))
                    .put("gesture",c.getLong("gesture")).put("nextGesture",c.getLong("gesture")+1)
                    .put("buttons",held).put("remainingMs",remaining).put("phase",phase).put("outcome","written");
            state.acknowledge(new TerminalProtocol.Reply(c,helpers.reply(helpers.state().put("mouse",wire))));
        }
    }
    @Test public void strictNegotiationAndMouseReceiptsKeepKeyboardSequenceSeparate() throws Exception {
        JSONObject s=helpers.state().put("acceptedSequence",7).put("writtenSequence",6).put("mouse",mouse().put("acceptedSequence",3));
        JSONObject list=new JSONObject().put("ok",true).put("instance",INSTANCE).put("nextOpen",2).put("mouseProtocol",1).put("sessions",new JSONArray().put(s));
        assertEquals(1,new TerminalProtocol.Reply(TerminalProtocol.list(),list).mouseProtocol);
        JSONObject c=TerminalProtocol.request("mouse",INSTANCE,ID).put("sequence",3);
        assertEquals(7,new TerminalProtocol.Reply(c,helpers.reply(s)).session.accepted);
        rejects("TERMINAL_INVALID_RESPONSE",()->new TerminalProtocol.Reply(new JSONObject(c.toString()).put("sequence",7),helpers.reply(s)));
        for(Object invalid:new Object[]{2,-1,"1",true,1.0})rejects("TERMINAL_INVALID_RESPONSE",()->new TerminalProtocol.Reply(TerminalProtocol.list(),new JSONObject(list.toString()).put("mouseProtocol",invalid)));
        s.remove("mouse");rejects("TERMINAL_INVALID_RESPONSE",()->new TerminalProtocol.Reply(TerminalProtocol.list(),list));
        list.remove("mouseProtocol");assertEquals(0,new TerminalProtocol.Reply(TerminalProtocol.list(),list).mouseProtocol);
        for(String code:new String[]{"MOUSE_MODE","MOUSE_GESTURE","MOUSE_SEQUENCE","MOUSE_CONFLICT"}){
            try{TerminalProtocol.checkHttp(409,new JSONObject().put("code","TERMINAL_"+code));fail();}catch(IOException e){assertEquals("TERMINAL_"+code,e.getMessage());}
        }
    }
    @Test public void malformedMouseMetadataFailsBeforeQueueStateCanChange() throws Exception {
        for(Object[] field:new Object[][]{{"mode",1004},{"format",1007},{"epoch",0},{"offset",101},{"buttons",8},{"remainingMs",1501},{"nextGesture",0},{"writtenSequence",1},{"phase","active"},{"outcome","ready"},{"acceptedSequence",1.0}})
            rejects("TERMINAL_INVALID_RESPONSE",()->snapshot(mouse().put((String)field[0],field[1])));
        rejects("TERMINAL_INVALID_RESPONSE",()->snapshot(mouse().put("phase","closed").put("buttons",1)));
        assertFalse(snapshot(mouse().put("mode",1001)).available());assertTrue(snapshot(mouse().put("mode",1003)).available());
    }
    @Test public void liveMovesCoalesceButPreserveBothEdgesAndModifiers() throws Exception {
        Fixture f=new Fixture();f.event("press",2,5,4);for(int i=0;i<100;i++)f.event("move",2,6+i,16);f.event("release",2,106,8);
        JSONObject c=f.command();assertEquals("press",c.getString("action"));assertEquals(4,c.getInt("modifiers"));f.acknowledge(c,4,1500,"held");
        c=f.command();assertEquals("move",c.getString("action"));assertEquals(105,c.getInt("column"));assertEquals(16,c.getInt("modifiers"));f.acknowledge(c,4,1500,"held");
        c=f.command();assertEquals("release",c.getString("action"));assertEquals(8,c.getInt("modifiers"));f.acknowledge(c,0,0,"idle");assertNull(f.command());
    }
    @Test public void rapidClicksWaitForWrittenReleaseAndUseDifferentGestures() throws Exception {
        Fixture f=new Fixture();f.event("press",0,5,0);f.event("release",0,5,0);f.event("press",0,6,0);f.event("release",0,6,0);
        JSONObject first=f.command();f.acknowledge(first,1,1500,"held");JSONObject up=f.command();f.acknowledge(up,1,1500,"held");assertNull(f.command());
        f.state.refresh(snapshot(f.wire.put("buttons",0).put("remainingMs",0).put("phase","idle")));
        JSONObject second=f.command();assertEquals("press",second.getString("action"));assertEquals(first.getLong("gesture")+1,second.getLong("gesture"));
    }
    @Test public void networkRetriesCannotRenewTheForegroundLease() throws Exception {
        Fixture f=new Fixture();f.event("press",0,5,0);JSONObject c=f.command();f.now+=300;assertEquals(c.toString(),f.command().toString());
        f.now+=301;assertNull(f.command());assertEquals(0,f.state.buttons());
        f.state.refresh(snapshot(f.wire.put("acceptedSequence",1).put("gesture",1).put("nextGesture",2).put("buttons",1).put("remainingMs",900).put("phase","held")));
        assertEquals("cancel",f.command().getString("action"));
    }
    @Test public void freshHeartbeatRenewsAndStopPrioritizesCleanup() throws Exception {
        Fixture f=new Fixture();f.event("press",1,5,0);f.acknowledge(f.command(),2,1500,"held");
        f.now+=400;f.state.heartbeat(f.state.revision());JSONObject renew=f.command();assertEquals("renew",renew.getString("action"));f.acknowledge(renew,2,1500,"held");
        f.event("move",1,7,16);long old=f.state.revision();f.state.stop();
        rejects("TERMINAL_MOUSE_GESTURE",()->f.state.heartbeat(old));assertEquals("cancel",f.command().getString("action"));
    }
    @Test public void lostAcceptedAndUnacceptedReceiptsNeverReplayAnAbandonedPress() throws Exception {
        for(boolean accepted:new boolean[]{false,true}){
            Fixture f=new Fixture();f.event("press",0,5,0);f.command();f.state.stop();
            if(accepted)f.wire.put("acceptedSequence",1).put("gesture",1).put("nextGesture",2).put("buttons",1).put("remainingMs",800).put("phase","held");
            f.state.refresh(snapshot(f.wire));JSONObject next=f.command();assertEquals(accepted?"cancel":null,next==null?null:next.getString("action"));
        }
    }
    @Test public void modeChangesQueueOverflowAndStaleEventsStopTheGesture() throws Exception {
        Fixture f=new Fixture();f.event("press",0,5,0);f.acknowledge(f.command(),1,1500,"held");
        long old=f.state.revision();f.state.refresh(snapshot(f.wire.put("epoch",2).put("mode",1003).put("phase","mode-changed").put("buttons",0).put("remainingMs",0)));
        rejects("TERMINAL_MOUSE_GESTURE",()->f.state.enqueue(new TerminalMouseState.Event("press",2,old,5,7,0,0)));
        assertNull(f.command());f.event("move",3,5,0);assertEquals(0,f.command().getLong("gesture"));
        Fixture full=new Fixture();full.event("press",0,5,0);full.acknowledge(full.command(),1,1500,"held");
        for(int i=0;i<32;i++)full.event("wheel",0,5,0);
        rejects("TERMINAL_MOUSE_FULL",()->full.event("wheel",0,5,0));assertEquals("cancel",full.command().getString("action"));
    }
    final class PointerSink implements TerminalMousePointer.Sink {
        final List<TerminalMouseState.Event> events=new ArrayList<>();int cancelled;boolean accept=true;
        public boolean event(TerminalMouseState.Event event){events.add(event);return accept;}
        public void cancel(){cancelled++;}
        public boolean heartbeat(long revision){return accept;}
    }
    @Test public void externalEdgesDeduplicateAndLostButtonsCannotRecreateAnOldPress() throws Exception {
        PointerSink sink=new PointerSink();TerminalMousePointer p=new TerminalMousePointer(sink);p.configure(snapshot(mouse()),4,true);
        p.edges(4,5,7,4,true);p.edges(4,5,7,4,true);p.edges(6,5,7,8,true);p.move(6,6,8,16);p.edges(2,6,8,16,false);p.edges(0,6,8,0,false);
        assertEquals(Arrays.asList("press","press","move","release","release"),sink.events.stream().map(e->e.action).toList());
        assertEquals(2,sink.events.get(0).button);assertEquals(1,sink.events.get(1).button);assertEquals(16,sink.events.get(2).modifiers);
        p.edges(4,5,7,0,true);p.move(0,6,7,0);int n=sink.events.size();p.edges(4,6,7,0,false);assertEquals(n,sink.events.size());assertTrue(sink.cancelled>=2);
    }
    @Test public void hoverAndWheelRespectModesFractionalAxesAndCoordinateBounds() throws Exception {
        PointerSink sink=new PointerSink();TerminalMousePointer p=new TerminalMousePointer(sink);p.configure(snapshot(mouse().put("mode",1003)),0,true);
        p.move(0,5,7,4);assertEquals(3,sink.events.get(0).button);p.wheel(.5f,false,5,7,0);assertEquals(1,sink.events.size());p.wheel(.5f,false,5,7,0);assertEquals(0,sink.events.get(1).button);
        p.wheel(1000,true,5,7,8);assertEquals(10,sink.events.size());assertEquals(3,sink.events.get(9).button);assertEquals(8,sink.events.get(9).modifiers);
        p.configure(snapshot(mouse().put("mode",9)),1,true);p.edges(1,5,7,0,true);p.move(1,6,7,0);p.edges(0,6,7,0,false);assertEquals(11,sink.events.size());
        p.configure(snapshot(mouse().put("format",0)),2,true);p.edges(1,224,7,0,true);assertEquals(11,sink.events.size());assertEquals(0,p.buttons());
    }
    @Test public void rendererRevisionAndReadinessCancelLocalButtonsWithoutReplayingMotion() throws Exception {
        PointerSink sink=new PointerSink();TerminalMousePointer p=new TerminalMousePointer(sink);p.configure(snapshot(mouse()),0,true);p.edges(1,5,7,0,true);
        p.configure(snapshot(mouse()),1,true);p.move(1,6,7,0);assertEquals(1,sink.events.size());assertEquals(0,p.buttons());
        p.edges(1,5,7,0,true);p.configure(snapshot(mouse()),1,false);assertEquals(0,p.buttons());assertFalse(p.heartbeat());
        p.configure(snapshot(mouse()),1,true);sink.accept=false;p.edges(1,5,7,0,true);assertEquals(0,p.buttons());
    }
    @Test public void duplicatePlatformPressAfterRejectionNeedsAPhysicalReleaseBeforeRetry() throws Exception {
        PointerSink sink=new PointerSink();TerminalMousePointer p=new TerminalMousePointer(sink);p.configure(snapshot(mouse()),0,true);sink.accept=false;
        p.edges(1,5,7,0,true);assertEquals(1,sink.events.size());sink.accept=true;p.configure(snapshot(mouse()),1,true);
        p.edges(1,5,7,0,true);p.move(1,6,7,0);assertEquals(1,sink.events.size());
        p.edges(0,6,7,0,false);p.edges(1,6,7,0,true);assertEquals(2,sink.events.size());assertEquals("press",sink.events.get(1).action);
    }
    @Test public void networkLatencyCannotAlternateReadsAndKeysForeverWhileMouseWaits(){
        for(int rendererDelay:new int[]{16,116}){
        TerminalInputSchedule schedule=new TerminalInputSchedule();long now=10000;Map<String,Integer> counts=new HashMap<>();
        for(int n=0;n<24;n++){
            String op=schedule.preferMouse()?"mouse":schedule.preferKey(now)?"write":schedule.readDue(now)?"read":schedule.keyDue(now)?"write":"mouse";
            now+=120;schedule.completed(op,now);now+=rendererDelay;counts.merge(op,1,Integer::sum);
        }
        for(String op:new String[]{"read","write","mouse"})assertTrue(op,counts.getOrDefault(op,0)>=5);
        }
    }
    @Test public void actualWindowsProgramReceivesLiveMovesAndExpiresAfterAndroidStopsRenewing() throws Exception {
        String executable=System.getenv("CLIPRELAY_TERMINAL_TEST_WORKER"),fixture=System.getenv("CLIPRELAY_TERMINAL_MOUSE_FIXTURE");
        org.junit.Assume.assumeTrue(executable!=null && fixture!=null);
        Process process=new ProcessBuilder(executable,"--terminal-probe").start();ExecutorService reader=Executors.newSingleThreadExecutor();
        BufferedReader input=new BufferedReader(new InputStreamReader(process.getInputStream(),StandardCharsets.UTF_8));String owner="a".repeat(64);
        try {
            helpers.call(process,input,reader,new JSONObject().put("op","sync").put("owners",new JSONArray().put(owner)));
            JSONObject listCommand=TerminalProtocol.list();TerminalProtocol.Reply list=new TerminalProtocol.Reply(listCommand,helpers.call(process,input,reader,new JSONObject(listCommand.toString()).put("owner",owner)));assertEquals(1,list.mouseProtocol);
            JSONObject open=TerminalProtocol.request("open",list.instance,ID).put("shell","cmd").put("columns",80).put("rows",24).put("sequence",list.nextOpen);
            TerminalSessionState session=new TerminalSessionState(list.instance,new TerminalProtocol.Reply(open,helpers.call(process,input,reader,new JSONObject(open.toString()).put("owner",owner))).session);
            session.enqueue(("\""+fixture+"\" --mouse-echo\r").getBytes(StandardCharsets.UTF_8));JSONObject write=session.write();session.acknowledge(new TerminalProtocol.Reply(write,helpers.call(process,input,reader,new JSONObject(write.toString()).put("owner",owner))));
            StringBuilder output=new StringBuilder();long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);
            while(System.nanoTime()<deadline && !session.snapshot.mouse.available()){read(process,input,reader,owner,session,output);Thread.sleep(20);}
            assertTrue(session.snapshot.mouse.available());TerminalMouseState mouse=session.mouse;
            mouse.enqueue(new TerminalMouseState.Event("press",mouse.snapshot.epoch,mouse.revision(),5,7,0,0));send(process,input,reader,owner,session);
            mouse.enqueue(new TerminalMouseState.Event("move",mouse.snapshot.epoch,mouse.revision(),6,8,0,16));send(process,input,reader,owner,session);
            deadline=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(1800);long beat=0;
            while(System.nanoTime()<deadline){if(System.nanoTime()>=beat){mouse.heartbeat(mouse.revision());beat=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(200);}send(process,input,reader,owner,session);read(process,input,reader,owner,session,output);Thread.sleep(20);}
            assertTrue(output.toString().contains("MOUSE_MOVE_SEEN"));assertFalse(output.toString().contains("MOUSE_CAPTURE:"));assertEquals(1,mouse.snapshot.buttons);
            mouse.stop();Thread.sleep(1750);deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(4);
            while(System.nanoTime()<deadline && !output.toString().contains("MOUSE_CAPTURE:")){read(process,input,reader,owner,session,output);Thread.sleep(20);}
            java.util.regex.Matcher capture=java.util.regex.Pattern.compile("MOUSE_CAPTURE:([A-Za-z0-9+/=]+)").matcher(output);assertTrue(capture.find());
            assertEquals("\u001b[<0;5;7M\u001b[<48;6;8M\u001b[<16;6;8m",new String(Base64.getDecoder().decode(capture.group(1)),StandardCharsets.UTF_8));assertEquals(0,mouse.snapshot.buttons);assertEquals(2,mouse.snapshot.written);
        } finally {process.getOutputStream().close();if(!process.waitFor(5,TimeUnit.SECONDS))process.destroyForcibly();reader.shutdownNow();input.close();}
    }
    void read(Process process,BufferedReader input,ExecutorService reader,String owner,TerminalSessionState session,StringBuilder output) throws Exception {
        JSONObject c=session.read();TerminalProtocol.Reply reply=new TerminalProtocol.Reply(c,helpers.call(process,input,reader,new JSONObject(c.toString()).put("owner",owner)));session.consume(reply);output.append(new String(reply.data,StandardCharsets.UTF_8));
    }
    void send(Process process,BufferedReader input,ExecutorService reader,String owner,TerminalSessionState session) throws Exception {
        JSONObject c=session.mouse.command(session.instance,session.id);if(c==null)return;
        TerminalProtocol.Reply reply=new TerminalProtocol.Reply(c,helpers.call(process,input,reader,new JSONObject(c.toString()).put("owner",owner)));session.mouse.acknowledge(reply);session.refresh(reply.instance,reply.session);
    }
}
