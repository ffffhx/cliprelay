package com.limelight.terminal;

/** At most two completed read/key operations may precede a waiting mouse operation. */
public final class TerminalInputSchedule {
    private long readAt=Long.MIN_VALUE,keyAt=Long.MIN_VALUE;
    private int ordinary;
    private String last="";
    public boolean preferMouse(){return ordinary>=2;}
    public boolean preferKey(long now){return last.equals("read") && keyDue(now);}
    public boolean readDue(long now){return readAt==Long.MIN_VALUE || now-readAt>=75;}
    public boolean keyDue(long now){return keyAt==Long.MIN_VALUE || now-keyAt>=100;}
    public void completed(String operation,long now){
        if(operation.equals("mouse") || operation.equals("read") || operation.equals("write"))last=operation;
        if(operation.equals("mouse"))ordinary=0;
        else if(operation.equals("read")){readAt=now;ordinary=Math.min(2,ordinary+1);}
        else if(operation.equals("write")){keyAt=now;ordinary=Math.min(2,ordinary+1);}
    }
}
