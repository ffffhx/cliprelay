package com.limelight.terminal;

/** Inclusive terminal cells. Owners clear the range whenever output or geometry changes. */
public final class TerminalSelection {
    public static final class Range {
        public final int x1,y1,x2,y2;
        private Range(int x1,int y1,int x2,int y2){this.x1=x1;this.y1=y1;this.x2=x2;this.y2=y2;}
    }
    private int anchorX,anchorY,endX,endY;
    private boolean enabled,marked;
    public boolean enabled(){return enabled;}
    public void enable(boolean value){enabled=value;clear();}
    public void clear(){marked=false;}
    public void start(int column,int row,int columns,int rows,int history) {
        if(!enabled)return;
        anchorX=endX=clamp(column,0,columns-1);anchorY=endY=clamp(row,-history,rows-1);marked=true;
    }
    public void extend(int column,int row,int columns,int rows,int history) {
        if(!enabled || !marked)return;
        endX=clamp(column,0,columns-1);endY=clamp(row,-history,rows-1);
    }
    private static int clamp(int value,int low,int high){return Math.max(low,Math.min(high,value));}
    public Range range() {
        if(!enabled || !marked)return null;
        return endY<anchorY || (endY==anchorY && endX<anchorX)
                ?new Range(endX,endY,anchorX,anchorY):new Range(anchorX,anchorY,endX,endY);
    }
}
