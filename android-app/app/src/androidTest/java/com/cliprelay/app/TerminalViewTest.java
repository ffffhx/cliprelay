package com.cliprelay.app;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.view.KeyEvent;
import android.view.MotionEvent;
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
    private static void touch(RemoteTerminalView view,int action,float x,float y){
        MotionEvent event=MotionEvent.obtain(0,0,action,x,y,0);try{view.onTouchEvent(event);}finally{event.recycle();}
    }
    @Test public void selectionBlocksHumanInputButPreservesLiveParserReplies(){check((view,output)->{
        InputConnection old=view.onCreateInputConnection(new EditorInfo());old.setComposingText("old",1);view.selecting(true);
        assertFalse(old.finishComposingText());assertFalse(view.send("key"));
        InputConnection during=view.onCreateInputConnection(new EditorInfo());assertFalse(during.commitText("key",1));
        view.append("\u001b[6n".getBytes(StandardCharsets.UTF_8),false);
        assertEquals("\u001b[1;1R",new String(output.toByteArray(),StandardCharsets.UTF_8));output.reset();
        view.selecting(false);assertFalse(old.commitText("old",1));assertFalse(during.commitText("old",1));assertTrue(view.send("new"));
        assertEquals("new",new String(output.toByteArray(),StandardCharsets.UTF_8));
    });}
    @Test public void changedOutputCancelsAnActiveSelectionGesture(){check((view,output)->{
        view.layout(0,0,800,480);view.append("中文🙂".getBytes(StandardCharsets.UTF_8),false);view.selecting(true);
        touch(view,MotionEvent.ACTION_DOWN,0,0);touch(view,MotionEvent.ACTION_MOVE,790,0);
        assertTrue(view.hasSelection());assertEquals("中文🙂",view.selectedText());
        view.append("new".getBytes(StandardCharsets.UTF_8),false);assertFalse(view.hasSelection());
        touch(view,MotionEvent.ACTION_MOVE,790,0);touch(view,MotionEvent.ACTION_UP,790,0);assertFalse(view.hasSelection());
        touch(view,MotionEvent.ACTION_DOWN,0,0);assertTrue(view.hasSelection());view.resize(40,10);assertFalse(view.hasSelection());
        touch(view,MotionEvent.ACTION_DOWN,0,0);view.reset(80,24);assertFalse(view.selecting());assertFalse(view.hasSelection());
    });}
    @Test public void canceledAndMultiTouchSelectionCannotLeaveHighlightedText(){check((view,output)->{
        view.layout(0,0,800,480);view.append("text".getBytes(StandardCharsets.UTF_8),false);view.selecting(true);
        touch(view,MotionEvent.ACTION_DOWN,0,0);touch(view,MotionEvent.ACTION_CANCEL,0,0);assertFalse(view.hasSelection());
        touch(view,MotionEvent.ACTION_DOWN,0,0);touch(view,MotionEvent.ACTION_POINTER_DOWN,0,0);assertFalse(view.hasSelection());
        touch(view,MotionEvent.ACTION_UP,0,0);assertFalse(view.hasSelection());assertEquals(0,output.size());
    });}
    @Test public void modalPreviewBlocksOldImeButExplicitPasteIsWhole(){check((view,output)->{
        InputConnection old=view.onCreateInputConnection(new EditorInfo());old.setComposingText("old",1);
        view.append("\u001b[?2004h".getBytes(StandardCharsets.UTF_8),false);view.inputBlocked(true);
        assertFalse(old.commitText("old",1));assertFalse(view.send("key"));assertTrue(view.pasteReviewed("中文\nnext"));
        assertEquals("\u001b[200~中文\rnext\u001b[201~",new String(output.toByteArray(),StandardCharsets.UTF_8));
        view.inputBlocked(false);assertFalse(old.commitText("old",1));view.accepting(false);assertFalse(view.pasteReviewed("late"));
    });}
    @Test public void rejectedPasteMakesOneCompleteInputAttempt(){
        InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{
            java.util.List<byte[]> attempts=new java.util.ArrayList<>();
            RemoteTerminalView view=new RemoteTerminalView(InstrumentationRegistry.getInstrumentation().getTargetContext(),new RemoteTerminalView.Listener(){
                public boolean input(byte[] bytes){attempts.add(bytes);return false;}
                public void size(int columns,int rows){}
            });view.accepting(true);view.append("\u001b[?2004h".getBytes(StandardCharsets.UTF_8),false);
            assertFalse(view.pasteReviewed("body"));assertEquals(1,attempts.size());
            assertArrayEquals("\u001b[200~body\u001b[201~".getBytes(StandardCharsets.UTF_8),attempts.get(0));view.accepting(false);
        });
    }
    private static void mouseProgram(RemoteTerminalView view){
        view.layout(0,0,800,480);view.append("\u001b[?1000h\u001b[?1006h".getBytes(StandardCharsets.UTF_8),false);
    }
    @Test public void terminalMouseRequiresExplicitModeAndOnlySendsACompleteTap(){check((view,output)->{
        mouseProgram(view);assertTrue(view.mouseAvailable());assertFalse(view.mouseEnabled());
        touch(view,MotionEvent.ACTION_DOWN,50,80);touch(view,MotionEvent.ACTION_UP,50,80);assertEquals(0,output.size());
        assertTrue(view.mouseEnabled(true));touch(view,MotionEvent.ACTION_DOWN,50,80);assertEquals(0,output.size());
        touch(view,MotionEvent.ACTION_UP,50,80);
        String text=new String(output.toByteArray(),StandardCharsets.UTF_8);
        assertTrue(text.matches("\u001b\\[<0;([0-9]+);([0-9]+)M\u001b\\[<0;\\1;\\2m"));
        output.reset();touch(view,MotionEvent.ACTION_UP,50,80);assertEquals(0,output.size());
    });}
    @Test public void mouseSwipeScrollsWithoutClickingAndOutsideOrMultitouchCancels(){check((view,output)->{
        mouseProgram(view);view.mouseEnabled(true);touch(view,MotionEvent.ACTION_DOWN,50,80);
        touch(view,MotionEvent.ACTION_MOVE,50,400);touch(view,MotionEvent.ACTION_UP,50,80);
        String text=new String(output.toByteArray(),StandardCharsets.UTF_8);assertTrue(text.contains("[<64;"));assertFalse(text.contains("[<0;"));assertFalse(text.contains("m"));
        output.reset();touch(view,MotionEvent.ACTION_DOWN,50,80);touch(view,MotionEvent.ACTION_MOVE,-1,80);touch(view,MotionEvent.ACTION_UP,50,80);assertEquals(0,output.size());
        touch(view,MotionEvent.ACTION_DOWN,50,80);touch(view,MotionEvent.ACTION_POINTER_DOWN,50,80);touch(view,MotionEvent.ACTION_UP,50,80);assertEquals(0,output.size());
    });}
    @Test public void mouseCandidatesDoNotSurviveResizeModalBackgroundOrSelection(){check((view,output)->{
        mouseProgram(view);view.mouseEnabled(true);touch(view,MotionEvent.ACTION_DOWN,50,80);view.resize(80,24);touch(view,MotionEvent.ACTION_UP,50,80);assertEquals(0,output.size());
        touch(view,MotionEvent.ACTION_DOWN,50,80);view.inputBlocked(true);view.inputBlocked(false);assertFalse(view.mouseEnabled());view.mouseEnabled(true);touch(view,MotionEvent.ACTION_UP,50,80);assertEquals(0,output.size());
        touch(view,MotionEvent.ACTION_DOWN,50,80);view.accepting(false);view.accepting(true);assertFalse(view.mouseEnabled());view.mouseEnabled(true);touch(view,MotionEvent.ACTION_UP,50,80);assertEquals(0,output.size());
        touch(view,MotionEvent.ACTION_DOWN,50,80);view.selecting(true);assertFalse(view.mouseEnabled());assertFalse(view.mouseEnabled(true));view.selecting(false);view.mouseEnabled(true);touch(view,MotionEvent.ACTION_UP,50,80);assertEquals(0,output.size());
    });}
    @Test public void mouseIsDisabledWhenTheProgramStopsTrackingOrTheViewLosesFocus(){check((view,output)->{
        mouseProgram(view);view.mouseEnabled(true);touch(view,MotionEvent.ACTION_DOWN,50,80);
        view.append("\u001b[?1000l".getBytes(StandardCharsets.UTF_8),false);assertFalse(view.mouseAvailable());assertFalse(view.mouseEnabled());
        view.append("\u001b[?1000h".getBytes(StandardCharsets.UTF_8),false);view.mouseEnabled(true);touch(view,MotionEvent.ACTION_UP,50,80);assertEquals(0,output.size());
        touch(view,MotionEvent.ACTION_DOWN,50,80);view.onWindowFocusChanged(false);assertFalse(view.mouseEnabled());view.mouseEnabled(true);touch(view,MotionEvent.ACTION_UP,50,80);assertEquals(0,output.size());
        view.reset(80,24);assertFalse(view.mouseEnabled());assertFalse(view.mouseAvailable());
    });}
    private static void wheel(RemoteTerminalView view,float axis){
        MotionEvent.PointerProperties properties=new MotionEvent.PointerProperties();properties.id=0;properties.toolType=MotionEvent.TOOL_TYPE_MOUSE;
        MotionEvent.PointerCoords coords=new MotionEvent.PointerCoords();coords.x=50;coords.y=80;coords.setAxisValue(MotionEvent.AXIS_VSCROLL,axis);
        MotionEvent event=MotionEvent.obtain(0,0,MotionEvent.ACTION_SCROLL,1,new MotionEvent.PointerProperties[]{properties},new MotionEvent.PointerCoords[]{coords},0,0,1,1,0,0,android.view.InputDevice.SOURCE_MOUSE,0);
        try{assertTrue(view.onGenericMotionEvent(event));}finally{event.recycle();}
    }
    @Test public void physicalWheelUsesRemoteModeAndRetainsSmallFractions(){check((view,output)->{
        mouseProgram(view);wheel(view,1);assertEquals(0,output.size());view.mouseEnabled(true);
        wheel(view,.5f);assertEquals(0,output.size());wheel(view,.5f);assertTrue(new String(output.toByteArray(),StandardCharsets.UTF_8).contains("[<64;"));
        output.reset();wheel(view,1000);String text=new String(output.toByteArray(),StandardCharsets.UTF_8);
        assertEquals(8,text.split("M",-1).length-1);assertFalse(text.contains("m"));
    });}
    @Test public void rejectingMouseInputReceivesBothEdgesInOneAttempt(){
        InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{
            java.util.List<byte[]> attempts=new java.util.ArrayList<>();
            RemoteTerminalView view=new RemoteTerminalView(InstrumentationRegistry.getInstrumentation().getTargetContext(),new RemoteTerminalView.Listener(){
                public boolean input(byte[] bytes){fail("mouse used the unguarded keyboard path");return false;}
                public boolean mouseInput(byte[] bytes){attempts.add(bytes);return false;}
                public void size(int columns,int rows){}
            });view.accepting(true);mouseProgram(view);view.mouseEnabled(true);
            touch(view,MotionEvent.ACTION_DOWN,50,80);assertTrue(attempts.isEmpty());touch(view,MotionEvent.ACTION_UP,50,80);assertEquals(1,attempts.size());
            String text=new String(attempts.get(0),StandardCharsets.UTF_8);assertTrue(text.contains("M\u001b[<0;"));assertTrue(text.endsWith("m"));
            touch(view,MotionEvent.ACTION_UP,50,80);assertEquals(1,attempts.size());view.accepting(false);
        });
    }
}
