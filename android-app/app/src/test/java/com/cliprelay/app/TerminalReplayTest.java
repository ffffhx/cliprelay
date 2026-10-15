package com.cliprelay.app;

import com.limelight.terminal.TerminalReplay;
import com.termux.terminal.*;
import org.junit.Test;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

public class TerminalReplayTest {
    private static final class Fixture {
        boolean replay;
        final ByteArrayOutputStream replies=new ByteArrayOutputStream();
        final TerminalEmulator emulator=new TerminalEmulator(new TerminalOutput() {
            public void write(byte[] data,int offset,int count){if(!replay)replies.write(data,offset,count);}
            public void titleChanged(String oldTitle,String newTitle){}
            public void onCopyTextToClipboard(String text){}
            public void onPasteTextFromClipboard(){}
            public void onBell(){}
            public void onColorsChanged(){}
        },80,24,8,16,2000,new TerminalSessionClient(){});
        void append(byte[] bytes,long offset,long end){TerminalReplay.append(bytes,offset,end,(part,retained)->{
            replay=retained;try{emulator.append(part,part.length);}finally{replay=false;}
        });}
        String reply(){return new String(replies.toByteArray(),StandardCharsets.UTF_8);}
    }
    private static byte[] bytes(String text){return text.getBytes(StandardCharsets.UTF_8);}

    @Test public void historicalAndLiveQueriesInOneReadOnlyAnswerTheLiveQuery(){
        Fixture f=new Fixture();String old="old\u001b[6n",live="live\u001b[6n";
        f.append(bytes(old+live),100,100+bytes(old).length);
        assertEquals("\u001b[1;8R",f.reply());
        assertEquals("oldlive",f.emulator.getSelectedText(0,0,6,0));
    }
    @Test public void boundaryInsideUnicodePreservesTheSameParser(){
        Fixture f=new Fixture();byte[] data=bytes("中🙂\u001b[6n");
        f.append(data,800,802);
        assertEquals("中🙂",f.emulator.getSelectedText(0,0,3,0));
        assertEquals("\u001b[1;5R",f.reply());
    }
    @Test public void queryCompletedByNewBytesIsAnsweredOnce(){
        Fixture f=new Fixture();f.append(bytes("text\u001b[6n"),50,57);
        assertEquals("\u001b[1;5R",f.reply());
    }
    @Test public void gapUsesTheActualReplyOffsetAndNextLiveReadResumesReplies(){
        Fixture f=new Fixture();byte[] retained=bytes("\u001b[6n");
        // The host has already expired the original offset; all retained data stays replay.
        f.append(retained,900,900+retained.length);
        assertEquals("",f.reply());
        f.append(bytes("\u001b[6n"),900+retained.length,900+retained.length);
        assertEquals("\u001b[1;1R",f.reply());
        f.append(new byte[0],1000,900+retained.length);
        assertEquals("\u001b[1;1R",f.reply());
    }
}
