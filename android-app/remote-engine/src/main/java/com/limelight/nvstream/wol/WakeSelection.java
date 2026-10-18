package com.limelight.nvstream.wol;

import org.json.JSONException;
import org.json.JSONObject;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.Locale;

/** A saved target is bound to the exact paired certificate, including its chosen helper. */
public final class WakeSelection {
    public final String target, targetPin, adapter, mac, network, helper, helperPin;
    public final long capturedAt;
    public WakeSelection(JSONObject value) throws JSONException {
        if(WakeState.integer(value,"version")!=1)throw new JSONException("WAKE_CONFIG_VERSION");
        target=WakeState.string(value,"target");targetPin=WakeState.string(value,"targetPin");
        adapter=WakeState.string(value,"adapter");mac=WakeState.string(value,"mac");network=WakeState.string(value,"network");
        helper=WakeState.string(value,"helper");helperPin=WakeState.string(value,"helperPin");capturedAt=WakeState.integer(value,"capturedAt");
        if(target.isEmpty() || target.length()>128 || helper.length()>128 || target.equals(helper) ||
                !targetPin.matches("[0-9a-f]{64}") || !helperPin.matches("[0-9a-f]{64}") || helper.isEmpty() ||
                !adapter.matches("(?i)[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}") || capturedAt<=0)
            throw new JSONException("WAKE_CONFIG_INVALID");
        WakeState.sendRequest("00000000000000000000000000000000",mac,network);
    }
    public boolean matches(String targetId,X509Certificate certificate,long now) {
        return matchesIdentity(targetId,fingerprint(certificate),now);
    }
    public boolean matchesIdentity(String targetId,String pin,long now) {
        return target.equals(targetId) && targetPin.equals(pin) && now>=capturedAt && now-capturedAt<=30L*86400000;
    }
    public boolean matchesHelper(String id,X509Certificate certificate) {return helper.equals(id) && helperPin.equals(fingerprint(certificate));}
    public JSONObject json() throws JSONException {return new JSONObject().put("version",1).put("target",target).put("targetPin",targetPin)
            .put("adapter",adapter).put("mac",mac).put("network",network).put("helper",helper).put("helperPin",helperPin).put("capturedAt",capturedAt);}
    public static WakeSelection create(String target,X509Certificate targetCert,WakeState.Adapter adapter,String network,
                                       String helper,X509Certificate helperCert,long now) throws JSONException {
        if(!adapter.connected || !adapter.networks.contains(network))throw new JSONException("WAKE_CONFIG_INVALID");
        return new WakeSelection(new JSONObject().put("version",1).put("target",target).put("targetPin",fingerprint(targetCert))
                .put("adapter",adapter.id).put("mac",adapter.mac).put("network",network).put("helper",helper)
                .put("helperPin",fingerprint(helperCert)).put("capturedAt",now));
    }
    public static String fingerprint(X509Certificate certificate) {
        if(certificate==null)return "";
        try { byte[] digest=MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded());StringBuilder text=new StringBuilder();
            for(byte item:digest)text.append(String.format(Locale.ROOT,"%02x",item&255));return text.toString();
        }catch(java.security.GeneralSecurityException error){return "";}
    }
}
