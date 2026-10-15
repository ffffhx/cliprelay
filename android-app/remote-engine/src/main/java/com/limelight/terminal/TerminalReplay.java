package com.limelight.terminal;

import java.util.Arrays;

/** Retained output must not suppress query responses from newly received bytes. */
public final class TerminalReplay {
    private TerminalReplay() {}
    public interface Sink { void append(byte[] bytes,boolean replay); }

    public static void append(byte[] bytes,long offset,long replayUntil,Sink sink) {
        if(offset<0 || replayUntil<0)throw new IllegalArgumentException("Negative output offset");
        if(bytes.length==0)return;
        int retained=replayUntil<=offset?0:(int)Math.min(bytes.length,replayUntil-offset);
        if(retained==0 || retained==bytes.length) {
            sink.append(bytes,retained!=0);
        } else {
            // Keep one parser: a UTF-8 code point or VT sequence may straddle this boundary.
            sink.append(Arrays.copyOfRange(bytes,0,retained),true);
            sink.append(Arrays.copyOfRange(bytes,retained,bytes.length),false);
        }
    }
}
