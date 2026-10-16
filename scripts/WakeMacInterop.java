import com.limelight.nvstream.wol.WakeState;
import com.limelight.nvstream.wol.WakeSelection;
import org.json.JSONObject;
import javax.net.ssl.*;
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.*;

// JVM adapter uses the shipped Android parser. Activity/NvHTTP acceptance is separate.
public final class WakeMacInterop {
    private final SSLSocketFactory tls;
    private WakeMacInterop(JSONObject config) throws Exception {
        Path directory = Path.of(config.getString("state"));
        X509Certificate cert;
        try (InputStream input = Files.newInputStream(directory.resolve("cacert.pem"))) {
            cert = (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(input);
        }
        String pem = Files.readString(directory.resolve("cakey.pem"));
        byte[] der = Base64.getDecoder().decode(pem.replace("-----BEGIN PRIVATE KEY-----", "")
                .replace("-----END PRIVATE KEY-----", "").replaceAll("\\s", ""));
        PrivateKey key = KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(der));
        KeyStore keys = KeyStore.getInstance("PKCS12"); keys.load(null, null);
        keys.setKeyEntry("client", key, new char[0], new java.security.cert.Certificate[]{cert});
        KeyManagerFactory km = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        km.init(keys, new char[0]);
        KeyStore trust = KeyStore.getInstance("PKCS12"); trust.load(null, null); trust.setCertificateEntry("host", cert);
        TrustManagerFactory tm = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); tm.init(trust);
        SSLContext context = SSLContext.getInstance("TLS"); context.init(km.getKeyManagers(), tm.getTrustManagers(), null);
        tls = context.getSocketFactory();
    }
    private WakeState status() throws Exception {
        HttpsURLConnection connection=(HttpsURLConnection)URI.create("https://127.0.0.1:48791/v1/wake").toURL().openConnection();
        connection.setSSLSocketFactory(tls);
        connection.setConnectTimeout(5000);connection.setReadTimeout(10000);
        connection.setRequestMethod("POST");connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type","application/json");
        byte[] body=WakeState.statusRequest().toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(body.length);
        try {
            try(OutputStream stream=connection.getOutputStream()){stream.write(body);}
            if(connection.getResponseCode()!=200)throw new AssertionError("native wake status failed");
            byte[] raw;
            try(InputStream stream=connection.getInputStream()){raw=stream.readNBytes(65537);}
            if(raw.length>65536)throw new AssertionError("unbounded response");
            JSONObject value=new JSONObject(new String(raw,StandardCharsets.UTF_8));
            if(!value.getString("platform").equals("macos"))throw new AssertionError("wrong native platform");
            return new WakeState(value);
        }finally{connection.disconnect();}
    }
    public static void main(String[] args) throws Exception {
        byte[] input=System.in.readNBytes(65537);
        if(input.length>65536)throw new AssertionError("unbounded fixture input");
        JSONObject config=new JSONObject(new String(input,StandardCharsets.UTF_8));
        WakeState state=new WakeMacInterop(config).status();
        if(state.adapters.isEmpty())throw new AssertionError("missing native adapter");
        for(WakeState.Adapter item:state.adapters) {
            if(!item.configuration.equals("unknown") || !state.hasTarget(item.id,item.mac))throw new AssertionError("native identity or power claim");
            JSONObject selection=new JSONObject().put("version",1).put("target","native-target").put("targetPin","a".repeat(64))
                .put("helper","native-helper").put("helperPin","b".repeat(64)).put("adapter",item.id).put("mac",item.mac)
                .put("network",config.getString("absentNetwork")).put("capturedAt",1000L);
            WakeSelection saved=new WakeSelection(selection);
            if(!new WakeSelection(saved.json()).adapter.equals(item.id))throw new AssertionError("saved Mac identity changed");
        }
        System.out.println(new JSONObject().put("passed",true).put("adapters",state.adapters.size()));
    }
}
