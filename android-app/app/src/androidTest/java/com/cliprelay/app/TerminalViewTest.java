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
    private static final class MouseView implements RemoteTerminalView.Listener {
        final java.util.List<com.limelight.terminal.TerminalMouseState.Event> events=new java.util.ArrayList<>();
        final RemoteTerminalView view;
        int cancels;boolean accept=true;
        MouseView(){
            view=new RemoteTerminalView(InstrumentationRegistry.getInstrumentation().getTargetContext(),this);
            view.accepting(true);view.layout(0,0,800,480);view.outputApplied(10);draw();configure(1002,1006,1,0,true);
        }
        void configure(int mode,int format,long epoch,long revision,boolean ready){
            try {
                org.json.JSONObject m=new org.json.JSONObject().put("mode",mode).put("format",format).put("epoch",epoch).put("offset",10)
                        .put("gesture",0).put("nextGesture",1).put("buttons",0).put("remainingMs",0).put("acceptedSequence",0).put("writtenSequence",0).put("phase","idle").put("outcome","none");
                view.configureMouse(new com.limelight.terminal.TerminalProtocol.Mouse(m,10),revision,ready);
            }catch(org.json.JSONException error){throw new AssertionError(error);}
        }
        void draw(){Bitmap bitmap=Bitmap.createBitmap(800,480,Bitmap.Config.ARGB_8888);view.draw(new Canvas(bitmap));bitmap.recycle();}
        public boolean input(byte[] bytes){fail("mouse reached raw keyboard input");return false;}
        public boolean mouseEvent(com.limelight.terminal.TerminalMouseState.Event event){events.add(event);return accept;}
        public void mouseCancelled(){cancels++;}
        public void size(int columns,int rows){}
    }
    interface MouseCheck {void run(MouseView mouse);}
    private void mouseCheck(MouseCheck check){InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{
        MouseView mouse=new MouseView();try{check.run(mouse);}finally{mouse.view.accepting(false);}
    });}
    @Test public void typedTouchSendsPressAndLiveMotionBeforeLift(){mouseCheck(m->{
        touch(m.view,MotionEvent.ACTION_DOWN,50,80);touch(m.view,MotionEvent.ACTION_UP,50,80);assertTrue(m.events.isEmpty());
        assertTrue(m.view.mouseEnabled(true));touch(m.view,MotionEvent.ACTION_DOWN,50,80);assertEquals("press",m.events.get(0).action);
        touch(m.view,MotionEvent.ACTION_MOVE,100,120);assertEquals("move",m.events.get(1).action);
        touch(m.view,MotionEvent.ACTION_UP,100,120);assertEquals("release",m.events.get(2).action);
        touch(m.view,MotionEvent.ACTION_UP,100,120);assertEquals(3,m.events.size());
    });}
    @Test public void typedMouseCancelsOutsideOrMultitouchWithoutLateRelease(){mouseCheck(m->{
        m.view.mouseEnabled(true);touch(m.view,MotionEvent.ACTION_DOWN,50,80);touch(m.view,MotionEvent.ACTION_MOVE,-1,80);touch(m.view,MotionEvent.ACTION_UP,50,80);
        assertEquals(1,m.events.size());int cancels=m.cancels;
        touch(m.view,MotionEvent.ACTION_DOWN,50,80);touch(m.view,MotionEvent.ACTION_POINTER_DOWN,50,80);touch(m.view,MotionEvent.ACTION_UP,50,80);
        assertEquals(2,m.events.size());assertTrue(m.cancels>cancels);
    });}
    @Test public void resizeModalBackgroundSelectionAndFocusCancelTypedGestures(){mouseCheck(m->{
        Runnable[] changes={()->m.view.resize(80,24),()->m.view.inputBlocked(true),()->m.view.accepting(false),()->m.view.selecting(true),()->m.view.onWindowFocusChanged(false)};
        for(Runnable change:changes){
            m.view.accepting(true);m.view.inputBlocked(false);m.view.selecting(false);m.draw();m.configure(1002,1006,1,0,true);m.view.mouseEnabled(true);
            touch(m.view,MotionEvent.ACTION_DOWN,50,80);int n=m.events.size(),c=m.cancels;change.run();touch(m.view,MotionEvent.ACTION_UP,50,80);
            assertEquals(n,m.events.size());assertTrue(m.cancels>c);
        }
    });}
    @Test public void hostModeAndRevisionReplaceTermuxMouseTrackingWithoutReusingGestures(){mouseCheck(m->{
        assertFalse(m.view.legacyMouseRequested());m.configure(1003,1006,1,0,true);assertTrue(m.view.mouseAvailable());m.view.mouseEnabled(true);
        touch(m.view,MotionEvent.ACTION_DOWN,50,80);m.configure(1003,1006,2,1,true);touch(m.view,MotionEvent.ACTION_MOVE,100,120);touch(m.view,MotionEvent.ACTION_UP,100,120);
        assertEquals(1,m.events.size());m.configure(0,1006,3,2,true);assertFalse(m.view.mouseAvailable());assertFalse(m.view.mouseEnabled());
    });}
    private static void physical(RemoteTerminalView view,int action,int buttons,int meta,float vertical,float horizontal){
        MotionEvent.PointerProperties p=new MotionEvent.PointerProperties();p.id=0;p.toolType=MotionEvent.TOOL_TYPE_MOUSE;
        MotionEvent.PointerCoords c=new MotionEvent.PointerCoords();c.x=50;c.y=80;c.setAxisValue(MotionEvent.AXIS_VSCROLL,vertical);c.setAxisValue(MotionEvent.AXIS_HSCROLL,horizontal);
        MotionEvent e=MotionEvent.obtain(0,0,action,1,new MotionEvent.PointerProperties[]{p},new MotionEvent.PointerCoords[]{c},meta,buttons,1,1,0,0,android.view.InputDevice.SOURCE_MOUSE,0);
        try{if(action==MotionEvent.ACTION_DOWN || action==MotionEvent.ACTION_MOVE || action==MotionEvent.ACTION_UP)view.onTouchEvent(e);else view.onGenericMotionEvent(e);}finally{e.recycle();}
    }
    @Test public void externalButtonEventsDeduplicateAndPreserveMiddleRightModifiers(){mouseCheck(m->{
        m.view.mouseEnabled(true);int right=MotionEvent.BUTTON_SECONDARY,middle=MotionEvent.BUTTON_TERTIARY;
        physical(m.view,MotionEvent.ACTION_DOWN,right,KeyEvent.META_SHIFT_ON,0,0);
        physical(m.view,MotionEvent.ACTION_BUTTON_PRESS,right,KeyEvent.META_SHIFT_ON,0,0);assertEquals(1,m.events.size());assertEquals(2,m.events.get(0).button);assertEquals(4,m.events.get(0).modifiers);
        physical(m.view,MotionEvent.ACTION_BUTTON_PRESS,right|middle,KeyEvent.META_ALT_ON,0,0);assertEquals(1,m.events.get(1).button);
        physical(m.view,MotionEvent.ACTION_MOVE,right|middle,KeyEvent.META_CTRL_ON,0,0);assertEquals(16,m.events.get(2).modifiers);
        physical(m.view,MotionEvent.ACTION_BUTTON_RELEASE,0,0,0,0);physical(m.view,MotionEvent.ACTION_UP,0,0,0,0);assertEquals(5,m.events.size());
    });}
    @Test public void externalHoverAndBothWheelAxesStayBounded(){mouseCheck(m->{
        m.configure(1003,1006,1,0,true);m.view.mouseEnabled(true);
        physical(m.view,MotionEvent.ACTION_HOVER_MOVE,0,KeyEvent.META_SHIFT_ON,0,0);assertEquals(3,m.events.get(0).button);
        physical(m.view,MotionEvent.ACTION_SCROLL,0,0,.5f,0);assertEquals(1,m.events.size());physical(m.view,MotionEvent.ACTION_SCROLL,0,0,.5f,0);assertEquals(0,m.events.get(1).button);
        physical(m.view,MotionEvent.ACTION_SCROLL,0,KeyEvent.META_CTRL_ON,1000,1000);assertEquals(18,m.events.size());assertEquals(3,m.events.get(17).button);assertEquals(16,m.events.get(17).modifiers);
    });}
    @Test public void rejectedPressDoesNotLeaveAMoveOrReleaseCandidate(){mouseCheck(m->{
        m.accept=false;m.view.mouseEnabled(true);touch(m.view,MotionEvent.ACTION_DOWN,50,80);touch(m.view,MotionEvent.ACTION_MOVE,100,120);touch(m.view,MotionEvent.ACTION_UP,100,120);
        assertEquals(1,m.events.size());assertEquals("press",m.events.get(0).action);assertTrue(m.cancels>0);
    });}
    @Test public void mouseWaitsForDrawnOutputAndOldHostsDoNotSendOpaqueReports(){check((view,output)->{
        view.layout(0,0,800,480);view.outputApplied(10);assertFalse(view.displayReady(10,80,24));
        Bitmap bitmap=Bitmap.createBitmap(800,480,Bitmap.Config.ARGB_8888);view.draw(new Canvas(bitmap));bitmap.recycle();assertTrue(view.displayReady(10,80,24));
        view.append("\u001b[?1000h\u001b[?1006h".getBytes(StandardCharsets.UTF_8),false);assertTrue(view.legacyMouseRequested());assertFalse(view.mouseAvailable());assertFalse(view.mouseEnabled(true));
        touch(view,MotionEvent.ACTION_DOWN,50,80);touch(view,MotionEvent.ACTION_UP,50,80);assertEquals(0,output.size());
        view.resize(80,24);assertFalse(view.displayReady(10,80,24));
    });}
    @Test public void returningFromHistoryWaitsForTheLiveViewportToDraw(){mouseCheck(m->{
        m.view.append("row\r\n".repeat(30).getBytes(StandardCharsets.UTF_8),false);m.draw();
        physical(m.view,MotionEvent.ACTION_SCROLL,0,0,2,0);m.draw();assertTrue(m.view.mouseEnabled(true));
        assertFalse(m.view.displayReady(10,80,24));touch(m.view,MotionEvent.ACTION_DOWN,50,80);touch(m.view,MotionEvent.ACTION_UP,50,80);assertTrue(m.events.isEmpty());
        m.draw();touch(m.view,MotionEvent.ACTION_DOWN,50,80);assertEquals("press",m.events.get(0).action);
    });}
}
