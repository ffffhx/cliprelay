package com.limelight.terminal;

/** Local touch intent only. The caller sends a click at up or bounded wheel steps, never a down. */
public final class TerminalMouseGesture {
    private final float slop,lineHeight;
    private int pointer=-1;
    private float startX,startY,scrollY,wheelFraction;
    private boolean scrolling,allowSwipe;
    public TerminalMouseGesture(float slop,float lineHeight) {
        if(!Float.isFinite(slop) || !Float.isFinite(lineHeight) || slop<0 || lineHeight<=0)throw new IllegalArgumentException("Mouse geometry");
        this.slop=slop;this.lineHeight=lineHeight;
    }
    public void cancel(){pointer=-1;scrolling=false;wheelFraction=0;}
    public void down(int id,float x,float y,boolean swipe) {
        cancel();if(id<0 || !Float.isFinite(x) || !Float.isFinite(y))return;
        pointer=id;startX=x;startY=scrollY=y;allowSwipe=swipe;
    }
    private boolean matches(int id,float x,float y) {
        if(pointer<0 || pointer!=id || !Float.isFinite(x) || !Float.isFinite(y)){cancel();return false;}return true;
    }
    private boolean moved(float x,float y){return Math.hypot(x-startX,y-startY)>slop;}
    public int move(int id,float x,float y) {
        if(!matches(id,x,y))return 0;
        if(!scrolling && moved(x,y)) {
            if(!allowSwipe || Math.abs(x-startX)>=Math.abs(y-startY)){cancel();return 0;}
            scrolling=true;
        }
        if(!scrolling)return 0;
        float delta=(y-scrollY)/lineHeight;
        int steps=(int)Math.max(-TerminalMouseInput.MAX_WHEEL_STEPS,Math.min(TerminalMouseInput.MAX_WHEEL_STEPS,delta));
        if(Math.abs(delta)>=TerminalMouseInput.MAX_WHEEL_STEPS)scrollY=y;else scrollY+=steps*lineHeight;
        return steps;
    }
    public boolean up(int id,float x,float y) {
        boolean click=matches(id,x,y) && !scrolling && !moved(x,y);cancel();return click;
    }
    public int wheel(float axis) {
        pointer=-1;scrolling=false;
        if(!Float.isFinite(axis)){cancel();return 0;}
        float sum=wheelFraction+Math.max(-TerminalMouseInput.MAX_WHEEL_STEPS,Math.min(TerminalMouseInput.MAX_WHEEL_STEPS,axis));
        int steps=(int)Math.max(-TerminalMouseInput.MAX_WHEEL_STEPS,Math.min(TerminalMouseInput.MAX_WHEEL_STEPS,sum));
        wheelFraction=Math.abs(axis)>=TerminalMouseInput.MAX_WHEEL_STEPS?0:sum-steps;
        return steps;
    }
}
