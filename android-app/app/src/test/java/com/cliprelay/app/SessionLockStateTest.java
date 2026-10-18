package com.cliprelay.app;
import com.limelight.nvstream.SessionLockState;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class SessionLockStateTest {
    private static final String ID="1234567890abcdef1234567890abcdef", INSTANCE="ABCDEF01-2345-ABCD-EF01-23456789ABCD";
    private JSONObject armed() throws Exception {return new JSONObject().put("ok",true).put("supported",true).put("state","armed").put("lease",ID).put("instance",INSTANCE).put("stream",10).put("expiresMs",15000);}
    @Test public void intentIsBoundToExactSession() throws Exception {
        SessionLockState state=new SessionLockState(armed());assertTrue(state.confirms(ID,INSTANCE,10));assertFalse(state.confirms(ID,INSTANCE,11));assertFalse(state.confirms("different",INSTANCE,10));assertFalse(state.confirms(ID,"other",10));
    }
    @Test public void requestedIsNotArmedOrConfirmed() throws Exception {
        SessionLockState value=new SessionLockState(armed().put("state","requested").put("expiresMs",5000));assertFalse(value.confirms(ID,INSTANCE,10));assertEquals("requested",value.state);
        assertEquals("locked",new SessionLockState(armed().put("state","locked").put("expiresMs",0)).state);
    }
    @Test public void rejectedAmbiguousOrExpiredState() throws Exception {
        for(Object[] change:new Object[][]{{"ok","true"},{"supported",false},{"state","unknown"},{"lease","bad"},{"instance","old"},{"stream",0},{"stream","10"},{"expiresMs",0},{"expiresMs",15001},{"expiresMs",15000.5},{"expiresMs","15000"}}) {
            JSONObject value=armed().put((String)change[0],change[1]);try{new SessionLockState(value);fail(value.toString());}catch(org.json.JSONException expected){}
        }
    }
    @Test public void offDoesNotCarryAnIntent() throws Exception {
        JSONObject off=new JSONObject().put("ok",true).put("supported",true).put("state","off").put("expiresMs",0);
        assertEquals("off",new SessionLockState(off).state);try{new SessionLockState(off.put("lease",ID));fail();}catch(org.json.JSONException expected){}
    }
    @Test public void clientCannotCommitOrRenewLock() throws Exception {
        for(String op:new String[]{"arm","disarm"})assertEquals(op,SessionLockState.request(op,INSTANCE,10,ID).getString("op"));
        for(String op:new String[]{"commit","renew","lock",""})try{SessionLockState.request(op,INSTANCE,10,ID);fail();}catch(org.json.JSONException expected){}
    }
}
