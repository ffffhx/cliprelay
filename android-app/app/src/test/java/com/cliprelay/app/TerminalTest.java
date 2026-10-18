package com.cliprelay.app;

import com.limelight.terminal.*;
import com.termux.terminal.*;
import org.json.*;
import org.junit.Test;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.Assert.*;

public class TerminalTest {
    static final String INSTANCE="0123456789abcdef0123456789abcdef", ID="1123456789abcdef0123456789abcdef";
    JSONObject state() throws Exception {return new JSONObject().put("id",ID).put("shell","cmd").put("state","running")
            .put("columns",80).put("rows",24).put("exitCode",-1).put("openSequence",1).put("acceptedSequence",0)
            .put("writtenSequence",0).put("start",0).put("end",0).put("remainingMs",1800000);}
    JSONObject reply(JSONObject session) throws Exception {return new JSONObject().put("ok",true).put("instance",INSTANCE).put("session",session);}
    TerminalSessionState model() throws Exception {return new TerminalSessionState(INSTANCE,new TerminalProtocol.Session(state()));}
    @Test public void emptyGoInventoryCanOmitEmptyFields() throws Exception {
        TerminalProtocol.Reply list=new TerminalProtocol.Reply(TerminalProtocol.list(),new JSONObject().put("ok",true).put("instance",INSTANCE).put("nextOpen",1));
        assertTrue(list.sessions.isEmpty());assertEquals(1,list.nextOpen);
        assertEquals(Arrays.asList("powershell","cmd"),list.shells);
        JSONObject request=TerminalProtocol.request("read",INSTANCE,ID).put("offset",0);
        assertEquals(0,new TerminalProtocol.Reply(request,reply(state()).put("offset",0).put("next",0).put("gap",false)).data.length);
    }
    @Test public void hostShellInventoryIsExplicitAndBoundToSessions() throws Exception {
        JSONObject list=new JSONObject().put("ok",true).put("instance",INSTANCE).put("nextOpen",2)
            .put("shells",new JSONArray().put("zsh").put("bash")).put("sessions",new JSONArray().put(state().put("shell","zsh")));
        TerminalProtocol.Reply accepted=new TerminalProtocol.Reply(TerminalProtocol.list(),list);
        assertEquals(Arrays.asList("zsh","bash"),accepted.shells);assertEquals("zsh",accepted.sessions.get(0).shell);
        try{accepted.shells.add("cmd");fail();}catch(UnsupportedOperationException expected){}
        for(Object bad:new Object[]{JSONObject.NULL,new JSONArray(),new JSONArray().put("zsh").put("zsh"),new JSONArray().put("/bin/zsh"),new JSONArray().put("fish"),new JSONArray().put(1),new JSONArray().put("bash"),"zsh"}) {
            try{new TerminalProtocol.Reply(TerminalProtocol.list(),list.put("shells",bad));fail("accepted invalid shells: "+bad);}catch(JSONException expected){}
        }
        list.remove("shells");try{new TerminalProtocol.Reply(TerminalProtocol.list(),list);fail("Mac session in legacy Windows inventory");}catch(JSONException expected){}
    }
    @Test public void malformedSnapshotCannotAdvanceInput() throws Exception {
        for(Object[] field:new Object[][]{{"acceptedSequence","1"},{"acceptedSequence",1.5},{"writtenSequence",1},{"end",1048577},{"columns",0},{"rows",121},{"state","ready"},{"remainingMs",1800001},{"id","bad"}}) {
            try{new TerminalProtocol.Session(state().put((String)field[0],field[1]));fail(Arrays.toString(field));}catch(JSONException expected){}
        }
        JSONObject list=new JSONObject().put("ok",true).put("instance",INSTANCE).put("nextOpen",2).put("sessions",new JSONArray().put(state()).put(state()));
        try{new TerminalProtocol.Reply(TerminalProtocol.list(),list);fail();}catch(JSONException expected){}
    }
    @Test public void lostAckRetriesExactSequenceAndBytes() throws Exception {
        TerminalSessionState state=model();byte[] command="echo 中文\r".getBytes(StandardCharsets.UTF_8);assertTrue(state.enqueue(command));
        JSONObject original=state.write();command[0]=0;
        JSONObject accepted=state().put("acceptedSequence",1).put("writtenSequence",0);
        state.refresh(INSTANCE,new TerminalProtocol.Session(accepted));
        assertEquals(original.toString(),state.write().toString());
        state.acknowledge(new TerminalProtocol.Reply(original,reply(accepted)));
        assertFalse(state.hasInput());assertEquals(0,state.snapshot.written);
        assertTrue(state.enqueue(new byte[]{13}));assertEquals(2,state.write().getLong("sequence"));
    }
    @Test public void backgroundDropsOnlyKeysNeverSent() throws Exception {
        TerminalSessionState state=model();state.enqueue(new byte[]{'a'});JSONObject pending=state.write();state.enqueue(new byte[]{'b'});
        assertTrue(state.discardUnsent());assertTrue(state.uncertain());assertEquals(pending.toString(),state.write().toString());
        state.acknowledge(new TerminalProtocol.Reply(pending,reply(state().put("acceptedSequence",1))));assertFalse(state.hasInput());
        state.enqueue(new byte[]{'c'});assertTrue(state.discardUnsent());assertFalse(state.hasInput());
    }
    @Test public void oldInstanceAndConcurrentWriterNeverRebaseAnUncertainCommand() throws Exception {
        TerminalSessionState state=model();state.enqueue(new byte[]{13});JSONObject pending=state.write();
        try{state.refresh("2123456789abcdef0123456789abcdef",new TerminalProtocol.Session(state()));fail();}catch(JSONException expected){}
        try{state.refresh(INSTANCE,new TerminalProtocol.Session(state().put("acceptedSequence",2)));fail();}catch(JSONException expected){}
        assertEquals(pending.toString(),state.write().toString());
        TerminalSessionState fresh=new TerminalSessionState(INSTANCE,new TerminalProtocol.Session(state().put("acceptedSequence",8).put("writtenSequence",7)));
        assertFalse(fresh.hasInput());fresh.enqueue(new byte[]{13});assertEquals(9,fresh.write().getLong("sequence"));
    }
    @Test public void queueIsBoundedAndSplittingPreservesUtf8Bytes() throws Exception {
        TerminalSessionState state=model();byte[] data="中".repeat(5000).getBytes(StandardCharsets.UTF_8);assertTrue(state.enqueue(data));assertTrue(state.enqueue(data));assertFalse(state.enqueue(data));
        ByteArrayOutputStream output=new ByteArrayOutputStream();long sequence=0;
        while(state.hasInput()){JSONObject request=state.write();byte[] piece=Base64.getDecoder().decode(request.getString("data"));assertTrue(piece.length<=4096);output.write(piece);
            state.acknowledge(new TerminalProtocol.Reply(request,reply(state().put("acceptedSequence",++sequence))));}
        assertEquals("中".repeat(10000),output.toString(StandardCharsets.UTF_8));
    }
    @Test public void gapsAreExplicitAndMalformedOffsetsDoNotConsumeOutput() throws Exception {
        TerminalSessionState state=model();JSONObject request=state.read();
        JSONObject response=reply(state().put("start",12).put("end",15)).put("offset",12).put("next",15).put("gap",true).put("data",Base64.getEncoder().encodeToString("中".getBytes(StandardCharsets.UTF_8)));
        TerminalProtocol.Reply parsed=new TerminalProtocol.Reply(request,response);assertTrue(parsed.gap);state.consume(parsed);assertEquals(15,state.offset);
        for(Object[] field:new Object[][]{{"gap",false},{"next",14},{"offset",-1},{"data","5Lit\n"}}){
            try{new TerminalProtocol.Reply(request,new JSONObject(response.toString()).put((String)field[0],field[1]));fail();}catch(JSONException expected){}
        }
        assertEquals(15,state.offset);
    }
    @Test public void transportKeepsConflictAndRevocationDistinct() throws Exception {
        for(String code:new String[]{"TERMINAL_STALE","TERMINAL_INPUT_CONFLICT","TERMINAL_UNPAIRED","TERMINAL_USER_REQUIRED"}){
            try{TerminalProtocol.checkHttp(409,new JSONObject().put("ok",false).put("code",code));fail();}catch(IOException expected){assertEquals(code,expected.getMessage());}
        }
        try{TerminalProtocol.checkHttp(503,new JSONObject().put("code","arbitrary host content"));fail();}catch(IOException expected){assertEquals("TERMINAL_UNAVAILABLE",expected.getMessage());}
    }
    static final class Output extends TerminalOutput {
        final ByteArrayOutputStream bytes=new ByteArrayOutputStream();
        public void write(byte[] data,int offset,int count){bytes.write(data,offset,count);}
        public void titleChanged(String oldTitle,String newTitle){}
        public void onCopyTextToClipboard(String text){}
        public void onPasteTextFromClipboard(){}
        public void onBell(){}
        public void onColorsChanged(){}
    }
    TerminalEmulator emulator(Output output){return new TerminalEmulator(output,80,24,8,16,2000,new TerminalSessionClient(){});}
    void append(TerminalEmulator emulator,String text){byte[] bytes=text.getBytes(StandardCharsets.UTF_8);emulator.append(bytes,bytes.length);}
    @Test public void vtKeepsSplitUnicodeAndCursorAddressing() {
        TerminalEmulator emulator=emulator(new Output());byte[] bytes="中文🙂".getBytes(StandardCharsets.UTF_8);
        for(byte b:bytes)emulator.append(new byte[]{b},1);
        assertEquals(6,emulator.getCursorCol());assertTrue(emulator.getSelectedText(0,0,79,0).contains("中文🙂"));
        append(emulator,"\u001b[2;5H\u001b[31;1mX\u001b[0m");assertEquals(1,emulator.getCursorRow());assertEquals(5,emulator.getCursorCol());
        assertEquals("X",emulator.getSelectedText(4,1,4,1));
    }
    @Test public void alternateScreenRestoresMainScreenAndHandlesQueries() {
        Output output=new Output();TerminalEmulator emulator=emulator(output);append(emulator,"main\u001b[?1049h\u001b[Hfull\u001b[6n");
        assertTrue(emulator.isAlternateBufferActive());assertTrue(output.bytes.toString(StandardCharsets.UTF_8).contains("\u001b[1;5R"));
        append(emulator,"\u001b[?1049l");assertFalse(emulator.isAlternateBufferActive());assertEquals("main",emulator.getSelectedText(0,0,3,0));
    }
    @Test public void cancellationBeforeRegistrationIsTerminal() throws Exception {
        com.limelight.nvstream.http.LimelightCryptoProvider crypto=new com.limelight.nvstream.http.LimelightCryptoProvider(){
            public java.security.cert.X509Certificate getClientCertificate(){return null;}
            public java.security.PrivateKey getClientPrivateKey(){return null;}
            public byte[] getPemEncodedClientCertificate(){return new byte[0];}
            public String encodeBase64String(byte[] data){return Base64.getEncoder().encodeToString(data);}
        };
        com.limelight.nvstream.http.NvHTTP http=new com.limelight.nvstream.http.NvHTTP(new com.limelight.nvstream.http.ComputerDetails.AddressTuple("127.0.0.1",48789),0,"id",null,crypto);
        http.cancelTerminalRequests();try{http.terminalRequest(TerminalProtocol.list());fail();}catch(IOException expected){assertEquals("TERMINAL_CANCELLED",expected.getMessage());}
    }
    @Test public void actualWindowsShellUnderstandsAndroidSequenceAndReplay() throws Exception {
        String executable=System.getenv("CLIPRELAY_TERMINAL_TEST_WORKER");org.junit.Assume.assumeTrue(executable!=null && !executable.isEmpty());
        Process process=new ProcessBuilder(executable,"--terminal-probe").start();ExecutorService reader=Executors.newSingleThreadExecutor();
        BufferedReader input=new BufferedReader(new InputStreamReader(process.getInputStream(),StandardCharsets.UTF_8));
        String owner="a".repeat(64);
        try {
            call(process,input,reader,new JSONObject().put("op","sync").put("owners",new JSONArray().put(owner)));
            JSONObject listRequest=TerminalProtocol.list(), listRaw=call(process,input,reader,new JSONObject(listRequest.toString()).put("owner",owner));
            TerminalProtocol.Reply list=new TerminalProtocol.Reply(listRequest,listRaw);
            JSONObject open=TerminalProtocol.request("open",list.instance,ID).put("shell","cmd").put("columns",80).put("rows",24).put("sequence",list.nextOpen);
            TerminalSessionState state=new TerminalSessionState(list.instance,new TerminalProtocol.Reply(open,call(process,input,reader,new JSONObject(open.toString()).put("owner",owner))).session);
            String[] commands={"set CRCOUNT=0\r","set /a CRCOUNT+=1\r","echo CLIPRELAY_TERMINAL_COUNT_%CRCOUNT%\r"};
            for(int i=0;i<commands.length;i++){
                state.enqueue(commands[i].getBytes(StandardCharsets.UTF_8));JSONObject request=state.write();
                JSONObject ack=call(process,input,reader,new JSONObject(request.toString()).put("owner",owner));
                if(i==1) {JSONObject again=call(process,input,reader,new JSONObject(state.write().toString()).put("owner",owner));assertEquals(ack.getJSONObject("session").getLong("acceptedSequence"),again.getJSONObject("session").getLong("acceptedSequence"));ack=again;}
                state.acknowledge(new TerminalProtocol.Reply(request,ack));
            }
            ByteArrayOutputStream output=new ByteArrayOutputStream();long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);
            while(System.nanoTime()<deadline){JSONObject request=state.read();TerminalProtocol.Reply response=new TerminalProtocol.Reply(request,call(process,input,reader,new JSONObject(request.toString()).put("owner",owner)));state.consume(response);output.write(response.data);if(output.toString(StandardCharsets.UTF_8).contains("CLIPRELAY_TERMINAL_COUNT_1"))break;Thread.sleep(50);}
            assertTrue(output.toString(StandardCharsets.UTF_8).contains("CLIPRELAY_TERMINAL_COUNT_1"));
            JSONObject close=TerminalProtocol.request("close",list.instance,ID);
            assertFalse(new TerminalProtocol.Reply(close,call(process,input,reader,new JSONObject(close.toString()).put("owner",owner))).session.running());
        } finally {process.getOutputStream().close();if(!process.waitFor(5,TimeUnit.SECONDS))process.destroyForcibly();reader.shutdownNow();input.close();}
    }
    JSONObject call(Process process,BufferedReader reader,ExecutorService executor,JSONObject request) throws Exception {
        process.getOutputStream().write((request.toString()+"\n").getBytes(StandardCharsets.UTF_8));process.getOutputStream().flush();
        String line=executor.submit((Callable<String>)reader::readLine).get(10,TimeUnit.SECONDS);assertNotNull("worker exited",line);assertTrue(line.length()<=65536);
        JSONObject value=new JSONObject(line);assertTrue("worker operation failed",value.getBoolean("ok"));return value;
    }
}
