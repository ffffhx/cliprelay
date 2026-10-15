package com.cliprelay.app;

import com.limelight.terminal.*;
import com.termux.terminal.*;
import org.json.JSONObject;
import org.junit.Test;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import static org.junit.Assert.*;

public class TerminalMouseTest {
    private static byte[] bytes(String text){return text.getBytes(StandardCharsets.UTF_8);}
    private static final class Fixture {
        final TerminalInputBatch batch=new TerminalInputBatch();
        final ByteArrayOutputStream automatic=new ByteArrayOutputStream();
        final TerminalEmulator emulator=new TerminalEmulator(new TerminalOutput(){
            public void write(byte[] data,int offset,int count){if(!batch.collect(data,offset,count))automatic.write(data,offset,count);}
            public void titleChanged(String oldTitle,String newTitle){}
            public void onCopyTextToClipboard(String text){}
            public void onPasteTextFromClipboard(){}
            public void onBell(){}
            public void onColorsChanged(){}
        },240,120,8,16,2000,new TerminalSessionClient(){});
        void append(String text){byte[] b=bytes(text);emulator.append(b,b.length);}
        byte[] click(int column,int row){return TerminalMouseInput.click(emulator,batch,column,row);}
        byte[] wheel(int column,int row,int steps){return TerminalMouseInput.wheel(emulator,batch,column,row,steps);}
    }
    @Test public void sgrClickContainsBothEdgesAndDoesNotLeakThroughTheAutomaticSink(){
        Fixture f=new Fixture();f.append("\u001b[?1000h\u001b[?1006h");
        assertArrayEquals(bytes("\u001b[<0;240;120M\u001b[<0;240;120m"),f.click(240,120));
        assertEquals(0,f.automatic.size());f.append("\u001b[6n");assertArrayEquals(bytes("\u001b[1;1R"),f.automatic.toByteArray());
    }
    @Test public void legacyClickHasExactUnsignedByteCoordinatesAndRelease(){
        Fixture f=new Fixture();f.append("\u001b[?1000h");
        assertArrayEquals(new byte[]{27,'[','M',32,(byte)255,(byte)152,27,'[','M',35,(byte)255,(byte)152},f.click(223,120));
        assertEquals(0,f.click(224,1).length);assertEquals(0,f.automatic.size());
    }
    @Test public void noTrackingAndOutOfScreenCoordinatesNeverClampToAnotherCell(){
        Fixture f=new Fixture();assertEquals(0,f.click(1,1).length);assertEquals(0,f.wheel(1,1,1).length);
        f.append("\u001b[?1002h\u001b[?1006h");
        for(int[] p:new int[][]{{0,1},{1,0},{241,1},{1,121},{-1,-1},{Integer.MAX_VALUE,1}}){assertEquals(0,f.click(p[0],p[1]).length);assertEquals(0,f.wheel(p[0],p[1],1).length);}
        assertTrue(f.click(1,1).length>0);
    }
    @Test public void parserModeChangesDetermineEncodingAndDisabledTrackingStopsOutput(){
        Fixture f=new Fixture();f.append("\u001b[?1002h\u001b[?1006h");assertEquals(18,f.click(1,1).length);
        f.append("\u001b[?1006l");assertEquals(12,f.click(1,1).length);
        f.append("\u001b[?1002l");assertEquals(0,f.click(1,1).length);assertEquals(0,f.wheel(1,1,1).length);
    }
    @Test public void wheelsHaveCorrectDirectionAndNoReleaseWithABoundForExtremeCounts(){
        Fixture f=new Fixture();f.append("\u001b[?1000h\u001b[?1006h");
        assertArrayEquals(bytes("\u001b[<64;4;5M".repeat(2)),f.wheel(4,5,2));
        assertArrayEquals(bytes("\u001b[<65;4;5M".repeat(3)),f.wheel(4,5,-3));
        assertArrayEquals(bytes("\u001b[<64;4;5M".repeat(8)),f.wheel(4,5,Integer.MAX_VALUE));
        assertArrayEquals(bytes("\u001b[<65;4;5M".repeat(8)),f.wheel(4,5,Integer.MIN_VALUE));assertEquals(0,f.wheel(1,1,0).length);
        f.append("\u001b[?1006l");assertArrayEquals(new byte[]{27,'[','M',96,33,33},f.wheel(1,1,1));assertEquals(0,f.wheel(224,1,8).length);
    }
    @Test public void queueRejectionCannotLeaveADownWithoutAnUp() throws Exception {
        TerminalTest p=new TerminalTest();TerminalSessionState state=p.model();state.enqueue(new byte[16384]);state.enqueue(new byte[16378]);
        Fixture f=new Fixture();f.append("\u001b[?1000h");assertFalse(state.enqueue(f.click(1,1)));
        int total=0;long sequence=0;
        while(state.hasInput()){JSONObject request=state.write();byte[] data=Base64.getDecoder().decode(request.getString("data"));for(byte value:data)assertEquals(0,value);total+=data.length;
            state.acknowledge(new TerminalProtocol.Reply(request,p.reply(p.state().put("acceptedSequence",++sequence))));}
        assertEquals(32762,total);
    }
    @Test public void uncertainClickRemainsOneExactRequestAfterBackgroundCleanup() throws Exception {
        TerminalTest p=new TerminalTest();TerminalSessionState state=p.model();Fixture f=new Fixture();f.append("\u001b[?1002h\u001b[?1006h");
        byte[] click=f.click(18,19);assertTrue(state.enqueue(click));JSONObject request=state.write();
        state.enqueue(f.wheel(18,19,8));assertTrue(state.discardUnsent());assertEquals(request.toString(),state.write().toString());
        assertArrayEquals(click,Base64.getDecoder().decode(state.write().getString("data")));
        state.acknowledge(new TerminalProtocol.Reply(request,p.reply(p.state().put("acceptedSequence",1))));assertFalse(state.hasInput());
    }
    @Test public void localTapOnlyBecomesAClickAtOneMatchingUp(){
        TerminalMouseGesture g=new TerminalMouseGesture(8,16);g.down(2,40,40,true);assertEquals(0,g.move(2,42,42));
        assertTrue(g.up(2,42,42));assertFalse(g.up(2,42,42));
        g.down(2,40,40,true);assertFalse(g.up(2,40,70));
    }
    @Test public void horizontalMovementAndPhysicalDraggingNeverBecomeClicksOrWheels(){
        TerminalMouseGesture g=new TerminalMouseGesture(8,16);g.down(0,40,40,true);
        assertEquals(0,g.move(0,70,42));assertEquals(0,g.move(0,40,80));assertFalse(g.up(0,40,40));
        g.down(0,40,40,false);assertEquals(0,g.move(0,40,80));assertFalse(g.up(0,40,40));
    }
    @Test public void verticalSwipesAreBoundedWheelsAndNeverClickAfterReturningToStart(){
        TerminalMouseGesture g=new TerminalMouseGesture(8,16);g.down(0,50,50,true);
        assertEquals(2,g.move(0,50,82));assertEquals(-3,g.move(0,50,34));assertFalse(g.up(0,50,50));
        g.down(0,50,50,true);assertEquals(8,g.move(0,50,10000));assertEquals(0,g.move(0,50,10000));assertFalse(g.up(0,50,50));
    }
    @Test public void canceledOrReplacedPointersCannotResumeTheOldGesture(){
        TerminalMouseGesture g=new TerminalMouseGesture(8,16);g.down(0,40,40,true);g.cancel();
        assertEquals(0,g.move(0,40,80));assertFalse(g.up(0,40,40));
        g.down(0,40,40,true);assertEquals(0,g.move(1,40,80));assertFalse(g.up(0,40,40));
        g.down(7,40,40,true);assertTrue(g.up(7,40,40));
    }
    @Test public void fractionalPhysicalWheelAccumulatesButCancelAndLargeBurstsLeaveNoStaleSteps(){
        TerminalMouseGesture g=new TerminalMouseGesture(8,16);assertEquals(0,g.wheel(.5f));assertEquals(1,g.wheel(.5f));assertEquals(0,g.wheel(0));
        assertEquals(0,g.wheel(-.5f));g.cancel();assertEquals(0,g.wheel(-.5f));assertEquals(-1,g.wheel(-.5f));
        assertEquals(8,g.wheel(Float.MAX_VALUE));assertEquals(0,g.wheel(0));assertEquals(-8,g.wheel(-Float.MAX_VALUE));assertEquals(0,g.wheel(0));
        g.down(0,1,1,true);g.wheel(.1f);assertFalse(g.up(0,1,1));
    }
    @Test public void malformedGeometryAndNonFiniteEventsAreRejected(){
        for(float[] sizes:new float[][]{{-1,16},{8,0},{Float.NaN,16},{8,Float.POSITIVE_INFINITY}}){try{new TerminalMouseGesture(sizes[0],sizes[1]);fail();}catch(IllegalArgumentException expected){}}
        TerminalMouseGesture g=new TerminalMouseGesture(8,16);g.down(0,Float.NaN,4,true);assertFalse(g.up(0,4,4));
        g.down(0,4,4,true);assertEquals(0,g.move(0,4,Float.POSITIVE_INFINITY));assertFalse(g.up(0,4,4));
        assertEquals(0,g.wheel(.5f));assertEquals(0,g.wheel(Float.NaN));assertEquals(0,g.wheel(.5f));
    }
}
