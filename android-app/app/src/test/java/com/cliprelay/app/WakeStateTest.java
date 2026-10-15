package com.cliprelay.app;

import com.limelight.nvstream.wol.WakeState;
import com.limelight.nvstream.wol.WakeSelection;
import com.limelight.nvstream.wol.WakeOnLanSender;
import com.limelight.nvstream.http.ComputerDetails;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.*;

public class WakeStateTest {
    private static final String MAC="02:11:22:33:44:55", ID="abcdef01-2345-abcd-ef01-23456789abcd";
    private static final String PIN="a123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    private JSONObject adapter() throws Exception {
        return new JSONObject().put("id",ID).put("name","Ethernet").put("kind","ethernet").put("mac",MAC).put("connected",true)
                .put("powerManagement","enabled").put("magicPacket","enabled").put("wakeArmed","enabled").put("configuration","configured")
                .put("addresses",new JSONArray().put(new JSONObject().put("address","192.168.0.2").put("prefix",24)));
    }
    private JSONObject inventory() throws Exception {return new JSONObject().put("ok",true).put("supported",true).put("platform","windows")
            .put("wakeVerified",false).put("adapters",new JSONArray().put(adapter()));}
    private JSONObject selection() throws Exception {return new JSONObject().put("version",1).put("target","target").put("targetPin",PIN)
            .put("adapter",ID).put("mac",MAC).put("network","192.168.0.0/24").put("helper","helper").put("helperPin",PIN).put("capturedAt",1000L);}
    @Test public void malformedMacNeverProducesAPacket() throws Exception {
        for(String bad:new String[]{null,"","00:00:00:00:00:00","ff:ff:ff:ff:ff:ff","01:11:22:33:44:55","02:11:22",
                "02:11:22:33:44:55:66","02:11:22:33:44:555","02:11:22:33:44:GG"," 02:11:22:33:44:55","02-11-22-33-44-55"}) {
            try{WakeState.magicPacket(bad);fail("accepted "+bad);}catch(IOException expected){}
        }
        byte[] packet=WakeState.magicPacket("02:ab:cd:ef:12:34");assertEquals(102,packet.length);
        for(int i=0;i<6;i++)assertEquals(255,packet[i]&255);
        byte[] mac=new byte[]{2,(byte)171,(byte)205,(byte)239,18,52};
        for(int i=6;i<102;i++)assertEquals(mac[(i-6)%6],packet[i]);
    }
    @Test public void noAddressOrEmbeddedLoopbackCannotReportSent() throws Exception {
        ComputerDetails computer=new ComputerDetails();computer.macAddress=MAC;
        try{WakeOnLanSender.sendWolPacket(computer);fail();}catch(IOException expected){}
        computer.manualAddress=new ComputerDetails.AddressTuple("127.120.0.1",47633);
        try{WakeOnLanSender.sendWolPacket(computer);fail();}catch(IOException expected){}
    }
    @Test public void settingsAreNotHardwareWakeProof() throws Exception {
        WakeState state=new WakeState(inventory());assertEquals("configured",state.adapters.get(0).configuration);
        JSONObject wifi=adapter().put("kind","wifi").put("powerManagement","unsupported").put("wakeArmed","disabled").put("configuration","unknown");
        assertEquals("unknown",new WakeState(inventory().put("adapters",new JSONArray().put(wifi))).adapters.get(0).configuration);
        try{new WakeState(inventory().put("wakeVerified",true));fail();}catch(JSONException expected){}
        wifi.put("configuration","configured");
        try{new WakeState(inventory().put("adapters",new JSONArray().put(wifi)));fail();}catch(JSONException expected){}
    }
    @Test public void helperMustHaveAnActiveExactNetwork() throws Exception {
        WakeState state=new WakeState(inventory());assertTrue(state.hasNetwork("192.168.0.0/24"));
        assertFalse(state.hasNetwork("192.168.0.0/16"));assertFalse(state.hasNetwork("192.168.1.0/24"));
        assertTrue(state.hasTarget(ID.toUpperCase(),MAC));assertFalse(state.hasTarget(ID,"02:11:22:33:44:66"));
        JSONObject offline=inventory().put("adapters",new JSONArray().put(adapter().put("connected",false)));
        assertFalse(new WakeState(offline).hasNetwork("192.168.0.0/24"));
    }
    @Test public void malformedInventoryCannotEnableWake() throws Exception {
        for(Object[] field:new Object[][]{{"connected","true"},{"kind","vpn"},{"id","bad"},{"mac",""},{"wakeArmed","unsupported"},{"configuration","ready"}}) {
            JSONObject value=inventory().put("adapters",new JSONArray().put(adapter().put((String)field[0],field[1])));
            try{new WakeState(value);fail(value.toString());}catch(JSONException expected){}
        }
        for(String bad:new String[]{"127.0.0.1","0.0.0.0","224.0.0.1","192.168.000.2","192.168.0.256","host.local","::1"}) {
            JSONObject item=adapter().put("addresses",new JSONArray().put(new JSONObject().put("address",bad).put("prefix",24)));
            try{new WakeState(inventory().put("adapters",new JSONArray().put(item)));fail(bad);}catch(JSONException expected){}
        }
        try{new WakeState(inventory().put("adapters",new JSONArray().put(adapter()).put(adapter())));fail();}catch(JSONException expected){}
    }
    @Test public void requestCannotChooseArbitraryDestinations() throws Exception {
        JSONObject value=WakeState.sendRequest("0123456789abcdef0123456789abcdef",MAC,"192.168.0.0/24");
        assertEquals(4,value.length());assertEquals("send",value.getString("op"));
        for(String bad:new String[]{"0.0.0.0/0","192.168.0.2/24","192.168.0.0/31","192.168.0.0/32","192.168.0.0/024","fd00::/64","host/24"}) {
            try{WakeState.sendRequest("0123456789abcdef0123456789abcdef",MAC,bad);fail(bad);}catch(JSONException expected){}
        }
    }
    @Test public void sendReceiptsCannotClaimWakeSuccess() throws Exception {
        JSONObject value=new JSONObject().put("ok",true).put("state","sent").put("sent",3).put("wakeVerified",false);
        assertEquals(3,WakeState.sentCount(value));
        for(Object[] field:new Object[][]{{"ok","true"},{"state","awake"},{"sent",0},{"sent",25},{"sent",1.5},{"sent","3"},{"wakeVerified",true}}) {
            JSONObject bad=new JSONObject(value.toString()).put((String)field[0],field[1]);
            try{WakeState.sentCount(bad);fail(bad.toString());}catch(JSONException expected){}
        }
    }
    @Test public void savedTargetExpiresAndCannotFollowNewPairing() throws Exception {
        WakeSelection value=new WakeSelection(selection());assertEquals(value.json().toString(),new WakeSelection(value.json()).json().toString());
        assertTrue(value.matchesIdentity("target",PIN,1001));assertFalse(value.matchesIdentity("other",PIN,1001));
        assertFalse(value.matchesIdentity("target","b"+PIN.substring(1),1001));assertFalse(value.matchesIdentity("target",PIN,999));
        assertFalse(value.matchesIdentity("target",PIN,1001L+30L*86400000));assertFalse(value.matches("target",null,1001));
        assertFalse(value.matchesHelper("helper",null));
    }
    @Test public void corruptedSavedHelperIsNotUsed() throws Exception {
        for(Object[] field:new Object[][]{{"version",2},{"targetPin",""},{"helperPin",""},{"helper","target"},{"helper",""},
                {"capturedAt",0},{"capturedAt","1000"},{"mac","bad"},{"network","192.168.0.2/24"}}) {
            try{new WakeSelection(selection().put((String)field[0],field[1]));fail();}catch(JSONException expected){}
        }
    }
    @Test public void actualWindowsDiscoveryIsUnderstoodByAndroid() throws Exception {
        String executable=System.getenv("CLIPRELAY_WAKE_TEST_WORKER");
        org.junit.Assume.assumeTrue(executable!=null && !executable.isEmpty());
        Process process=new ProcessBuilder(executable,"--wake-probe").redirectErrorStream(true).start();
        try {
            process.getOutputStream().write("wake-status\n".getBytes(StandardCharsets.UTF_8));process.getOutputStream().close();
            assertTrue("worker hung",process.waitFor(10,TimeUnit.SECONDS));assertEquals(0,process.exitValue());
            byte[] bytes=process.getInputStream().readAllBytes();assertTrue(bytes.length<=65536);
            WakeState state=new WakeState(new JSONObject(new String(bytes,StandardCharsets.UTF_8)));
            for(WakeState.Adapter item:state.adapters)assertNotNull(item.configuration);
        }finally{process.destroyForcibly();}
    }
    @Test public void cancelBeforeHttpRegistrationCannotSendLater() throws Exception {
        com.limelight.nvstream.http.LimelightCryptoProvider crypto=new com.limelight.nvstream.http.LimelightCryptoProvider() {
            public java.security.cert.X509Certificate getClientCertificate(){return null;}
            public java.security.PrivateKey getClientPrivateKey(){return null;}
            public byte[] getPemEncodedClientCertificate(){return new byte[0];}
            public String encodeBase64String(byte[] data){return java.util.Base64.getEncoder().encodeToString(data);}
        };
        com.limelight.nvstream.http.NvHTTP http=new com.limelight.nvstream.http.NvHTTP(
                new ComputerDetails.AddressTuple("127.0.0.1",48789),48784,"test",null,crypto);
        http.cancelWakeRequests();
        for(int i=0;i<2;i++)try {http.wakeRequest(WakeState.statusRequest());fail();}
        catch(IOException expected){assertEquals("WAKE_CANCELLED",expected.getMessage());}
    }
}
