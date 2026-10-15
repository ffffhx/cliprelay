package com.termux.view;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Typeface;
import android.text.Editable;
import android.text.InputType;
import android.text.SpannableStringBuilder;
import android.view.*;
import android.view.inputmethod.*;
import com.termux.terminal.*;
import com.limelight.terminal.TerminalClipboard;
import com.limelight.terminal.TerminalInputBatch;
import com.limelight.terminal.TerminalSelection;
import java.nio.charset.StandardCharsets;

/** Canvas and IME for a remote parser; never opens a local shell or obeys OSC clipboard requests. */
public final class RemoteTerminalView extends View {
    public interface Listener { boolean input(byte[] bytes); void size(int columns,int rows); default void selectionChanged() {} }
    private final Listener listener;
    private final TerminalRenderer renderer;
    private TerminalEmulator emulator;
    private boolean accepting, replaying, inputBlocked, selectingGesture;
    private final TerminalSelection selection=new TerminalSelection();
    private final TerminalInputBatch batch=new TerminalInputBatch();
    private int imeEpoch;
    private final Editable composition=new SpannableStringBuilder();
    private int topRow;
    private float touchY;
    private final TerminalSessionClient quietClient=new TerminalSessionClient() {};
    public RemoteTerminalView(Context context,Listener listener) {
        super(context);this.listener=listener;
        renderer=new TerminalRenderer(Math.max(12,(int)(14*getResources().getDisplayMetrics().scaledDensity)),Typeface.MONOSPACE);
        setFocusable(true);setFocusableInTouchMode(true);setBackgroundColor(0xff000000);
        setImportantForAutofill(IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        reset(80,24);
    }
    public void reset(int columns,int rows) {
        selection.enable(false);selectingGesture=false;invalidateIme();
        topRow=0;
        emulator=new TerminalEmulator(new TerminalOutput() {
            @Override public void write(byte[] data,int offset,int count) {
                if(batch.collect(data,offset,count))return;
                // Queries replayed from retained output must not inject a second response into the host.
                if(!replaying && accepting)listener.input(java.util.Arrays.copyOfRange(data,offset,offset+count));
            }
            @Override public void titleChanged(String oldTitle,String newTitle) {}
            @Override public void onCopyTextToClipboard(String text) {}
            @Override public void onPasteTextFromClipboard() {}
            @Override public void onBell() {}
            @Override public void onColorsChanged(){invalidate();}
        },columns,rows,(int)renderer.mFontWidth,renderer.mFontLineSpacing,2000,quietClient);
        invalidate();listener.selectionChanged();
    }
    public void accepting(boolean enabled){
        if(accepting==enabled)return;accepting=enabled;invalidateIme();
    }
    private void invalidateIme(){
        imeEpoch++;
        composition.clear();BaseInputConnection.removeComposingSpans(composition);
        ((InputMethodManager)getContext().getSystemService(Context.INPUT_METHOD_SERVICE)).restartInput(this);
    }
    public void inputBlocked(boolean blocked){if(inputBlocked!=blocked){inputBlocked=blocked;invalidateIme();}}
    private boolean humanInput(){return accepting && !inputBlocked && !selecting();}
    public boolean selecting(){return selection.enabled();}
    public void selecting(boolean enabled){
        if(selecting()==enabled)return;
        selection.enable(enabled);selectingGesture=false;invalidateIme();
        if(enabled)((InputMethodManager)getContext().getSystemService(Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(getWindowToken(),0);
        invalidate();listener.selectionChanged();
    }
    private void clearSelection(){selection.clear();selectingGesture=false;invalidate();listener.selectionChanged();}
    public boolean hasSelection(){return selection.range()!=null;}
    public String selectedText(){
        TerminalSelection.Range range=selection.range();
        return range==null?"":emulator.getSelectedText(range.x1,range.y1,range.x2,range.y2);
    }
    public void append(byte[] bytes,boolean replay) {
        if(bytes.length==0)return;
        clearSelection();
        replaying=replay;
        try {emulator.append(bytes,bytes.length);}
        finally {replaying=false;}
        topRow=Math.max(-emulator.getScreen().getActiveTranscriptRows(),topRow);
        invalidate();
    }
    public void resize(int columns,int rows){clearSelection();emulator.resize(columns,rows,(int)renderer.mFontWidth,renderer.mFontLineSpacing);topRow=0;invalidate();}
    public int columns(){return Math.max(20,Math.min(240,(int)(getWidth()/renderer.mFontWidth)));}
    public int rows(){return Math.max(5,Math.min(120,(getHeight()-renderer.mFontLineSpacingAndAscent)/renderer.mFontLineSpacing));}
    @Override protected void onSizeChanged(int w,int h,int oldw,int oldh){super.onSizeChanged(w,h,oldw,oldh);clearSelection();if(w>0 && h>0)listener.size(columns(),rows());}
    @Override protected void onDraw(Canvas canvas){
        super.onDraw(canvas);canvas.drawColor(emulator.mColors.mCurrentColors[TextStyle.COLOR_INDEX_BACKGROUND]);
        TerminalSelection.Range range=selection.range();
        renderer.render(emulator,canvas,topRow,range==null?-1:range.y1,range==null?-1:range.y2,range==null?-1:range.x1,range==null?-1:range.x2);
    }
    private int touchColumn(float x){return (int)Math.floor(x/renderer.mFontWidth);}
    private int touchRow(float y){return topRow+Math.max(0,Math.min(emulator.mRows-1,(int)Math.floor((y-renderer.mFontLineSpacingAndAscent)/renderer.mFontLineSpacing)));}
    @Override public boolean onTouchEvent(MotionEvent event) {
        if(inputBlocked)return true;
        if(selecting()) {
            int action=event.getActionMasked(),history=emulator.getScreen().getActiveTranscriptRows();
            if(action==MotionEvent.ACTION_DOWN) {
                selectingGesture=true;
                selection.start(touchColumn(event.getX()),touchRow(event.getY()),emulator.mColumns,emulator.mRows,history);
            } else if(action==MotionEvent.ACTION_MOVE && selectingGesture) {
                // Drag beyond the visible edge to extend into retained history, one row per event.
                if(event.getY()<renderer.mFontLineSpacingAndAscent)topRow=Math.max(-history,topRow-1);
                else if(event.getY()>=Math.min(getHeight(),renderer.mFontLineSpacingAndAscent+emulator.mRows*renderer.mFontLineSpacing))topRow=Math.min(0,topRow+1);
                selection.extend(touchColumn(event.getX()),touchRow(event.getY()),emulator.mColumns,emulator.mRows,history);
            } else if(action==MotionEvent.ACTION_UP) {
                if(selectingGesture)selection.extend(touchColumn(event.getX()),touchRow(event.getY()),emulator.mColumns,emulator.mRows,history);
                selectingGesture=false;performClick();
            } else if(action==MotionEvent.ACTION_CANCEL || action==MotionEvent.ACTION_POINTER_DOWN) {clearSelection();}
            invalidate();listener.selectionChanged();return true;
        }
        if(event.getActionMasked()==MotionEvent.ACTION_DOWN){touchY=event.getY();return true;}
        if(event.getActionMasked()==MotionEvent.ACTION_MOVE){int lines=(int)((event.getY()-touchY)/renderer.mFontLineSpacing);if(lines!=0){topRow=Math.max(-emulator.getScreen().getActiveTranscriptRows(),Math.min(0,topRow-lines));touchY=event.getY();invalidate();}return true;}
        if(event.getActionMasked()==MotionEvent.ACTION_UP){performClick();return true;}return true;
    }
    @Override public boolean performClick(){super.performClick();requestFocus();return true;}
    public void keyboard(){if(!humanInput())return;requestFocus();((InputMethodManager)getContext().getSystemService(Context.INPUT_METHOD_SERVICE)).showSoftInput(this,InputMethodManager.SHOW_IMPLICIT);}
    public boolean send(String text) {
        if(!humanInput() || text.length()>16384)return false;
        boolean sent=listener.input(text.getBytes(StandardCharsets.UTF_8));if(sent){topRow=0;invalidate();}return sent;
    }
    /** Called only by the Activity's current, explicitly confirmed preview dialog. */
    public boolean pasteReviewed(String text) {
        if(!accepting || selecting())return false;
        String prepared=TerminalClipboard.prepare(text);
        if(prepared.isEmpty() || !prepared.equals(text))return false;
        byte[] encoded=batch.capture(TerminalClipboard.MAX_BATCH_BYTES,()->emulator.paste(prepared));
        boolean sent=listener.input(encoded);if(sent){topRow=0;invalidate();}return sent;
    }
    public void key(int code) {
        String text=KeyHandler.getCode(code,0,emulator.isCursorKeysApplicationMode(),emulator.isKeypadApplicationMode());
        if(text!=null)send(text);
    }
    @Override public boolean onKeyDown(int code,KeyEvent event) {
        if(code==KeyEvent.KEYCODE_BACK)return super.onKeyDown(code,event);
        int modifiers=(event.isShiftPressed()?KeyHandler.KEYMOD_SHIFT:0)|(event.isAltPressed()?KeyHandler.KEYMOD_ALT:0)|(event.isCtrlPressed()?KeyHandler.KEYMOD_CTRL:0);
        String special=KeyHandler.getCode(code,modifiers,emulator.isCursorKeysApplicationMode(),emulator.isKeypadApplicationMode());
        if(special!=null){send(special);return true;}
        int cp=event.getUnicodeChar(event.getMetaState() & ~KeyEvent.META_CTRL_MASK);
        if(cp>0 && (cp&KeyCharacterMap.COMBINING_ACCENT)==0){
            if(event.isCtrlPressed()) {if(cp>='a' && cp<='z')cp-=96;else if(cp>='@' && cp<='_')cp-=64;else if(cp==' ')cp=0;else if(cp=='?')cp=127;else return true;}
            send((event.isAltPressed()?"\u001b":"")+new String(Character.toChars(cp)));return true;
        }
        return super.onKeyDown(code,event);
    }
    @Override public boolean onKeyUp(int code,KeyEvent event){return code!=KeyEvent.KEYCODE_BACK || super.onKeyUp(code,event);}
    @Override public boolean onCheckIsTextEditor(){return true;}
    @Override public InputConnection onCreateInputConnection(EditorInfo info) {
        info.inputType=InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD|InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS;
        info.imeOptions=EditorInfo.IME_FLAG_NO_EXTRACT_UI|EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING|EditorInfo.IME_ACTION_NONE;
        final int generation=++imeEpoch;composition.clear();BaseInputConnection.removeComposingSpans(composition);
        return new BaseInputConnection(this,true) {
            private boolean closed;
            private boolean current(){return !closed && humanInput() && generation==imeEpoch;}
            @Override public Editable getEditable(){return composition;}
            @Override public void closeConnection(){
                if(current()){composition.clear();removeComposingSpans(composition);}
                closed=true;super.closeConnection();
            }
            @Override public boolean commitText(CharSequence text,int cursor){if(!current())return false;boolean result=send(text.toString());if(result){composition.clear();removeComposingSpans(composition);}return result;}
            @Override public boolean setComposingText(CharSequence text,int cursor){return current() && super.setComposingText(text,cursor);}
            @Override public boolean finishComposingText(){if(!current())return false;if(composition.length()>0){boolean result=send(composition.toString());if(!result)return false;composition.clear();}removeComposingSpans(composition);return true;}
            @Override public boolean deleteSurroundingText(int before,int after){
                if(!current())return false;
                if(composition.length()>0)return super.deleteSurroundingText(before,after);
                if(before<0 || after<0 || before>64 || after>64 || before+after>64)return false;
                StringBuilder text=new StringBuilder();for(int i=0;i<before;i++)text.append('\u007f');for(int i=0;i<after;i++)text.append("\u001b[3~");return text.length()==0 || send(text.toString());
            }
            @Override public boolean deleteSurroundingTextInCodePoints(int before,int after){return deleteSurroundingText(before,after);}
            @Override public boolean sendKeyEvent(KeyEvent event){return current() && (event.getAction()==KeyEvent.ACTION_DOWN?onKeyDown(event.getKeyCode(),event):onKeyUp(event.getKeyCode(),event));}
            @Override public boolean performEditorAction(int action){return current() && send("\r");}
        };
    }
}
