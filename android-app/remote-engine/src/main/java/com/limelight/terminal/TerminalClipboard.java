package com.limelight.terminal;

import java.nio.charset.StandardCharsets;

/** Plain text for an explicit, reviewed paste. Never reads the system clipboard itself. */
public final class TerminalClipboard {
    // A complete bracketed paste must fit ONE host write, including both six-byte delimiters.
    // Otherwise backgrounding could discard a later chunk after the opening delimiter was sent.
    public static final int MAX_BATCH_BYTES=4096;
    public static final int MAX_TEXT_BYTES=MAX_BATCH_BYTES-12;
    private TerminalClipboard() {}

    public static String prepare(CharSequence source) {
        if(source==null || source.length()>MAX_TEXT_BYTES)throw new IllegalArgumentException("PASTE_SIZE");
        StringBuilder text=new StringBuilder();
        for(int i=0;i<source.length();i++) {
            char c=source.charAt(i);
            if(Character.isHighSurrogate(c)) {
                if(i+1>=source.length() || !Character.isLowSurrogate(source.charAt(i+1)))throw new IllegalArgumentException("PASTE_UNICODE");
                text.append(c).append(source.charAt(++i));
            } else if(Character.isLowSurrogate(c))throw new IllegalArgumentException("PASTE_UNICODE");
            else if(c=='\r') {text.append('\n');if(i+1<source.length() && source.charAt(i+1)=='\n')i++;}
            else if(c=='\t' || c=='\n' || (c>=32 && (c<127 || c>159)))text.append(c);
        }
        String result=text.toString();
        if(result.getBytes(StandardCharsets.UTF_8).length>MAX_TEXT_BYTES)throw new IllegalArgumentException("PASTE_SIZE");
        return result;
    }
}
