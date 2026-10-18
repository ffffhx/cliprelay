package com.cliprelay.app;

import com.limelight.terminal.*;
import com.termux.terminal.*;
import org.json.JSONObject;
import org.junit.Test;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import static org.junit.Assert.*;

public class TerminalInteractionTest {
    private static byte[] bytes(String text){return text.getBytes(StandardCharsets.UTF_8);}
    private static class Fixture {
        final TerminalInputBatch batch=new TerminalInputBatch();
        final ByteArrayOutputStream automatic=new ByteArrayOutputStream();
        final TerminalEmulator emulator=new TerminalEmulator(new TerminalOutput(){
            public void write(byte[] data,int offset,int count){if(!batch.collect(data,offset,count))automatic.write(data,offset,count);}
            public void titleChanged(String oldTitle,String newTitle){}
            public void onCopyTextToClipboard(String text){}
            public void onPasteTextFromClipboard(){}
            public void onBell(){}
            public void onColorsChanged(){}
        },20,5,8,16,2000,new TerminalSessionClient(){});
        void append(String text){byte[] b=bytes(text);emulator.append(b,b.length);}
        byte[] paste(String text){String prepared=TerminalClipboard.prepare(text);return batch.capture(TerminalClipboard.MAX_BATCH_BYTES,()->emulator.paste(prepared));}
        String selected(TerminalSelection selection){TerminalSelection.Range r=selection.range();return emulator.getSelectedText(r.x1,r.y1,r.x2,r.y2);}
    }
    @Test public void clipboardNormalizesNewlinesAndRemovesExecutableControlBytes(){
        assertEquals("a\nb\nc\n\td[201~",TerminalClipboard.prepare("a\r\nb\rc\n\td\0\u0003\u0007\u001b[201~\u007f\u0085\u009b"));
        assertEquals("中文🙂e\u0301",TerminalClipboard.prepare("中文🙂e\u0301"));
        assertEquals("",TerminalClipboard.prepare("\u0003\u007f"));
    }
    @Test public void clipboardEnforcesUtf8BytesAndRejectsUnpairedSurrogates(){
        assertEquals(4084,bytes(TerminalClipboard.prepare("中".repeat(1361)+"x")).length);
        assertEquals(4084,bytes(TerminalClipboard.prepare("🙂".repeat(1021))).length);
        for(String bad:new String[]{"a".repeat(4085),"中".repeat(1362),"🙂".repeat(1022),"\ud800","x\udc00","\ud800a"}) {
            try{TerminalClipboard.prepare(bad);fail("accepted invalid or oversized input");}catch(IllegalArgumentException expected){}
        }
    }
    @Test public void bracketedPasteIsOneCompleteBoundedBatchAndQueriesStillWork(){
        Fixture f=new Fixture();f.append("\u001b[?2004h");
        assertEquals("\u001b[200~中文\rnext\t🙂\u001b[201~",new String(f.paste("中文\nnext\t🙂"),StandardCharsets.UTF_8));
        assertEquals(0,f.automatic.size());
        assertEquals(4096,f.paste("🙂".repeat(1021)).length);
        f.append("\u001b[6n");assertEquals("\u001b[1;1R",f.automatic.toString(StandardCharsets.UTF_8));
    }
    @Test public void plainPasteUsesActualParserNewlineRulesWithoutFraming(){
        Fixture f=new Fixture();assertArrayEquals(bytes("a\rb\rc"),f.paste("a\r\nb\rc"));assertEquals(0,f.automatic.size());
    }
    @Test public void oversizeOrFailedCaptureNeverLeaksPrefixAndNextCaptureWorks(){
        Fixture f=new Fixture();f.append("\u001b[?2004h");
        try{f.batch.capture(8,()->f.emulator.paste("body"));fail();}catch(IllegalArgumentException expected){}
        assertEquals(0,f.automatic.size());
        try{f.batch.capture(4096,()->{f.emulator.paste("body");throw new IllegalStateException("encoder failed");});fail();}catch(IllegalStateException expected){}
        assertEquals(0,f.automatic.size());assertArrayEquals(bytes("\u001b[200~ok\u001b[201~"),f.paste("ok"));
    }
    @Test public void swallowedOverflowAndNestedCaptureStillInvalidateTheWholeBatch(){
        TerminalInputBatch batch=new TerminalInputBatch();
        try{batch.capture(1,()->{try{batch.collect(new byte[2],0,2);}catch(IllegalArgumentException ignored){}});fail();}catch(IllegalStateException expected){}
        try{batch.capture(20,()->{try{batch.capture(20,()->{});}catch(IllegalStateException ignored){}});fail();}catch(IllegalStateException expected){}
        assertArrayEquals(new byte[]{42},batch.capture(1,()->batch.collect(new byte[]{42},0,1)));
        assertFalse(batch.collect(new byte[]{9},0,1));
    }
    @Test public void acceptedPasteSurvivesUncertainWriteAsOneRequestAndUnsentPasteCanBeDiscarded() throws Exception {
        Fixture f=new Fixture();f.append("\u001b[?2004h");byte[] paste=f.paste("🙂".repeat(1021));
        TerminalTest protocol=new TerminalTest();TerminalSessionState state=protocol.model();
        assertTrue(state.enqueue(paste));JSONObject request=state.write();
        assertArrayEquals(paste,Base64.getDecoder().decode(request.getString("data")));
        assertTrue(state.enqueue(new byte[]{'x'}));assertTrue(state.discardUnsent());
        assertEquals(request.toString(),state.write().toString());
        state.acknowledge(new TerminalProtocol.Reply(request,protocol.reply(protocol.state().put("acceptedSequence",1))));
        assertFalse(state.hasInput());assertTrue(state.enqueue(paste));assertTrue(state.discardUnsent());assertFalse(state.hasInput());
    }
    @Test public void queueRejectionDoesNotAcceptJustAPastePrefix() throws Exception {
        TerminalTest protocol=new TerminalTest();TerminalSessionState state=protocol.model();
        assertTrue(state.enqueue(new byte[16384]));assertTrue(state.enqueue(new byte[16380]));
        Fixture f=new Fixture();f.append("\u001b[?2004h");assertFalse(state.enqueue(f.paste("x")));
        int total=0;long seq=0;
        while(state.hasInput()) {JSONObject request=state.write();byte[] b=Base64.getDecoder().decode(request.getString("data"));
            for(byte v:b)assertEquals(0,v);total+=b.length;
            state.acknowledge(new TerminalProtocol.Reply(request,protocol.reply(protocol.state().put("acceptedSequence",++seq))));}
        assertEquals(32764,total);
    }
    @Test public void selectionOrdersReversedEndpointsAndClampsToHistory(){
        TerminalSelection s=new TerminalSelection();s.start(0,0,20,5,3);assertNull(s.range());s.enable(true);
        s.start(100,100,20,5,3);s.extend(-100,-100,20,5,3);TerminalSelection.Range r=s.range();
        assertEquals(0,r.x1);assertEquals(-3,r.y1);assertEquals(19,r.x2);assertEquals(4,r.y2);
        s.start(8,1,20,5,3);s.extend(2,1,20,5,3);assertEquals(2,s.range().x1);assertEquals(8,s.range().x2);
        s.clear();s.extend(1,1,20,5,3);assertNull(s.range());assertTrue(s.enabled());s.enable(false);assertFalse(s.enabled());
    }
    @Test public void selectionCopiesWholeWideAndCombiningCharactersFromEitherCell(){
        Fixture f=new Fixture();f.append("A中🙂e\u0301Z");TerminalSelection s=new TerminalSelection();s.enable(true);
        s.start(2,0,20,5,0);s.extend(4,0,20,5,0);assertEquals("中🙂",f.selected(s));
        s.start(5,0,20,5,0);assertEquals("e\u0301",f.selected(s));
    }
    @Test public void selectionAcrossWrappedAndExplicitLinesPreservesTheirDifference(){
        Fixture f=new Fixture();f.append("12345678901234567890wrapped\r\nnext");TerminalSelection s=new TerminalSelection();s.enable(true);
        s.start(0,0,20,5,0);s.extend(3,2,20,5,0);assertEquals("12345678901234567890wrapped\nnext",f.selected(s));
    }
    @Test public void historicalSelectionUsesRetainedRowsAndCanBeInvalidated(){
        Fixture f=new Fixture();f.append("one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix");
        int history=f.emulator.getScreen().getActiveTranscriptRows();assertTrue(history>0);
        TerminalSelection s=new TerminalSelection();s.enable(true);s.start(0,-history,20,5,history);s.extend(2,-history,20,5,history);
        assertEquals("one",f.selected(s));s.clear();f.append("\r\nnew");assertNull(s.range());
    }
}
