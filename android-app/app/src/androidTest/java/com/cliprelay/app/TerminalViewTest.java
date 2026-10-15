package com.cliprelay.app;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.view.KeyEvent;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.termux.view.RemoteTerminalView;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

/** Device-only: compile with QA; do not substitute JVM Android stubs for these checks. */
@RunWith(AndroidJUnit4.class)
public class TerminalViewTest {
    interface Check {void run(RemoteTerminalView view,ByteArrayOutputStream output);}
    private void check(Check check){InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{
        ByteArrayOutputStream output=new ByteArrayOutputStream();
        RemoteTerminalView view=new RemoteTerminalView(InstrumentationRegistry.getInstrumentation().getTargetContext(),new RemoteTerminalView.Listener(){
            public boolean input(byte[] bytes){output.write(bytes,0,bytes.length);return true;}
            public void size(int columns,int rows){}
        });view.accepting(true);check.run(view,output);view.accepting(false);
    });}
    @Test public void compositionIsSentOnceOnlyAfterCommit(){check((view,output)->{
        InputConnection ime=view.onCreateInputConnection(new EditorInfo());
        assertTrue(ime.setComposingText("zhong",1));assertTrue(ime.setComposingText("中文",1));assertEquals(0,output.size());
        assertTrue(ime.commitText("中文",1));assertTrue(ime.finishComposingText());
        assertEquals("中文",new String(output.toByteArray(),StandardCharsets.UTF_8));
    });}
    @Test public void backgroundInvalidatesPendingCompositionAndOldIme(){check((view,output)->{
        InputConnection old=view.onCreateInputConnection(new EditorInfo());old.setComposingText("danger",1);
        view.accepting(false);assertFalse(old.finishComposingText());view.accepting(true);assertFalse(old.commitText("danger",1));
        assertEquals(0,output.size());InputConnection current=view.onCreateInputConnection(new EditorInfo());
        assertTrue(current.commitText("safe",1));assertEquals("safe",new String(output.toByteArray(),StandardCharsets.UTF_8));
    });}
    @Test public void editorEnterAndHardwareControlProduceSingleBytes(){check((view,output)->{
        InputConnection ime=view.onCreateInputConnection(new EditorInfo());assertTrue(ime.performEditorAction(EditorInfo.IME_ACTION_NONE));
        view.onKeyDown(KeyEvent.KEYCODE_C,new KeyEvent(0,0,KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_C,0,KeyEvent.META_CTRL_ON));
        assertArrayEquals(new byte[]{13,3},output.toByteArray());
    });}
    @Test public void changingSessionInvalidatesThePreviousInputConnection(){check((view,output)->{
        InputConnection old=view.onCreateInputConnection(new EditorInfo());old.setComposingText("old command",1);
        view.reset(80,24);assertFalse(old.commitText("old command",1));assertEquals(0,output.size());
        InputConnection current=view.onCreateInputConnection(new EditorInfo());assertTrue(current.commitText("new",1));
        assertEquals("new",new String(output.toByteArray(),StandardCharsets.UTF_8));
    });}
    @Test public void closingKeyboardDoesNotCommitAnUnconfirmedCandidate(){check((view,output)->{
        InputConnection ime=view.onCreateInputConnection(new EditorInfo());ime.setComposingText("candidate",1);ime.closeConnection();
        assertEquals(0,output.size());assertFalse(ime.commitText("candidate",1));
    });}
    @Test public void replaySuppressesQueriesAndOscCannotWriteClipboard(){check((view,output)->{
        byte[] query="\u001b[6n".getBytes(StandardCharsets.UTF_8);view.append(query,true);assertEquals(0,output.size());
        view.append(query,false);assertTrue(output.size()>0);output.reset();
        view.append("\u001b]52;c;dW50cnVzdGVk\u0007".getBytes(StandardCharsets.UTF_8),false);assertEquals(0,output.size());
    });}
    @Test public void vtCanvasDrawsUnicodeAtMeasuredGrid(){check((view,output)->{
        view.layout(0,0,800,480);assertTrue(view.columns()>=20 && view.rows()>=5);view.resize(view.columns(),view.rows());
        view.append("\u001b[31m中文\u001b[0m\r\nhello".getBytes(StandardCharsets.UTF_8),false);
        Bitmap bitmap=Bitmap.createBitmap(800,480,Bitmap.Config.ARGB_8888);view.draw(new Canvas(bitmap));
        boolean visible=false;for(int y=0;y<Math.min(180,bitmap.getHeight());y++)for(int x=0;x<Math.min(200,bitmap.getWidth());x++)if((bitmap.getPixel(x,y)&0xffffff)!=0)visible=true;
        assertTrue("terminal glyphs were not rendered",visible);bitmap.recycle();
    });}
}
