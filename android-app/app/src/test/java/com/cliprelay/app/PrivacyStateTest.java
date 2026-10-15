package com.cliprelay.app;

import com.limelight.nvstream.PrivacyState;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class PrivacyStateTest {
    private static final String LEASE="1234567890abcdef1234567890abcdef";
    private static final String INSTANCE="ABCDEF01-2345-ABCD-EF01-23456789ABCD";
    private JSONObject active() throws Exception { return new JSONObject().put("ok",true).put("supported",true).put("active",true).put("lease",LEASE).put("expiresMs",15000); }
    @Test public void onlyCurrentLeaseConfirmsProtection() throws Exception {
        PrivacyState state=new PrivacyState(active());assertTrue(state.confirms(LEASE));assertFalse(state.confirms("different"));
        assertFalse(new PrivacyState(new JSONObject().put("ok",true).put("supported",true).put("active",false).put("expiresMs",0)).confirms(LEASE));
    }
    @Test public void expiredUnsupportedAndMalformedAreNotProtection() throws Exception {
        for(Object[] change:new Object[][]{{"ok",false},{"ok","true"},{"supported",false},{"active","true"},{"lease","bad"},{"expiresMs",0},{"expiresMs",15001},{"expiresMs",-1},{"expiresMs","15000"},{"expiresMs",15000.5}}) {
            JSONObject value=active().put((String)change[0],change[1]);
            try { new PrivacyState(value);fail(value.toString()); } catch(org.json.JSONException expected) {}
        }
    }
    @Test public void inactiveMustClearLeaseAndDeadline() throws Exception {
        try {new PrivacyState(active().put("active",false));fail();}catch(org.json.JSONException expected){}
    }
    @Test public void commandsBindEngineStreamAndLease() throws Exception {
        for(String op:new String[]{"start","renew","stop"}) {JSONObject value=PrivacyState.request(op,INSTANCE,10,LEASE);assertEquals(op,value.getString("op"));assertEquals(10,value.getLong("stream"));assertEquals(INSTANCE,value.getString("instance"));assertEquals(LEASE,value.getString("lease"));}
        for(String op:new String[]{"lock","mute","status",""}) {try{PrivacyState.request(op,INSTANCE,10,LEASE);fail();}catch(org.json.JSONException expected){}}
        try{PrivacyState.request("start",INSTANCE,0,LEASE);fail();}catch(org.json.JSONException expected){}
        try{PrivacyState.request("start","old",10,LEASE);fail();}catch(org.json.JSONException expected){}
    }
}
