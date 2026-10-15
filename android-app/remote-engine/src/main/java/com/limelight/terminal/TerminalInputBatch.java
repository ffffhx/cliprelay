package com.limelight.terminal;

import java.io.ByteArrayOutputStream;

/** Main-thread capture of a synchronous terminal encoder's multipart output. */
public final class TerminalInputBatch {
    private ByteArrayOutputStream bytes;
    private int limit;
    private boolean failed;

    public byte[] capture(int maximum,Runnable encoder) {
        if(bytes!=null) {failed=true;throw new IllegalStateException("Nested terminal input");}
        if(maximum<1 || maximum>16384)throw new IllegalArgumentException("Terminal input limit");
        bytes=new ByteArrayOutputStream();limit=maximum;failed=false;
        try {
            encoder.run();
            if(failed)throw new IllegalStateException("Incomplete terminal input");
            return bytes.toByteArray();
        } finally {bytes=null;failed=false;}
    }

    /** True means the output was captured, and must not also reach the normal input sink. */
    public boolean collect(byte[] data,int offset,int count) {
        if(bytes==null)return false;
        if(data==null || offset<0 || count<0 || offset>data.length-count || count>limit-bytes.size()) {
            failed=true;throw new IllegalArgumentException("Terminal input exceeds batch");
        }
        bytes.write(data,offset,count);return true;
    }
}
