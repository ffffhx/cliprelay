package com.limelight.terminal;

/** Normalized pointer events, shared by touch and external mice. No raw VT writes. */
public final class TerminalMousePointer {
    public interface Sink {
        boolean event(TerminalMouseState.Event event);
        void cancel();
        boolean heartbeat(long revision);
    }
    private final Sink sink;
    private TerminalProtocol.Mouse mode;
    private long revision;
    private int buttons,lastButton;
    private boolean ready,waitForRelease;
    private float vertical,horizontal;
    public TerminalMousePointer(Sink sink){this.sink=sink;}
    public int buttons(){return buttons;}
    /** A new touch DOWN is an explicit new gesture, unlike a duplicate BUTTON_PRESS. */
    public void freshDown(){if(buttons==0)waitForRelease=false;}
    public void configure(TerminalProtocol.Mouse next,long version,boolean enabled){
        if(version!=revision || (mode==null?0:mode.epoch)!=(next==null?0:next.epoch)){waitForRelease|=buttons!=0;reset();}
        mode=next;revision=version;ready=enabled && next!=null && next.available();
        if(!ready && buttons!=0)cancel();
    }
    public void reset(){buttons=0;vertical=horizontal=0;}
    public void cancel(){waitForRelease|=buttons!=0;reset();sink.cancel();}
    public boolean heartbeat(){if(buttons==0 || !ready)return false;if(!sink.heartbeat(revision)){cancel();return false;}return true;}
    private boolean send(String action,int x,int y,int button,int modifiers){
        if(!ready)return false;
        if(x<1 || y<1 || x>65535 || y>65535 || mode.format==0 && (x>223 || y>223)){cancel();return false;}
        if(!sink.event(new TerminalMouseState.Event(action,mode.epoch,revision,x,y,button,modifiers))){waitForRelease=true;cancel();return false;}return true;
    }
    /** Edge callbacks may overlap (DOWN + BUTTON_PRESS); the physical mask deduplicates them. */
    public void edges(int mask,int x,int y,int modifiers,boolean allowPress){
        if(waitForRelease){if(mask==0)waitForRelease=false;return;}
        if(!ready || mask<0 || mask>7){cancel();return;}
        int released=buttons & ~mask,pressed=mask & ~buttons;
        if(pressed!=0 && !allowPress){waitForRelease=true;cancel();return;}
        for(int b=0;b<3;b++)if((released & 1<<b)!=0){
            if(mode.mode!=9 && !send("release",x,y,b,modifiers))return;
            buttons&=~(1<<b);
        }
        for(int b=0;b<3;b++)if((pressed & 1<<b)!=0){
            if(!send("press",x,y,b,modifiers))return;buttons|=1<<b;lastButton=b;
        }
    }
    public void move(int actualButtons,int x,int y,int modifiers){
        if(waitForRelease){if(actualButtons==0)waitForRelease=false;return;}
        if(!ready || actualButtons!=buttons){cancel();if(actualButtons==0)waitForRelease=false;return;}
        if(buttons!=0){
            if(mode.mode==1002 || mode.mode==1003){if((buttons & 1<<lastButton)==0)lastButton=Integer.numberOfTrailingZeros(buttons);send("move",x,y,lastButton,modifiers);}
        }else if(mode.mode==1003)send("move",x,y,3,modifiers);
    }
    public void wheel(float axis,boolean across,int x,int y,int modifiers){
        if(!ready || waitForRelease || mode.mode==9)return;
        if(!Float.isFinite(axis)){cancel();return;}
        float total=(across?horizontal:vertical)+Math.max(-8,Math.min(8,axis));
        int steps=(int)Math.max(-8,Math.min(8,total));
        float remainder=Math.abs(axis)>=8?0:total-steps;
        if(across)horizontal=remainder;else vertical=remainder;
        // Android positive horizontal scroll is right; positive vertical is up.
        int button=across?(steps>0?3:2):(steps>0?0:1);
        for(int i=0;i<Math.abs(steps);i++)if(!send("wheel",x,y,button,modifiers))return;
    }
}
