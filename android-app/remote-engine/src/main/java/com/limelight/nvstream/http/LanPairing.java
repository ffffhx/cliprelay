package com.limelight.nvstream.http;

import java.io.IOException;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.X509TrustManager;
import okhttp3.*;
import org.json.JSONObject;

/** A certificate-bound first-use request. Only the computer's operator approves it. */
public final class LanPairing implements AutoCloseable {
    private final OkHttpClient client;
    private final HttpUrl url;
    private volatile X509Certificate serverCert;
    private volatile boolean contactedHost;
    private String id;
    public String verification;

    private LanPairing(ComputerDetails.AddressTuple address, LimelightCryptoProvider crypto, X509Certificate expected) throws IOException {
        serverCert = expected;
        url = new HttpUrl.Builder().scheme("https").host(address.address).port(address.port + 3)
                .addPathSegments("v1/pair").build();
        try {
            // Trust on first contact is limited to this short-lived bootstrap
            // client. The displayed code binds both certificates and a nonce;
            // normal stream requests keep their existing strict certificate pin.
            X509TrustManager trust = new X509TrustManager() {
                public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                public void checkClientTrusted(X509Certificate[] chain, String auth) throws CertificateException { throw new CertificateException("not a server"); }
                public synchronized void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                    contactedHost = true;
                    if (chain.length != 1) throw new CertificateException("invalid host chain");
                    if (serverCert == null) serverCert = chain[0];
                    else if (!serverCert.equals(chain[0])) throw new CertificateException("host identity changed");
                }
            };
            KeyStore keys = KeyStore.getInstance(KeyStore.getDefaultType());
            keys.load(null); keys.setKeyEntry("client", crypto.getClientPrivateKey(), new char[0], new Certificate[]{crypto.getClientCertificate()});
            KeyManagerFactory km = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()); km.init(keys, new char[0]);
            SSLContext tls = SSLContext.getInstance("TLS"); tls.init(km.getKeyManagers(), new javax.net.ssl.TrustManager[]{trust}, new SecureRandom());
            client = new OkHttpClient.Builder().sslSocketFactory(tls.getSocketFactory(), trust)
                    .hostnameVerifier((host, session) -> {
                        try { return serverCert != null && serverCert.equals(session.getPeerCertificates()[0]); }
                        catch (Exception error) { return false; }
                    }).connectTimeout(1800,TimeUnit.MILLISECONDS).readTimeout(4,TimeUnit.SECONDS).callTimeout(6,TimeUnit.SECONDS)
                    .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build();
        } catch (Exception error) { throw new IOException("无法准备配对身份", error); }
    }

    public static LanPairing begin(ComputerDetails.AddressTuple address, LimelightCryptoProvider crypto,
                                   X509Certificate expected, String name, String pin) throws IOException {
        LanPairing pairing = new LanPairing(address,crypto,expected);
        try {
            byte[] random = new byte[16]; new SecureRandom().nextBytes(random);
            String nonce = hex(random);
            JSONObject data = new JSONObject().put("name",name).put("pin",pin).put("nonce",nonce);
            try (Response response = pairing.client.newCall(new Request.Builder().url(pairing.url)
                    .post(RequestBody.create(MediaType.get("application/json"),data.toString())).build()).execute()) {
                if (response.code()==404) return null; // Older hosts retain manual PIN pairing.
                if (!response.isSuccessful() || response.body()==null) throw new IOException("电脑暂时无法接受配对，请稍后重试");
                okio.BufferedSource source = response.body().source(); source.request(2049);
                if (source.buffer().size()>2048) throw new IOException("无效的配对响应");
                JSONObject result = new JSONObject(source.readUtf8());
                MessageDigest hash = MessageDigest.getInstance("SHA-256");
                hash.update("cliprelay-lan-pair-v1\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
                hash.update(pairing.serverCert.getEncoded()); hash.update(crypto.getClientCertificate().getEncoded());
                byte[] digest = hash.digest(nonce.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                String full = hex(digest);
                String code = (full.substring(0,4)+" "+full.substring(4,8)+" "+full.substring(8,12)).toUpperCase(Locale.ROOT);
                if (!full.substring(0,32).equals(result.getString("id")) || !code.equals(result.getString("verification")))
                    throw new IOException("配对确认标识不匹配");
                pairing.id = full.substring(0,32); pairing.verification = code;
                return pairing;
            }
        } catch (ConnectException oldHost) { return null; }
        catch (SocketTimeoutException timeout) {
            if (!pairing.contactedHost) return null;
            throw new IOException("电脑响应超时，请重新发起配对",timeout);
        }
        catch (IOException error) { throw error; }
        catch (Exception error) { throw new IOException("无法发起电脑配对",error); }
    }

    public String sessionName() { return "ClipRelay-"+id; }
    public String sessionId() { return id; }
    public X509Certificate hostCertificate() { return serverCert; }
    private static String hex(byte[] bytes) {
        StringBuilder out=new StringBuilder(); for(byte b:bytes) out.append(String.format(Locale.ROOT,"%02x",b&255)); return out.toString();
    }
    @Override public void close() {
        if (id != null) {
            try (Response ignored = client.newCall(new Request.Builder().url(url.newBuilder().addPathSegment(id).build()).delete().build()).execute()) { }
            catch (IOException ignored) { }
        }
        client.connectionPool().evictAll();
    }
}
