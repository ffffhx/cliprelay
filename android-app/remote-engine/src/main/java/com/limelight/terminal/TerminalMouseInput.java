package com.limelight.terminal;

import com.termux.terminal.TerminalEmulator;

/** Complete mouse actions encoded by the active VT parser; never leaves a held button. */
public final class TerminalMouseInput {
    public static final int MAX_WHEEL_STEPS=8;
    private TerminalMouseInput() {}
    private static boolean available(TerminalEmulator emulator,int column,int row) {
        return emulator.isMouseTrackingActive() && column>=1 && column<=emulator.mColumns && row>=1 && row<=emulator.mRows;
    }
    public static byte[] click(TerminalEmulator emulator,TerminalInputBatch batch,int column,int row) {
        if(!available(emulator,column,row))return new byte[0];
        return batch.capture(4096,()->{
            emulator.sendMouseEvent(TerminalEmulator.MOUSE_LEFT_BUTTON,column,row,true);
            emulator.sendMouseEvent(TerminalEmulator.MOUSE_LEFT_BUTTON,column,row,false);
        });
    }
    /** Positive steps scroll up. Wheel reports have no button release event. */
    public static byte[] wheel(TerminalEmulator emulator,TerminalInputBatch batch,int column,int row,int steps) {
        if(!available(emulator,column,row) || steps==0)return new byte[0];
        final int count=Math.min(MAX_WHEEL_STEPS,Math.max(-MAX_WHEEL_STEPS,steps));
        return batch.capture(4096,()->{
            int button=count>0?TerminalEmulator.MOUSE_WHEELUP_BUTTON:TerminalEmulator.MOUSE_WHEELDOWN_BUTTON;
            for(int i=0;i<Math.abs(count);i++)emulator.sendMouseEvent(button,column,row,true);
        });
    }
}
