package com.limelight.nvstream.wol;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;

/** Hardware settings are observations, never proof that a sleeping machine will wake. */
public final class WakeState {
    public final List<Adapter> adapters;
    public static final class Adapter {
        public final String id, name, mac, kind, configuration;
        public final boolean connected;
        public final List<String> networks;
        private Adapter(JSONObject value) throws JSONException {
            id = string(value,"id"); name = string(value,"name"); mac = string(value,"mac"); kind = string(value,"kind");
            configuration = string(value,"configuration"); connected = bool(value,"connected");
            if (!id.matches("(?i)[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}") || name.length()>128 ||
                    name.indexOf('\0')>=0 || name.indexOf('\r')>=0 || name.indexOf('\n')>=0 ||
                    !(kind.equals("ethernet") || kind.equals("wifi"))) throw invalid();
            try { magicPacket(mac); } catch(IOException e) { throw invalid(); }
            String power=setting(value,"powerManagement"), magic=setting(value,"magicPacket"), armed=setting(value,"wakeArmed");
            if (armed.equals("unsupported") || !configuration.equals(configuration(power,magic,armed))) throw invalid();
            JSONArray addresses=value.getJSONArray("addresses");
            if(addresses.length()>8)throw invalid();
            ArrayList<String> list=new ArrayList<>();
            for(int i=0;i<addresses.length();i++) {
                JSONObject item=addresses.getJSONObject(i); String address=string(item,"address");
                long prefix=integer(item,"prefix"); if(prefix<1 || prefix>32)throw invalid();
                int ip=ipv4(address); int first=(ip>>>24)&255;
                if(first==0 || first==127 || first>=224)throw invalid();
                if(prefix<=30) {
                    int mask=-1 << (32-(int)prefix); int base=ip&mask;
                    if(ip!=base && ip!=(base|~mask)) {
                        String network=format(base)+"/"+prefix;
                        if(!list.contains(network))list.add(network);
                    }
                }
            }
            networks=Collections.unmodifiableList(list);
        }
    }
    public WakeState(JSONObject value) throws JSONException {
        if(!bool(value,"ok") || !bool(value,"supported") || bool(value,"wakeVerified") || !(string(value,"platform").equals("windows") || string(value,"platform").equals("macos")))throw invalid();
        JSONArray array=value.getJSONArray("adapters"); if(array.length()>32)throw invalid();
        ArrayList<Adapter> list=new ArrayList<>(); HashSet<String> ids=new HashSet<>();
        for(int i=0;i<array.length();i++) {
            Adapter adapter=new Adapter(array.getJSONObject(i));
            if(!ids.add(adapter.id.toLowerCase(Locale.ROOT)))throw invalid();
            list.add(adapter);
        }
        adapters=Collections.unmodifiableList(list);
    }
    public boolean hasNetwork(String network) {
        for(Adapter adapter:adapters)if(adapter.connected && adapter.networks.contains(network))return true;
        return false;
    }
    public boolean hasTarget(String id,String mac) {
        for(Adapter adapter:adapters)if(adapter.id.equalsIgnoreCase(id) && adapter.mac.equalsIgnoreCase(mac))return true;
        return false;
    }
    public static String configuration(String power,String magic,String armed) {
        if(!power.equals("enabled"))return power.equals("disabled")?"disabled":"unknown";
        if(magic.equals("unsupported"))return "unsupported";
        if(magic.equals("disabled") || armed.equals("disabled"))return "disabled";
        return magic.equals("enabled") && armed.equals("enabled")?"configured":"unknown";
    }
    public static JSONObject statusRequest() throws JSONException { return new JSONObject().put("op","status"); }
    public static JSONObject sendRequest(String id,String mac,String network) throws JSONException {
        if(id==null || !id.matches("[0-9a-f]{32}"))throw invalid();
        try{magicPacket(mac);}catch(IOException error){throw invalid();}
        validateNetwork(network);
        return new JSONObject().put("op","send").put("id",id).put("mac",mac.toUpperCase(Locale.ROOT)).put("network",network);
    }
    public static int sentCount(JSONObject value) throws JSONException {
        if(!bool(value,"ok") || bool(value,"wakeVerified") || !string(value,"state").equals("sent"))throw invalid();
        long sent=integer(value,"sent");if(sent<1 || sent>24)throw invalid();return (int)sent;
    }
    public static void validateNetwork(String network) throws JSONException {
        if(network==null || !network.matches("[0-9.]+/[0-9]{1,2}"))throw invalid();
        String[] parts=network.split("/");int prefix=Integer.parseInt(parts[1]);
        if(prefix<1 || prefix>30 || !parts[1].equals(Integer.toString(prefix)))throw invalid();
        int ip=ipv4(parts[0]), mask=-1 << (32-prefix);
        if((ip&mask)!=ip)throw invalid();
    }
    public static int ipv4(String address) throws JSONException {
        String[] parts=address.split("\\.",-1);if(parts.length!=4)throw invalid();int ip=0;
        for(String part:parts) {
            if(!part.matches("0|[1-9][0-9]{0,2}"))throw invalid();int value=Integer.parseInt(part);
            if(value>255)throw invalid();ip=(ip<<8)|value;
        }
        return ip;
    }
    public static String format(int address) { return ((address>>>24)&255)+"."+((address>>>16)&255)+"."+((address>>>8)&255)+"."+(address&255); }
    public static byte[] magicPacket(String mac) throws IOException {
        if(mac==null || !mac.matches("(?i)[0-9a-f]{2}(:[0-9a-f]{2}){5}"))throw new IOException("WAKE_INVALID_MAC");
        String[] parts=mac.split(":"); byte[] bytes=new byte[6];boolean nonzero=false;
        for(int i=0;i<6;i++){bytes[i]=(byte)Integer.parseInt(parts[i],16);nonzero|=bytes[i]!=0;}
        if(!nonzero || (bytes[0]&1)!=0)throw new IOException("WAKE_INVALID_MAC");
        byte[] packet=new byte[102];java.util.Arrays.fill(packet,0,6,(byte)255);
        for(int i=6;i<packet.length;i+=6)System.arraycopy(bytes,0,packet,i,6);
        return packet;
    }
    private static String setting(JSONObject value,String key) throws JSONException {
        String result=string(value,key);
        if(!result.equals("enabled") && !result.equals("disabled") && !result.equals("unsupported") && !result.equals("unknown"))throw invalid();
        return result;
    }
    static String string(JSONObject value,String key) throws JSONException {Object item=value.get(key);if(!(item instanceof String))throw invalid();return (String)item;}
    static boolean bool(JSONObject value,String key) throws JSONException {Object item=value.get(key);if(!(item instanceof Boolean))throw invalid();return (Boolean)item;}
    static long integer(JSONObject value,String key) throws JSONException {Object item=value.get(key);if(!(item instanceof Integer) && !(item instanceof Long))throw invalid();return ((Number)item).longValue();}
    private static JSONException invalid() { return new JSONException("WAKE_INVALID_RESPONSE"); }
}
