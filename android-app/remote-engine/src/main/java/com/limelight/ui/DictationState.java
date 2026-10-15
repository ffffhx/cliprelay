package com.limelight.ui;

import java.nio.charset.StandardCharsets;

/** One recognition attempt and one explicit confirmation. Partial and late results never type. */
public final class DictationState {
    public enum Phase { IDLE, STARTING, LISTENING, STOPPING, REVIEW }
    private long generation,deadline;
    private Phase phase=Phase.IDLE;
    public Phase phase(){return phase;}
    public long token(){return generation;}
    public boolean active(){return phase!=Phase.IDLE;}
    public long begin(long now){if(active())throw new IllegalStateException("Dictation already active");phase=Phase.STARTING;deadline=now+60000;return ++generation;}
    public boolean current(long token){return token==generation && active();}
    public boolean ready(long token){if(!current(token)||phase!=Phase.STARTING)return false;phase=Phase.LISTENING;return true;}
    public boolean stop(long token,long now){if(!current(token)||phase==Phase.REVIEW||expired(token,now))return false;if(phase!=Phase.STOPPING){phase=Phase.STOPPING;deadline=Math.min(deadline+10000,now+10000);}return true;}
    public boolean expired(long token,long now){return current(token) && phase!=Phase.REVIEW && now>=deadline;}
    public String result(long token,String value,long now){
        if(!current(token) || phase==Phase.REVIEW || expired(token,now))return null;
        String text=normalize(value);if(text==null)return null;phase=Phase.REVIEW;return text;
    }
    public String confirm(long token,String value,boolean connected){
        if(!current(token) || phase!=Phase.REVIEW || !connected)return null;
        String text=normalize(value);if(text==null)return null;cancel();return text;
    }
    public void cancel(){phase=Phase.IDLE;++generation;}
    public static String normalize(String text){
        if(text==null || text.length()>8192)return null;
        StringBuilder result=new StringBuilder();
        for(int cp:text.codePoints().toArray()){
            if(cp=='\r' || cp=='\n' || cp=='\t' || cp==0x2028 || cp==0x2029)cp=' ';
            if(Character.isISOControl(cp) || cp>=0xd800 && cp<=0xdfff)return null;
            result.appendCodePoint(cp);
        }
        String value=result.toString().trim();return value.isEmpty() || value.getBytes(StandardCharsets.UTF_8).length>8192?null:value;
    }
}
