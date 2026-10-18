package com.cliprelay.app;

import com.limelight.nvstream.AudioMuteState;
import com.limelight.nvstream.DisplayState;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class AudioMuteStateTest {
    private static final String LEASE="1234567890abcdef1234567890abcdef";
    private static final String INSTANCE="ABCDEF01-2345-ABCD-EF01-23456789ABCD";
    private JSONObject muted() throws Exception {
        return new JSONObject().put("ok",true).put("supported",true).put("active",true).put("lease",LEASE)
                .put("expiresMs",15000).put("recovering",false).put("outputs",2);
    }
    private JSONObject snapshot() throws Exception {
        return new JSONObject().put("protocol",1).put("supported",true).put("instance",INSTANCE)
                .put("generation",2).put("phase","active").put("capture",new JSONObject().put("id","left"))
                .put("streams",new JSONArray().put(new JSONObject().put("id",10).put("generation",2).put("firstFrame",150)
                        .put("audio",new JSONObject().put("capture","process").put("generation",7).put("ready",true))));
    }
    private JSONObject audio(JSONObject state) throws Exception { return state.getJSONArray("streams").getJSONObject(0).getJSONObject("audio"); }

    @Test public void freshMacSystemTapSupportsMuteButStaleTapDoesNot() throws Exception {
        JSONObject value=snapshot();audio(value).put("capture","system-tap");
        assertTrue(new DisplayState(value).safeHostMute());
        audio(value).put("ready",false);assertFalse(new DisplayState(value).safeHostMute());
    }

    @Test public void confirmsOnlyCurrentUnexpiredLease() throws Exception {
        AudioMuteState state=new AudioMuteState(muted());
        assertTrue(state.confirms(LEASE));assertFalse(state.confirms("old"));assertEquals(2,state.outputs);
        for(Object[] change:new Object[][]{{"ok",false},{"active","true"},{"supported",false},{"lease","bad"},{"expiresMs",0},{"expiresMs",15001}}) {
            try{new AudioMuteState(muted().put((String)change[0],change[1]));fail();}catch(JSONException expected){}
        }
    }
    @Test public void rejectsMalformedOrImpossibleEndpointState() throws Exception {
        for(Object[] change:new Object[][]{{"outputs",0},{"outputs",33},{"outputs",-1},{"outputs",2.5},{"outputs","2"},{"outputs",Long.MAX_VALUE},{"recovering","false"},{"recovering",true}}) {
            try{new AudioMuteState(muted().put((String)change[0],change[1]));fail();}catch(JSONException expected){}
        }
    }
    @Test public void pendingRecoveryNeverClaimsMuteOrAvailability() throws Exception {
        JSONObject value=new JSONObject().put("ok",true).put("supported",false).put("active",false)
                .put("expiresMs",0).put("recovering",true).put("outputs",2);
        AudioMuteState state=new AudioMuteState(value);assertTrue(state.recovering);assertFalse(state.confirms(LEASE));
        try{new AudioMuteState(value.put("supported",true));fail();}catch(JSONException expected){}
        try{new AudioMuteState(muted().put("active",false));fail();}catch(JSONException expected){}
    }
    @Test public void oldAndEndpointCaptureHostsNeverOfferMute() throws Exception {
        JSONObject legacy=snapshot();legacy.getJSONArray("streams").getJSONObject(0).remove("audio");
        assertFalse(new DisplayState(legacy).safeHostMute());
        JSONObject endpoint=snapshot();audio(endpoint).put("capture","endpoint").put("ready",false);
        assertFalse(new DisplayState(endpoint).safeHostMute());
        JSONObject starting=snapshot();audio(starting).put("capture","").put("generation",0).put("ready",false);
        assertFalse(new DisplayState(starting).safeHostMute());
    }
    @Test public void currentAudioAndExclusiveLiveVideoAreRequired() throws Exception {
        assertTrue(new DisplayState(snapshot()).safeHostMute());
        for(String kind:new String[]{"shared","switching","video-generation","audio-not-ready","unpresented","no-stream","ambiguous"}) {
            JSONObject value=snapshot();
            switch(kind) {
                case "shared":value.put("shared",true);break;
                case "switching":value.put("phase","switching");break;
                case "video-generation":value.put("generation",3);break;
                case "audio-not-ready":audio(value).put("ready",false);break;
                case "unpresented":value.getJSONArray("streams").getJSONObject(0).put("firstFrame",0);break;
                case "no-stream":value.put("streams",new JSONArray());break;
                case "ambiguous":value.getJSONArray("streams").put(value.getJSONArray("streams").getJSONObject(0));break;
            }
            assertFalse(kind,new DisplayState(value).safeHostMute());
        }
    }
    @Test public void captureRestartCannotRenewPreviousGeneration() throws Exception {
        DisplayState state=new DisplayState(snapshot());assertTrue(state.sameAudioBinding(INSTANCE,10,7));
        assertFalse(state.sameAudioBinding("old",10,7));assertFalse(state.sameAudioBinding(INSTANCE,11,7));
        JSONObject changed=snapshot();audio(changed).put("generation",8);
        assertFalse(new DisplayState(changed).sameAudioBinding(INSTANCE,10,7));
    }
    @Test public void rejectsMalformedAudioReadinessMetadata() throws Exception {
        for(Object[] change:new Object[][]{{"capture","unknown"},{"capture",false},{"capture",""},{"capture","endpoint"},
                {"generation",0},{"generation",-1},{"generation",7.5},{"generation","7"},{"ready","true"}}) {
            JSONObject value=snapshot();audio(value).put((String)change[0],change[1]);
            try{new DisplayState(value);fail(value.toString());}catch(JSONException expected){}
        }
        JSONObject nullAudio=snapshot();nullAudio.getJSONArray("streams").getJSONObject(0).put("audio",JSONObject.NULL);
        try{new DisplayState(nullAudio);fail();}catch(JSONException expected){}
    }
    @Test public void operationsAlwaysBindTheAudioGeneration() throws Exception {
        for(String op:new String[]{"start","renew","stop"}) {
            JSONObject request=AudioMuteState.request(op,INSTANCE,10,7,LEASE);
            assertEquals(op,request.getString("op"));assertEquals(INSTANCE,request.getString("instance"));
            assertEquals(10,request.getLong("stream"));assertEquals(7,request.getLong("audioGeneration"));assertEquals(LEASE,request.getString("lease"));
            assertFalse(request.has("endpoints"));
        }
        for(long bad:new long[]{0,-1}) {try{AudioMuteState.request("start",INSTANCE,10,bad,LEASE);fail();}catch(JSONException expected){}}
        try{AudioMuteState.request("lock",INSTANCE,10,7,LEASE);fail();}catch(JSONException expected){}
    }
}
