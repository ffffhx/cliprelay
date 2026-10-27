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

/** A certificate-bound first-use request accepted by the host's connection policy. */
public final class LanPairing implements AutoCloseable {
    private final OkHttpClient client;
    private final HttpUrl url;
    private volatile X509Certificate serverCert;
    private volatile boolean contactedHost;
    private String id;
    private String nativeId;
    public String verification;
    private LanPairingFeedback feedback;
    private boolean cancelled, closed;
    private Call pendingCall, confirmationCall;
    private Thread confirmationOwner;
    private Thread monitor;
    private volatile IOException failure;
    private static final class StatusUnavailable extends IOException { }

    private LanPairing(ComputerDetails.AddressTuple address, LimelightCryptoProvider crypto, X509Certificate expected) throws IOException {
        serverCert = expected;
        url = new HttpUrl.Builder().scheme("https").host(address.address).port(address.port + 3)
                .addPathSegments("v1/pair").build();
        try {
            // Trust on first contact is limited to this short-lived bootstrap
            // client. The verification code binds both certificates and a nonce;
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
        return begin(address,crypto,expected,name,pin,ignored -> {});
    }

    public static LanPairing begin(ComputerDetails.AddressTuple address, LimelightCryptoProvider crypto,
                                   X509Certificate expected, String name, String pin,
                                   java.util.function.Consumer<LanPairing> register) throws IOException {
        LanPairing pairing = new LanPairing(address,crypto,expected);
        boolean retained=false;
        try {
            // Register before the first network call, so user cancellation also
            // owns bootstrap while it has not yet returned to the caller.
            register.accept(pairing);
            pairing.checkCancelled();
            byte[] random = new byte[16]; new SecureRandom().nextBytes(random);
            String nonce = hex(random);
            JSONObject data = new JSONObject().put("name",name).put("pin",pin).put("nonce",nonce);
            try (Response response = pairing.execute(new Request.Builder().url(pairing.url)
                    .header("X-ClipRelay-Pairing-Feedback","1")
                    .header("X-ClipRelay-Pairing-Native","1")
                    .post(RequestBody.create(MediaType.get("application/json"),data.toString())).build())) {
                pairing.checkCancelled();
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
                pairing.feedback=LanPairingFeedback.fromBootstrap(result);
                pairing.nativeId=LanPairingFeedback.nativeIdFromBootstrap(result);
                pairing.checkCancelled();retained=true;
                return pairing;
            }
        } catch (ConnectException oldHost) { pairing.checkCancelled(); return null; }
        catch (SocketTimeoutException timeout) {
            pairing.checkCancelled();
            if (!pairing.contactedHost) return null;
            throw new IOException("电脑响应超时，请重新发起配对",timeout);
        }
        catch (IOException error) { throw error; }
        catch (Exception error) { throw new IOException("无法发起电脑配对",error); }
        finally {
            pairing.releaseCall();
            if (!retained) { register.accept(null); pairing.close(); }
        }
    }

    private Response execute(Request request) throws IOException {
        final Call call;
        synchronized (this) { checkCancelled(); call=client.newCall(request); pendingCall=call; }
        return call.execute();
    }
    private synchronized void releaseCall() { pendingCall=null; }
    public synchronized void checkCancelled() throws IOException {
        if (failure!=null) throw failure;
        if (cancelled) throw new java.io.InterruptedIOException("配对已取消");
    }
    public IOException failure() { return failure; }
    // A native refusal may arrive before the periodic feedback read. Confirm
    // only its explanation; a waiting/approving result never means success.
    IOException confirmNativeFailure() throws IOException {
        if (feedback==null || nativeId==null) return failure;
        final Call call;
        synchronized (this) {
            checkCancelled();
            Request request=new Request.Builder().url(url.newBuilder().addPathSegment("status").build())
                    .post(RequestBody.create(MediaType.get("application/json"),feedback.query().toString())).build();
            call=client.newBuilder().callTimeout(2,TimeUnit.SECONDS).build().newCall(request);
            confirmationCall=call;confirmationOwner=Thread.currentThread();
        }
        try (Response response=call.execute()) {
            if (response.isSuccessful() && response.body()!=null) {
                okio.BufferedSource source=response.body().source();source.request(2049);
                if (source.buffer().size()<=2048) {
                    JSONObject value=new JSONObject(source.readUtf8());
                    try { feedback.observe(value); }
                    catch (IOException reason) { synchronized(this) { if (!cancelled && failure==null) failure=reason; } }
                }
            }
        } catch (Exception ignored) { /* Keep the original native failure if no bound reason was confirmed. */ }
        finally { synchronized(this) { if (confirmationCall==call) { confirmationCall=null;confirmationOwner=null;notifyAll(); } } }
        synchronized(this) {
            if (cancelled && failure==null) throw new java.io.InterruptedIOException("配对已取消");
            return failure;
        }
    }
    public void cancel() {
        final Call call, confirmation; final Thread thread;
        synchronized (this) { cancelled=true; call=pendingCall; confirmation=confirmationCall; thread=monitor; }
        if (call!=null) call.cancel();
        if (confirmation!=null) confirmation.cancel();
        if (thread!=null) thread.interrupt();
    }
    public synchronized void startFeedback(Runnable cancelNative) throws IOException {
        checkCancelled();
        if (feedback==null || monitor!=null) return;
        monitor=new Thread(() -> {
            try {
                int failedReads=0;
                for (;;) {
                    checkCancelled();
                    JSONObject status;
                    try (Response response=execute(new Request.Builder().url(url.newBuilder().addPathSegment("status").build())
                            .post(RequestBody.create(MediaType.get("application/json"),feedback.query().toString())).build())) {
                        if (response.code()==429 || response.code()==503) throw new IOException("Status temporarily unavailable");
                        if (!response.isSuccessful() || response.body()==null) throw new StatusUnavailable();
                        okio.BufferedSource source=response.body().source();source.request(2049);
                        if (source.buffer().size()>2048) throw new IOException("电脑返回的配对状态无效，已停止配对");
                        status=new JSONObject(source.readUtf8());
                    } catch (IOException error) {
                        checkCancelled();
                        if (error instanceof javax.net.ssl.SSLException) throw new IOException("配对安全连接失败，已停止配对",error);
                        if (error instanceof StatusUnavailable || ++failedReads>=3) throw new IOException("无法确认电脑的配对状态，请检查连接后重试",error);
                        Thread.sleep(750);continue;
                    } finally { releaseCall(); }
                    failedReads=0;
                    checkCancelled();feedback.observe(status);Thread.sleep(750);
                }
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            } catch (Exception error) {
                synchronized (LanPairing.this) {
                    if (cancelled) return;
                    failure=error instanceof IOException ? (IOException)error : new IOException("电脑返回的配对状态无效，已停止配对");
                }
                cancelNative.run();
            }
        },"ClipRelay pairing feedback");
        monitor.start();
    }

    public String sessionName() { return "ClipRelay-"+sessionId(); }
    public String sessionId() { return nativeId==null?id:nativeId; }
    public String nativeSessionId() { return nativeId; }
    public X509Certificate hostCertificate() { return serverCert; }
    private static String hex(byte[] bytes) {
        StringBuilder out=new StringBuilder(); for(byte b:bytes) out.append(String.format(Locale.ROOT,"%02x",b&255)); return out.toString();
    }
    @Override public void close() {
        synchronized (this) { if (closed) return; closed=true; }
        cancel();
        final Thread thread;
        synchronized (this) { thread=monitor; }
        boolean interrupted=false;
        if (thread!=null && thread!=Thread.currentThread()) {
            while (thread.isAlive()) {
                try { thread.join(); } catch (InterruptedException ignored) { interrupted=true; }
            }
        }
        synchronized(this) {
            while(confirmationCall!=null && confirmationOwner!=Thread.currentThread()) {
                try { wait(); } catch(InterruptedException ignored) { interrupted=true; }
            }
        }
        if (id != null) {
            Request.Builder request=new Request.Builder().url(url.newBuilder().addPathSegment(id).build()).delete();
            if (feedback!=null) request.header("X-ClipRelay-Pairing-Receipt",feedback.receipt);
            try (Response ignored = client.newBuilder().callTimeout(1500,TimeUnit.MILLISECONDS).build().newCall(request.build()).execute()) { }
            catch (IOException ignored) { }
        }
        client.connectionPool().evictAll();
        if (interrupted) Thread.currentThread().interrupt();
    }
}
