package com.limelight.herdr;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.text.Layout;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.StaticLayout;
import android.text.TextDirectionHeuristics;
import android.text.TextPaint;
import android.text.style.BackgroundColorSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.StrikethroughSpan;
import android.text.style.StyleSpan;
import android.text.style.UnderlineSpan;
import android.text.style.LeadingMarginSpan;
import android.text.style.LineHeightSpan;
import android.text.style.RelativeSizeSpan;
import android.text.style.TypefaceSpan;
import android.view.GestureDetector;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;
import android.os.Bundle;
import android.widget.OverScroller;
import com.termux.terminal.TerminalBuffer;
import com.termux.terminal.TerminalEmulator;
import com.termux.terminal.TerminalOutput;
import com.termux.terminal.TerminalRow;
import com.termux.terminal.TerminalSessionClient;
import com.termux.terminal.TextStyle;
import com.termux.terminal.WcWidth;
import java.util.ArrayList;

/** Wraps the parsed terminal text to the phone width without resizing the shared PTY. */
public final class HerdrTerminalView extends View {
    private final HerdrPalette colors;
    private final TextPaint paint=new TextPaint(Paint.ANTI_ALIAS_FLAG);
    private final Paint cursorPaint=new Paint(Paint.ANTI_ALIAS_FLAG);
    private final ScaleGestureDetector scale;
    private final GestureDetector gesture;
    private final OverScroller scroller;
    private TerminalEmulator emulator;
    private StaticLayout layout;
    private SpannableStringBuilder text=new SpannableStringBuilder();
    private boolean dirty=true,followCursor=true;
    private float zoom=1,offsetY;
    private int cursorOffset;
    private boolean codex,conversation,hideCursor,cursorVisible;
    private java.util.concurrent.ExecutorService renderer;
    private boolean rendering;
    private int renderGeneration;
    private long layoutBuildNanos;
    private boolean dragging;
    private RenderFrame deferredFrame;
    private long firstChangeAt,lastChangeAt;
    private String modelLabel="";
    private java.util.function.Consumer<String> modelListener;

    public HerdrTerminalView(Context context) {
        super(context);colors=new HerdrPalette(context);
        paint.setTypeface(Typeface.MONOSPACE);paint.setColor(colors.ink);cursorPaint.setColor(colors.primary);
        int pad=dp(10);setPadding(pad,dp(8),pad,dp(8));setBackgroundColor(colors.surface);
        if(android.os.Build.VERSION.SDK_INT>=29)setForceDarkAllowed(false);
        setContentDescription("Herdr 实时终端，上下滑动查看历史，点击输入");
        setVerticalScrollBarEnabled(true);
        scroller=new OverScroller(context);
        scale=new ScaleGestureDetector(context,new ScaleGestureDetector.SimpleOnScaleGestureListener(){
            @Override public boolean onScale(ScaleGestureDetector detector){changeTextScale(detector.getScaleFactor());return true;}
        });
        scale.setQuickScaleEnabled(false);
        gesture=new GestureDetector(context,new GestureDetector.SimpleOnGestureListener(){
            @Override public boolean onDown(MotionEvent e){scroller.forceFinished(true);ensureLayout();return true;}
            @Override public boolean onScroll(MotionEvent a,MotionEvent b,float dx,float dy){
                if(!scale.isInProgress()){dragging=true;scrollByTouch(dy);}return true;
            }
            @Override public boolean onFling(MotionEvent a,MotionEvent b,float vx,float vy){
                if(!scale.isInProgress()){followCursor=false;scroller.fling(0,(int)offsetY,0,(int)-vy,0,0,0,maxOffset());postInvalidateOnAnimation();}return true;
            }
            @Override public boolean onSingleTapUp(MotionEvent e){performClick();return true;}
        });
        // There is no long-press action here; a held finger must still be able to scroll.
        gesture.setIsLongpressEnabled(false);
        reset(80,24);
    }
    private int dp(int n){return Math.round(n*getResources().getDisplayMetrics().density);}
    public void setAgent(String agent){codex="codex".equals(agent);conversation=agent!=null&&!agent.isEmpty();changed();}
    public void setModelListener(java.util.function.Consumer<String> listener){modelListener=listener;listener.accept(modelLabel);}
    public String getModelLabel(){return modelLabel;}
    private void model(String value){if(!modelLabel.equals(value)){modelLabel=value;if(modelListener!=null)modelListener.accept(value);}}
    private void scrollByTouch(float dy){
        ensureLayout();followCursor=false;
        // Reading is local pixel scrolling, including at either edge. Never
        // translate a gesture into terminal keys that replace the whole screen.
        offsetY=Math.max(0,Math.min(maxOffset(),offsetY+dy));awakenScrollBars();invalidate();
    }
    public void reset(int columns,int rows) {
        renderGeneration++;rendering=false;deferredFrame=null;dragging=false;
        model("");
        scroller.forceFinished(true);layout=null;text=new SpannableStringBuilder();
        emulator=new TerminalEmulator(new TerminalOutput(){
            @Override public void write(byte[] data,int offset,int count) {}
            @Override public void titleChanged(String oldTitle,String newTitle) {}
            @Override public void onCopyTextToClipboard(String value) {}
            @Override public void onPasteTextFromClipboard() {}
            @Override public void onBell() {}
            @Override public void onColorsChanged(){changed();}
        },columns,rows,dp(8),dp(20),2000,new TerminalSessionClient(){});
        followCursor=true;offsetY=0;changed();
    }
    public void resize(int columns,int rows){emulator.resize(columns,rows,dp(8),dp(20));changed();}
    public void append(byte[] data){emulator.append(data,data.length);changed();}
    private void changed(){long now=android.os.SystemClock.uptimeMillis();if(!dirty)firstChangeAt=now;lastChangeAt=now;dirty=true;invalidate();}
    public void changeTextScale(float factor){zoom=Math.max(12f/14,Math.min(22f/14,zoom*factor));changed();}
    public void latest(){scroller.forceFinished(true);dragging=false;followCursor=true;ensureLayout();follow();invalidate();}
    @Override protected void onSizeChanged(int w,int h,int ow,int oh){super.onSizeChanged(w,h,ow,oh);if(w!=ow)changed();else{if(followCursor)follow();else offsetY=Math.max(0,Math.min(offsetY,maxOffset()));invalidate();}}

    private static final class RowSnapshot {
        char[] chars;long[] styles;boolean wrapped;int cursor=-1;
    }
    private static final class ScreenSnapshot {
        java.util.ArrayList<RowSnapshot> rows=new java.util.ArrayList<>();
        int[] palette;int width,columns;boolean codex,conversation,reverse,cursorVisible;TextPaint paint;
    }
    private static final class RenderFrame {
        SpannableStringBuilder text;StaticLayout layout;int cursor;boolean hideCursor,cursorVisible;long nanos;String model;
    }
    private static final class Run {
        final int start,end;final long style;
        Run(int start,int end,long style){this.start=start;this.end=end;this.style=style;}
    }
    private ScreenSnapshot snapshot(){
        ScreenSnapshot result=new ScreenSnapshot();TerminalBuffer screen=emulator.getScreen();
        result.palette=emulator.mColors.mCurrentColors.clone();result.codex=codex;result.conversation=conversation;result.reverse=emulator.isReverseVideo();
        result.cursorVisible=emulator.shouldCursorBeVisible();result.width=getWidth()-getPaddingLeft()-getPaddingRight();result.columns=emulator.mColumns;
        paint.setTypeface(conversation?Typeface.create("sans-serif",Typeface.NORMAL):Typeface.MONOSPACE);
        paint.setTextSize(14*zoom*getResources().getDisplayMetrics().scaledDensity);result.paint=new TextPaint(paint);
        int last=emulator.getCursorRow();
        for(int r=emulator.mRows-1;r>last;r--){
            TerminalRow row=screen.allocateFullLineIfNecessary(screen.externalToInternalRow(r));
            boolean nonempty=false;for(int i=0;i<row.getSpaceUsed();i++)if(row.mText[i]!=' '){nonempty=true;break;}
            if(nonempty){last=r;break;}
        }
        for(int r=-screen.getActiveTranscriptRows();r<=last;r++){
            TerminalRow row=screen.allocateFullLineIfNecessary(screen.externalToInternalRow(r));RowSnapshot copy=new RowSnapshot();
            copy.chars=java.util.Arrays.copyOf(row.mText,row.getSpaceUsed());copy.styles=new long[emulator.mColumns];
            for(int c=0;c<copy.styles.length;c++)copy.styles[c]=row.getStyle(c);
            copy.wrapped=screen.getLineWrap(r);if(r==emulator.getCursorRow())copy.cursor=row.findStartOfColumn(emulator.getCursorCol());
            result.rows.add(copy);
        }
        return result;
    }
    private void ensureLayout(){
        // Keep one immutable layout for the whole drag/fling. Updating its height,
        // anchor or scroll bounds mid-gesture makes the content jump under the finger.
        if(isAttachedToWindow()&&layout!=null&&(dragging||!scroller.isFinished()))return;
        if(deferredFrame!=null){RenderFrame frame=deferredFrame;deferredFrame=null;if(!dirty)applyFrame(frame);}
        if(!dirty||rendering||getWidth()<=getPaddingLeft()+getPaddingRight())return;
        // A terminal repaint can arrive in several chunks; don't expose its
        // transient clear-screen frame. Still publish continuous output every 100 ms.
        long now=android.os.SystemClock.uptimeMillis();
        if(layout!=null&&isAttachedToWindow()&&now-lastChangeAt<32&&now-firstChangeAt<100){postInvalidateDelayed(32-(now-lastChangeAt));return;}
        ScreenSnapshot input=snapshot();dirty=false;
        // An unattached view can be rendered synchronously for exports. Visible views
        // retain their last frame while shaping/layout happens off the touch thread.
        if(!isAttachedToWindow()){applyFrame(render(input));return;}
        if(renderer==null)renderer=java.util.concurrent.Executors.newSingleThreadExecutor(r->{Thread t=new Thread(r,"Herdr text layout");t.setDaemon(true);return t;});
        rendering=true;final int generation=renderGeneration;
        renderer.execute(()->{
            RenderFrame frame=render(input);
            post(()->{if(generation!=renderGeneration)return;rendering=false;
                if(layout!=null&&(dragging||!scroller.isFinished()))deferredFrame=frame;else applyFrame(frame);
                if(dirty)postInvalidateOnAnimation();});
        });
    }
    private void applyFrame(RenderFrame frame){
        float oldOffset=offsetY;String anchor="";float anchorY=0;
        if(!followCursor&&layout!=null){
            int first=layout.getLineForVertical((int)offsetY);
            String next=frame.text.toString();
            for(int line=first;line<Math.min(layout.getLineCount(),first+8);line++){
                String candidate=text.subSequence(layout.getLineStart(line),layout.getLineEnd(line)).toString();
                int at=next.indexOf(candidate);
                if(candidate.trim().length()>=8&&at>=0&&at==next.lastIndexOf(candidate)){
                    anchor=candidate;anchorY=layout.getLineTop(line)-offsetY;break;
                }
            }
        }
        text=frame.text;layout=frame.layout;cursorOffset=frame.cursor;hideCursor=frame.hideCursor;cursorVisible=frame.cursorVisible;layoutBuildNanos=frame.nanos;
        if(frame.model!=null)model(frame.model);
        if(followCursor)follow();else{
            if(!anchor.isEmpty()){
                String next=text.toString();int at=next.indexOf(anchor);
                if(at>=0&&at==next.lastIndexOf(anchor))offsetY=layout.getLineTop(layout.getLineForOffset(at))-anchorY;
            }
            offsetY=Math.max(0,Math.min(offsetY,maxOffset()));
            if(Math.abs(offsetY-oldOffset)>1)scroller.forceFinished(true);
        }
        postInvalidateOnAnimation();
    }
    private static boolean ornament(String text){
        boolean ink=false;for(int i=0;i<text.length();i++){char c=text.charAt(i);if(Character.isWhitespace(c))continue;if(c<0x2800||c>0x28ff)return false;ink=true;}return ink;
    }
    // Layout.BREAK_STRATEGY_SIMPLE and LineBreaker.BREAK_STRATEGY_SIMPLE are the
    // same value; lint wants the LineBreaker constant, which needs API 29.
    @SuppressLint("WrongConstant")
    private RenderFrame render(ScreenSnapshot input){
        long begin=System.nanoTime();RenderFrame result=new RenderFrame();result.cursorVisible=input.cursorVisible;
        StringBuilder raw=new StringBuilder();java.util.ArrayList<Run> runs=new java.util.ArrayList<>();
        boolean banner=false,conversation=false;int ornaments=0;
        if(input.codex)for(RowSnapshot row:input.rows){String line=new String(row.chars).trim();banner|=line.contains("OpenAI Codex");if(ornament(line))ornaments++;
            conversation|=line.startsWith("\u2022 ")||line.matches("[\u203a\u276f>]\\s+.+")&&!line.matches("[\u203a\u276f>]\\s+Ask Codex to do anything");}
        boolean splash=banner&&!conversation&&ornaments>=3;int blankLines=0,runStart=0,prompt=-1;long runStyle=Long.MIN_VALUE;
        for(int r=0;r<input.rows.size();r++){
            RowSnapshot row=input.rows.get(r);String rowText=new String(row.chars).trim();
            if(input.codex&&row.cursor>=0&&rowText.matches("[\u203a\u276f>](?:\\s.*)?"))prompt=raw.length();
            if(input.codex&&row.cursor>=0&&rowText.matches("[\u203a\u276f>]\\s+Ask Codex to do anything")){result.hideCursor=true;result.cursor=raw.length();continue;}
            // The animated Codex welcome logo is terminal decoration, not conversation.
            if(splash&&ornament(rowText))continue;
            if(splash&&rowText.isEmpty()){if(++blankLines>1)continue;}else blankLines=0;
            int end=row.chars.length;if(!row.wrapped)while(end>0&&row.chars[end-1]==' ')end--;
            if(row.cursor>=0)end=Math.max(end,Math.min(row.chars.length,row.cursor+1));
            int rowStart=raw.length(),col=0,previousCol=0;
            for(int i=0;i<end;){
                int cp=Character.codePointAt(row.chars,i,row.chars.length),width=Math.max(0,WcWidth.width(cp));
                long style=row.styles[Math.max(0,Math.min(row.styles.length-1,width==0?previousCol:col))];
                if(style!=runStyle){if(runStyle!=Long.MIN_VALUE)runs.add(new Run(runStart,raw.length(),runStyle));runStart=raw.length();runStyle=style;}
                if(i==row.cursor)result.cursor=raw.length();
                if((TextStyle.decodeEffect(style)&TextStyle.CHARACTER_ATTRIBUTE_INVISIBLE)!=0)raw.append(width==2?"  ":width==1?" ":"");else raw.appendCodePoint(cp);
                i+=Character.charCount(cp);if(width>0){previousCol=col;col+=width;}
            }
            if(row.cursor>=end&&row.cursor>=0)result.cursor=Math.max(rowStart,raw.length());
            if(!row.wrapped&&r<input.rows.size()-1)raw.append('\n');
        }
        if(runStyle!=Long.MIN_VALUE)runs.add(new Run(runStart,raw.length(),runStyle));
        HerdrTerminalFormatter.Result presentation=input.conversation?HerdrTerminalFormatter.format(raw.toString(),result.cursor,prompt,input.columns):null;
        if(presentation!=null){
            ArrayList<Run> mapped=new ArrayList<>();int firstRun=0;
            for(HerdrTerminalFormatter.Slice slice:presentation.slices){
                while(firstRun<runs.size()&&runs.get(firstRun).end<=slice.from)firstRun++;
                for(int n=firstRun;n<runs.size()&&runs.get(n).start<slice.to;n++){
                    Run run=runs.get(n);int start=slice.target+Math.max(slice.from,run.start)-slice.from,end=slice.target+Math.min(slice.to,run.end)-slice.from;
                    if(end>start){
                        if(!mapped.isEmpty()&&mapped.get(mapped.size()-1).end==start&&mapped.get(mapped.size()-1).style==run.style){Run previous=mapped.remove(mapped.size()-1);start=previous.start;}
                        mapped.add(new Run(start,end,run.style));
                    }
                }
            }
            runs=mapped;result.cursor=presentation.cursor;result.model=presentation.model;result.text=new SpannableStringBuilder(presentation.text);
        }else result.text=new SpannableStringBuilder(raw);
        java.util.HashMap<Long,int[]> resolved=new java.util.HashMap<>();
        for(Run run:runs)style(result.text,run,input,resolved);
        if(presentation!=null)for(HerdrTerminalFormatter.Paragraph p:presentation.paragraphs){
            int end=Math.min(p.end,result.text.length());if(end<=p.start)continue;
            if(p.blank){result.text.setSpan(new ParagraphGap(dp(10)),p.start,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);continue;}
            if(p.code){
                result.text.setSpan(new TypefaceSpan("monospace"),p.start,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                result.text.setSpan(new RelativeSizeSpan(.92f),p.start,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                TextPaint mono=new TextPaint(input.paint);mono.setTypeface(Typeface.MONOSPACE);mono.setTextSize(input.paint.getTextSize()*.92f);
                int hanging=Math.round(mono.measureText(result.text,p.start,Math.min(p.start+p.indent+p.marker,end)));
                if(hanging>0)result.text.setSpan(new LeadingMarginSpan.Standard(0,hanging),p.start,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            }
            else {
                int indent=Math.round(input.paint.measureText(" ")*p.indent);
                int hanging=p.marker>0?Math.round(input.paint.measureText(result.text,p.start,Math.min(p.start+p.marker,end))):0;
                result.text.setSpan(new LeadingMarginSpan.Standard(indent,indent+hanging),p.start,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            }
            if(p.muted){result.text.setSpan(new RelativeSizeSpan(.86f),p.start,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);result.text.setSpan(new ForegroundColorSpan(colors.muted),p.start,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);}
        }
        result.layout=StaticLayout.Builder.obtain(result.text,0,result.text.length(),input.paint,input.width)
            .setAlignment(Layout.Alignment.ALIGN_NORMAL).setTextDirection(TextDirectionHeuristics.FIRSTSTRONG_LTR)
            .setIncludePad(false).setLineSpacing(dp(input.conversation?3:2),1).setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE)
            .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE).build();
        result.nanos=System.nanoTime()-begin;return result;
    }
    private static final class ParagraphGap implements LineHeightSpan {
        private final int height;ParagraphGap(int height){this.height=height;}
        @Override public void chooseHeight(CharSequence text,int start,int end,int spanstartv,int v,Paint.FontMetricsInt fm){fm.ascent=-height;fm.descent=0;fm.top=fm.ascent;fm.bottom=0;}
    }
    private int color(int encoded,ScreenSnapshot input){
        if(encoded==TextStyle.COLOR_INDEX_FOREGROUND)return colors.ink;
        if(encoded==TextStyle.COLOR_INDEX_BACKGROUND)return colors.surface;
        return (encoded&0xff000000)==0xff000000?encoded:input.palette[Math.max(0,Math.min(258,encoded))];
    }
    private void style(SpannableStringBuilder target,Run run,ScreenSnapshot input,java.util.HashMap<Long,int[]> resolved){
        int start=run.start,end=run.end;if(end<=start)return;long encoded=run.style;int effect=TextStyle.decodeEffect(encoded);
        int[] pair=resolved.get(encoded);
        if(pair==null){int fg=color(TextStyle.decodeForeColor(encoded),input),bg=color(TextStyle.decodeBackColor(encoded),input);
            if(input.codex&&TextStyle.decodeBackColor(encoded)==8)bg=colors.field;
            if(((effect&TextStyle.CHARACTER_ATTRIBUTE_INVERSE)!=0)^input.reverse){int swap=fg;fg=bg;bg=swap;}
            if((effect&TextStyle.CHARACTER_ATTRIBUTE_DIM)!=0)fg=blend(fg,bg,.3f);
            pair=new int[]{readable(fg,bg),bg};resolved.put(encoded,pair);}
        target.setSpan(new ForegroundColorSpan(pair[0]),start,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        if(pair[1]!=colors.surface)target.setSpan(new BackgroundColorSpan(pair[1]),start,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        int face=((effect&TextStyle.CHARACTER_ATTRIBUTE_BOLD)!=0?Typeface.BOLD:0)|((effect&TextStyle.CHARACTER_ATTRIBUTE_ITALIC)!=0?Typeface.ITALIC:0);
        if(face!=0)target.setSpan(new StyleSpan(face),start,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        if((effect&TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE)!=0)target.setSpan(new UnderlineSpan(),start,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        if((effect&TextStyle.CHARACTER_ATTRIBUTE_STRIKETHROUGH)!=0)target.setSpan(new StrikethroughSpan(),start,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
    }
    @Override protected void onDetachedFromWindow(){
        renderGeneration++;rendering=false;deferredFrame=null;dragging=false;scroller.forceFinished(true);dirty=true;if(renderer!=null){renderer.shutdownNow();renderer=null;}super.onDetachedFromWindow();
    }
    private static double luminance(int color){double sum=0;double[] weight={.2126,.7152,.0722};int[] channels={Color.red(color),Color.green(color),Color.blue(color)};for(int i=0;i<3;i++){double c=channels[i]/255.0;sum+=weight[i]*(c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4));}return sum;}
    private static int blend(int a,int b,float amount){return Color.rgb(Math.round(Color.red(a)+(Color.red(b)-Color.red(a))*amount),Math.round(Color.green(a)+(Color.green(b)-Color.green(a))*amount),Math.round(Color.blue(a)+(Color.blue(b)-Color.blue(a))*amount));}
    private static double contrast(int a,int b){double x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
    private static int readable(int fg,int bg){
        if(contrast(fg,bg)>=4.5)return fg;
        // Adjust lightness just enough for readability, retaining green/blue/pink
        // distinctions instead of flattening every pale ANSI color to black.
        int target=luminance(bg)>.179?Color.BLACK:Color.WHITE;float low=0,high=1;
        for(int n=0;n<12;n++){float mid=(low+high)/2;if(contrast(blend(fg,target,mid),bg)>=4.5)high=mid;else low=mid;}
        return blend(fg,target,high);
    }
    private int maxOffset(){return layout==null?0:Math.max(0,layout.getHeight()-getHeight()+getPaddingTop()+getPaddingBottom());}
    // CLI cursors move to status bars and temporary repaint positions while the
    // person types in the native composer. Follow stable content, not that cursor.
    private void follow(){if(layout!=null)offsetY=maxOffset();}
    @Override protected void onDraw(Canvas canvas){
        super.onDraw(canvas);ensureLayout();if(layout==null)return;
        canvas.save();canvas.clipRect(getPaddingLeft(),getPaddingTop(),getWidth()-getPaddingRight(),getHeight()-getPaddingBottom());
        canvas.translate(getPaddingLeft(),getPaddingTop()-offsetY);layout.draw(canvas);
        if(!hideCursor&&cursorVisible){
            int offset=Math.min(cursorOffset,text.length()),line=layout.getLineForOffset(offset);float x=layout.getPrimaryHorizontal(offset);
            canvas.drawRect(x,layout.getLineBottom(line)-dp(2),Math.min(layout.getWidth(),x+paint.measureText(" ")),layout.getLineBottom(line),cursorPaint);
        }
        canvas.restore();
    }
    @Override public void computeScroll(){if(scroller.computeScrollOffset()){offsetY=Math.min(maxOffset(),scroller.getCurrY());postInvalidateOnAnimation();}
        else if(!dragging&&(deferredFrame!=null||dirty))ensureLayout();}
    @Override public boolean canScrollVertically(int direction){ensureLayout();return direction<0?offsetY>0:offsetY<maxOffset();}
    @Override protected int computeVerticalScrollRange(){ensureLayout();return layout==null?getHeight():layout.getHeight()+getPaddingTop()+getPaddingBottom();}
    @Override protected int computeVerticalScrollOffset(){return (int)offsetY;}
    @Override protected int computeVerticalScrollExtent(){return getHeight();}
    @Override public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info){
        super.onInitializeAccessibilityNodeInfo(info);info.setScrollable(maxOffset()>0);
        if(canScrollVertically(-1))info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_BACKWARD);
        if(canScrollVertically(1))info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD);
    }
    @Override public boolean performAccessibilityAction(int action,Bundle args){
        if(action==AccessibilityNodeInfo.ACTION_SCROLL_FORWARD||action==AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD){scrollByTouch((action==AccessibilityNodeInfo.ACTION_SCROLL_FORWARD?1:-1)*getHeight()*.75f);return true;}
        return super.performAccessibilityAction(action,args);
    }
    @Override public boolean onTouchEvent(MotionEvent event){
        if(event.getActionMasked()==MotionEvent.ACTION_DOWN&&getParent()!=null)getParent().requestDisallowInterceptTouchEvent(true);
        scale.onTouchEvent(event);gesture.onTouchEvent(event);
        if(event.getActionMasked()==MotionEvent.ACTION_UP||event.getActionMasked()==MotionEvent.ACTION_CANCEL){
            dragging=false;if(event.getActionMasked()==MotionEvent.ACTION_CANCEL)scroller.forceFinished(true);
            if(getParent()!=null)getParent().requestDisallowInterceptTouchEvent(false);postInvalidateOnAnimation();
        }
        return true;
    }
    @Override public boolean performClick(){super.performClick();return true;}
}
