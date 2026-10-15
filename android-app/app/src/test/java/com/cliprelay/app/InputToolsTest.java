package com.cliprelay.app;

import com.limelight.ui.*;
import org.json.*;
import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;

public class InputToolsTest {
    static final String ID="0123456789abcdef0123456789abcdef";
    CustomShortcut chord(int modifiers,int key) throws Exception{return new CustomShortcut(ID,"搜索",modifiers,key);}
    @Test public void customUnicodeLabelsAndOrderSurviveStorage() throws Exception {
        List<CustomShortcut> values=new ArrayList<>();values.add(chord(3,'P'));values.add(new CustomShortcut("1123456789abcdef0123456789abcdef","切换🙂",4,9));
        List<CustomShortcut> restored=CustomShortcut.decode(CustomShortcut.encode(values));assertEquals("搜索",restored.get(0).name);assertEquals("切换🙂",restored.get(1).name);
        Collections.swap(restored,0,1);assertEquals("切换🙂",CustomShortcut.decode(CustomShortcut.encode(restored)).get(0).name);
        assertEquals("Ctrl + Shift + P",values.get(0).label());
    }
    @Test public void invalidNamesAndKeysCannotBecomeRemoteInputs() throws Exception {
        for(String bad:new String[]{""," a","a\n","x\u001b","x\u202e","a".repeat(19),"\ud800"})try{new CustomShortcut(ID,bad,0,'A');fail(bad);}catch(JSONException expected){}
        for(int bad:new int[]{0,16,17,18,91,255,256,-1})try{chord(0,bad);fail("key "+bad);}catch(JSONException expected){}
        for(int bad:new int[]{-1,16,256})try{chord(bad,'A');fail();}catch(JSONException expected){}
    }
    @Test public void duplicateIdsAndCorruptStoredNumbersAreRejected() throws Exception {
        try{CustomShortcut.encode(Arrays.asList(chord(0,'A'),chord(2,'C')));fail();}catch(JSONException expected){}
        JSONObject value=new JSONObject(CustomShortcut.encode(Collections.singletonList(chord(2,'C'))));
        value.getJSONArray("items").getJSONObject(0).put("key","65");try{CustomShortcut.decode(value.toString());fail();}catch(JSONException expected){}
        value.put("version",2);try{CustomShortcut.decode(value.toString());fail();}catch(JSONException expected){}
    }
    @Test public void customListHasAHardLimit() throws Exception {
        List<CustomShortcut> values=new ArrayList<>();for(int i=0;i<12;i++)values.add(new CustomShortcut(String.format("%032x",i),"Key "+i,0,'A'));
        assertEquals(12,CustomShortcut.decode(CustomShortcut.encode(values)).size());values.add(new CustomShortcut(String.format("%032x",12),"Extra",0,'B'));
        try{CustomShortcut.encode(values);fail();}catch(JSONException expected){}
    }
    static class Sink implements DesktopInput.Sink {
        final List<String> events=new ArrayList<>();
        public void send(int key,boolean down,int modifiers){events.add(key+":"+down+":"+modifiers);}
        public void text(String value){events.add("text:"+value);}
        public void rightClick(){}
        public void scroll(byte amount){}
    }
    @Test public void allModifierCombinationsPressAndReleaseInOrder() throws Exception {
        for(int mask=0;mask<16;mask++){
            Sink sink=new Sink();new DesktopInput(sink).tap(chord(mask,'K').chord());
            int down=Integer.bitCount(mask)+1;assertEquals(down*2,sink.events.size());
            assertEquals("75:true:"+mask,sink.events.get(down-1));assertTrue(sink.events.get(down).startsWith("75:false:"));
            assertTrue(sink.events.get(sink.events.size()-1).endsWith(":false:0"));
        }
    }
    @Test public void shortcutReleasesModifiersWhenTransportThrows() throws Exception {
        Sink sink=new Sink(){boolean failed;@Override public void send(int key,boolean down,int modifiers){super.send(key,down,modifiers);if(key=='K'&&down&&!failed){failed=true;throw new IllegalStateException("fixture");}}};
        try{new DesktopInput(sink).tap(chord(6,'K').chord());fail();}catch(IllegalStateException expected){}
        assertTrue(sink.events.contains("75:false:6"));assertTrue(sink.events.get(sink.events.size()-1).endsWith(":false:0"));
    }
    @Test public void recognitionDoesNotTypeUntilExplicitConfirmation() {
        DictationState state=new DictationState();long token=state.begin(0);assertTrue(state.ready(token));
        assertNull(state.confirm(token,"partial",true));assertEquals("你好",state.result(token,"你好",100));
        assertNull(state.confirm(token,"你好",false));assertEquals(DictationState.Phase.REVIEW,state.phase());
        assertEquals("你好",state.confirm(token,"你好",true));assertFalse(state.active());assertNull(state.confirm(token,"你好",true));
    }
    @Test public void repeatedOrLateRecognitionCannotReplaceReviewedText() {
        DictationState state=new DictationState();long first=state.begin(0);assertEquals("one",state.result(first,"one",100));assertNull(state.result(first,"two",101));
        state.cancel();long next=state.begin(200);assertNull(state.result(first,"late",300));assertTrue(state.ready(next));assertEquals("new",state.result(next,"new",400));
    }
    @Test public void backgroundAndTargetChangeInvalidatePendingReview() {
        DictationState state=new DictationState();long token=state.begin(0);state.result(token,"draft",100);state.cancel();
        assertNull(state.confirm(token,"draft",true));assertNull(state.result(token,"late",200));
    }
    @Test public void speechAndFinishingHaveFiniteDeadlines() {
        DictationState state=new DictationState();long token=state.begin(100);assertFalse(state.expired(token,60099));assertTrue(state.expired(token,60100));assertNull(state.result(token,"late",60100));
        state.cancel();token=state.begin(100000);assertTrue(state.stop(token,101000));assertFalse(state.expired(token,110999));assertTrue(state.expired(token,111000));
        assertTrue(state.stop(token,110999));assertTrue(state.expired(token,111000));
    }
    @Test public void voiceNeverContainsSubmitOrTerminalControlBytes() {
        assertEquals("first  second third",DictationState.normalize("first\r\nsecond\tthird"));assertEquals("甲 乙",DictationState.normalize("甲\u2028乙"));
        for(String bad:new String[]{""," ","echo\u001b[2J","a\u0000b","a\u007fb","\ud800","中".repeat(2731)})assertNull(DictationState.normalize(bad));
        assertNotNull(DictationState.normalize("中".repeat(2730)));
    }
    @Test public void invalidFinalResultCannotEnterReviewOrConsumeConfirmation() {
        DictationState state=new DictationState();long token=state.begin(0);assertNull(state.result(token,"\u0003",100));assertEquals(DictationState.Phase.STARTING,state.phase());
        assertEquals("valid",state.result(token,"valid",200));assertNull(state.confirm(token,"\u0003",true));assertEquals(DictationState.Phase.REVIEW,state.phase());
        assertEquals("edited",state.confirm(token,"edited",true));
    }
}
