package com.cliprelay.app;

import com.limelight.nvstream.http.*;
import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;
import javax.net.ssl.*;
import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.security.cert.*;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static org.junit.Assert.*;

public class LanPairingFeedbackTest {
    private static JSONObject identities;
    @BeforeClass public static void certificates() throws Exception {
        String configured=System.getenv("CLIPRELAY_PAIRING_TEST_IDENTITIES");
        if (configured!=null) { identities=new JSONObject(Files.readString(Path.of(configured)));return; }
        Path root=Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (root!=null && !Files.isRegularFile(root.resolve("windows/tests/mac-pairing-fixture/main.go"))) root=root.getParent();
        assertNotNull("Cannot locate synthetic certificate fixture",root);
        Path output=Files.createTempFile("cliprelay-pair-feedback-",".json");
        try {
            ProcessBuilder builder=new ProcessBuilder("go","run",root.resolve("windows/tests/mac-pairing-fixture/main.go").toString());
            builder.environment().put("GOTOOLCHAIN","local");builder.redirectOutput(output.toFile());builder.redirectError(ProcessBuilder.Redirect.INHERIT);
            Process process=builder.start();
            if (!process.waitFor(60,TimeUnit.SECONDS)) { process.destroyForcibly();process.waitFor();fail("Certificate generator timeout"); }
            assertEquals("Certificate generator failed",0,process.exitValue());identities=new JSONObject(Files.readString(output));
        } finally { Files.deleteIfExists(output); }
    }
    private static X509Certificate cert(String name) throws Exception {
        return (X509Certificate)CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(identities.getJSONObject(name).getString("cert").getBytes(StandardCharsets.US_ASCII)));
    }
    private static PrivateKey key(String name) throws Exception {
        String pem=identities.getJSONObject(name).getString("key").replace("-----BEGIN PRIVATE KEY-----","").replace("-----END PRIVATE KEY-----","").replaceAll("\\s","");
        return KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(Base64.getDecoder().decode(pem)));
    }
    private static LimelightCryptoProvider identity() throws Exception {
        X509Certificate certificate=cert("client");PrivateKey privateKey=key("client");byte[] pem=identities.getJSONObject("client").getString("cert").getBytes(StandardCharsets.US_ASCII);
        return new LimelightCryptoProvider() {
            public X509Certificate getClientCertificate(){return certificate;}
            public PrivateKey getClientPrivateKey(){return privateKey;}
            public byte[] getPemEncodedClientCertificate(){return pem;}
            public String encodeBase64String(byte[] value){return Base64.getEncoder().encodeToString(value);}
        };
    }
    private static void until(java.util.function.BooleanSupplier done) throws Exception {
        long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
        while(!done.getAsBoolean()){assertTrue("Feedback fixture deadline",System.nanoTime()<end);Thread.sleep(5);}
    }
    private static final class Host implements AutoCloseable {
        final SSLServerSocket server;final ExecutorService executor=Executors.newCachedThreadPool();
        final Set<SSLSocket> sockets=ConcurrentHashMap.newKeySet();
        final AtomicInteger statusReads=new AtomicInteger(),bootstrapReads=new AtomicInteger(),deletes=new AtomicInteger();
        volatile String state="waiting",id;final String receipt="cccccccccccccccccccccccccccccccc";final long expires=System.currentTimeMillis()/1000+120;
        volatile boolean legacy,notFound,stall,invalid,nativeTicket;volatile int transientFailures;volatile String deleteReceipt;
        final String nativeId="dddddddddddddddddddddddddddddddd";
        final CountDownLatch release=new CountDownLatch(1);volatile Throwable failure;
        Host() throws Exception {
            X509Certificate host=cert("host"),client=cert("client");KeyStore keys=KeyStore.getInstance(KeyStore.getDefaultType());keys.load(null);
            keys.setKeyEntry("host",key("host"),new char[0],new java.security.cert.Certificate[]{host});
            KeyManagerFactory km=KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());km.init(keys,new char[0]);
            X509TrustManager trust=new X509TrustManager(){
                public X509Certificate[] getAcceptedIssuers(){return new X509Certificate[0];}
                public void checkServerTrusted(X509Certificate[] c,String auth) throws CertificateException{throw new CertificateException("not a client");}
                public void checkClientTrusted(X509Certificate[] c,String auth) throws CertificateException{if(c.length!=1||!client.equals(c[0]))throw new CertificateException("wrong fixture client");}
            };
            SSLContext tls=SSLContext.getInstance("TLS");tls.init(km.getKeyManagers(),new TrustManager[]{trust},new SecureRandom());
            server=(SSLServerSocket)tls.getServerSocketFactory().createServerSocket();server.bind(new InetSocketAddress("127.0.0.1",0));server.setNeedClientAuth(true);
            executor.submit(()->{while(!server.isClosed()){
                final SSLSocket socket;
                try{socket=(SSLSocket)server.accept();sockets.add(socket);}catch(IOException stopped){break;}
                executor.submit(()->{try(socket){
                    socket.setSoTimeout(5000);socket.startHandshake();assertEquals(client,socket.getSession().getPeerCertificates()[0]);
                    BufferedInputStream input=new BufferedInputStream(socket.getInputStream());String[] first=line(input).split(" ");
                    String route=first[1];Map<String,String> headers=new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
                    for(String header=line(input);!header.isEmpty();header=line(input)){int colon=header.indexOf(':');headers.put(header.substring(0,colon),header.substring(colon+1).trim());}
                    if (first[0].equals("DELETE")) {
                        deleteReceipt=headers.get("X-ClipRelay-Pairing-Receipt");
                        if(!legacy)assertEquals(receipt,deleteReceipt);deletes.incrementAndGet();respond(socket,204,null);return;
                    }
                    int length=Integer.parseInt(headers.getOrDefault("Content-Length","0"));assertTrue(length<=2048);
                    JSONObject body=new JSONObject(new String(input.readNBytes(length),StandardCharsets.UTF_8));
                    JSONObject result;
                    if(route.equals("/v1/pair/status")) {
                        statusReads.incrementAndGet();assertEquals(id,body.getString("id"));assertEquals(receipt,body.getString("receipt"));
                        if(statusReads.get()<=transientFailures)return;
                        if(stall){socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 999\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));socket.getOutputStream().flush();release.await(10,TimeUnit.SECONDS);return;}
                        result=new JSONObject().put("protocol",1).put("id",id).put("receipt",invalid?"bad":receipt).put("expires",expires).put("state",state);
                    } else {
                        bootstrapReads.incrementAndGet();assertEquals("1",headers.get("X-ClipRelay-Pairing-Feedback"));
                        assertEquals("1",headers.get("X-ClipRelay-Pairing-Native"));
                        if(notFound){respond(socket,404,null);return;}
                        MessageDigest hash=MessageDigest.getInstance("SHA-256");hash.update("cliprelay-lan-pair-v1\n".getBytes(StandardCharsets.UTF_8));hash.update(host.getEncoded());hash.update(client.getEncoded());
                        byte[] digest=hash.digest(body.getString("nonce").getBytes(StandardCharsets.UTF_8));StringBuilder hex=new StringBuilder();for(byte b:digest)hex.append(String.format(Locale.ROOT,"%02x",b&255));
                        id=hex.substring(0,32);String code=(hex.substring(0,4)+" "+hex.substring(4,8)+" "+hex.substring(8,12)).toUpperCase(Locale.ROOT);
                        result=new JSONObject().put("id",id).put("name","Fixture").put("verification",code).put("expires",expires);
                        if(!legacy)result.put("feedback",new JSONObject().put("protocol",1).put("receipt",receipt));
                        if(nativeTicket)result.put("native",new JSONObject().put("protocol",1).put("id",nativeId));
                    }
                    respond(socket,200,result.toString());
                } catch(IOException cancelled) { /* A cancelled client may close its TLS socket mid-response. */ }
                catch(Throwable error){failure=error;}
                finally{sockets.remove(socket);}});
            }});
        }
        static String line(InputStream input) throws IOException {
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();
            for(int value;(value=input.read())!=-1;){if(value=='\n')return bytes.toString(StandardCharsets.US_ASCII).replace("\r","");bytes.write(value);if(bytes.size()>4096)throw new IOException("fixture header too large");}
            throw new EOFException();
        }
        static void respond(SSLSocket socket,int code,String body) throws IOException {
            byte[] bytes=body==null?new byte[0]:body.getBytes(StandardCharsets.UTF_8);
            socket.getOutputStream().write(("HTTP/1.1 "+code+" Fixture\r\nContent-Type: application/json\r\nContent-Length: "+bytes.length+"\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            socket.getOutputStream().write(bytes);socket.getOutputStream().flush();
        }
        LanPairing begin(java.util.function.Consumer<LanPairing> register) throws Exception {
            return LanPairing.begin(new ComputerDetails.AddressTuple("127.0.0.1",server.getLocalPort()-3),identity(),cert("host"),"Test phone","1234",register);
        }
        public void close() throws Exception {
            release.countDown();server.close();for(SSLSocket socket:sockets)socket.close();
            // Released handlers must finish before any interrupt escalation;
            // shutdownNow races the latch and turns normal teardown into a failure.
            executor.shutdown();
            if(!executor.awaitTermination(3,TimeUnit.SECONDS)){executor.shutdownNow();assertTrue(executor.awaitTermination(3,TimeUnit.SECONDS));fail("Fixture workers did not stop normally");}
            if(failure!=null)throw new AssertionError(failure);
        }
    }

    @Test public void rejectionAndExpiryCancelTheNativeOwnerWithFixedReasons() throws Exception {
        for(String state:new String[]{"rejected","expired","cancelled"})try(Host host=new Host();LanPairing pairing=host.begin(ignored->{})){
            host.state=state;AtomicInteger stopped=new AtomicInteger();pairing.startFeedback(()->{stopped.incrementAndGet();pairing.cancel();});
            until(()->stopped.get()==1);assertNotNull(pairing.failure());assertTrue(pairing.failure().getMessage().contains(state.equals("rejected")?"拒绝":state.equals("expired")?"过期":"结束"));
            try{pairing.checkCancelled();fail();}catch(IOException expected){assertSame(pairing.failure(),expected);}
            pairing.close();assertEquals(1,host.deletes.get());assertEquals(host.receipt,host.deleteReceipt);
        }
    }
    @Test public void approvalAndPINForwardingDoNotAuthorizeOrCancel() throws Exception {
        try(Host host=new Host();LanPairing pairing=host.begin(ignored->{})){
            AtomicInteger stopped=new AtomicInteger();host.state="approving";pairing.startFeedback(stopped::incrementAndGet);until(()->host.statusReads.get()>0);
            host.state="handshake";until(()->host.statusReads.get()>1);assertNull(pairing.failure());assertEquals(0,stopped.get());
            pairing.close();int reads=host.statusReads.get();Thread.sleep(800);assertEquals(reads,host.statusReads.get());
        }
    }
    @Test public void closeCancelsAStatusBodyReadAndJoinsTheMonitor() throws Exception {
        try(Host host=new Host();LanPairing pairing=host.begin(ignored->{})){
            host.stall=true;pairing.startFeedback(()->fail("cancelled status called native failure"));until(()->host.statusReads.get()==1);
            long start=System.nanoTime();pairing.close();assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-start)<2500);assertNull(pairing.failure());
            assertFalse(Thread.getAllStackTraces().keySet().stream().anyMatch(t->t.isAlive()&&t.getName().equals("ClipRelay pairing feedback")));
        }
    }
    @Test public void registrationOwnsCancellationBeforeBootstrapAndFallbackReleasesIt() throws Exception {
        try(Host host=new Host()){
            AtomicReference<LanPairing> owner=new AtomicReference<>();
            try{host.begin(value->{owner.set(value);if(value!=null)value.cancel();});fail();}catch(IOException expected){assertTrue(expected.getMessage().contains("取消"));}
            assertNull(owner.get());assertEquals(0,host.bootstrapReads.get());
            host.notFound=true;assertNull(host.begin(owner::set));assertNull(owner.get());assertEquals(0,host.statusReads.get());
        }
    }
    @Test public void malformedStatusStopsAndLegacyBootstrapNeedsNoMonitor() throws Exception {
        try(Host host=new Host();LanPairing pairing=host.begin(ignored->{})){
            host.invalid=true;AtomicInteger stopped=new AtomicInteger();pairing.startFeedback(stopped::incrementAndGet);until(()->stopped.get()==1);assertTrue(pairing.failure().getMessage().contains("无效"));
        }
        try(Host host=new Host()){
            host.legacy=true;try(LanPairing pairing=host.begin(ignored->{})){pairing.startFeedback(()->fail());Thread.sleep(40);assertEquals(0,host.statusReads.get());assertNull(pairing.failure());}
        }
    }
    @Test public void metadataAndStatusRejectCoercionOrAChangedGeneration() throws Exception {
        JSONObject bootstrap=new JSONObject().put("id","a".repeat(32)).put("expires",123).put("feedback",new JSONObject().put("protocol",1).put("receipt","b".repeat(32)));
        LanPairingFeedback feedback=LanPairingFeedback.fromBootstrap(bootstrap);
        assertNull(LanPairingFeedback.fromBootstrap(new JSONObject()));
        for(Object expires:new Object[]{"123",1.5,0}){bootstrap.put("expires",expires);try{LanPairingFeedback.fromBootstrap(bootstrap);fail();}catch(IOException expected){}}
        for(Object state:new Object[]{"paired",true,JSONObject.NULL}){
            JSONObject value=new JSONObject().put("protocol",1).put("id",feedback.id).put("receipt",feedback.receipt).put("expires",feedback.expires).put("state",state);
            try{feedback.observe(value);fail();}catch(IOException expected){assertTrue(expected.getMessage().contains("无效"));}
        }
    }
    @Test public void transientStatusReadsRetryWithinAFixedBound() throws Exception {
        for(int failures:new int[]{1,3})try(Host host=new Host();LanPairing pairing=host.begin(ignored->{})){
            host.transientFailures=failures;host.state="rejected";AtomicInteger stopped=new AtomicInteger();pairing.startFeedback(stopped::incrementAndGet);
            until(()->stopped.get()==1);assertEquals(Math.min(failures+1,3),host.statusReads.get());assertTrue(pairing.failure().getMessage().contains(failures==1?"拒绝":"无法确认"));
        }
    }
    private static String nativePairing(NvHTTP http) throws Exception {
        java.lang.reflect.Method method=NvHTTP.class.getDeclaredMethod("executePairingCommand",String.class,boolean.class);method.setAccessible(true);
        try{return (String)method.invoke(http,"phrase=getservercert",false);}
        catch(java.lang.reflect.InvocationTargetException error){if(error.getCause() instanceof IOException)throw (IOException)error.getCause();throw error;}
    }
    @Test public void nativePairingCancellationOwnsCallsBeforeRegistration() throws Exception {
        NvHTTP http=new NvHTTP(new ComputerDetails.AddressTuple("127.0.0.1",48789),0,"fixture",null,identity());
        http.beginPairing();http.cancelPairing();
        try{nativePairing(http);fail();}catch(IOException expected){assertTrue(expected.getMessage().contains("取消"));}
    }
    @Test public void nativeGenerationMetadataRequiresExactTypesAndFeedback() throws Exception {
        assertNull(LanPairingFeedback.nativeIdFromBootstrap(new JSONObject()));
        JSONObject value=new JSONObject().put("feedback",new JSONObject()).put("native",new JSONObject().put("protocol",1).put("id","d".repeat(32)));
        assertEquals("d".repeat(32),LanPairingFeedback.nativeIdFromBootstrap(value));
        for(Object bad:new Object[]{"1",2,1.5}) {
            value.getJSONObject("native").put("protocol",bad);
            try{LanPairingFeedback.nativeIdFromBootstrap(value);fail();}catch(IOException expected){}
        }
        value.getJSONObject("native").put("protocol",1);value.remove("feedback");
        try{LanPairingFeedback.nativeIdFromBootstrap(value);fail();}catch(IOException expected){}
    }
    @Test public void nativeGenerationIsSentOnTheActualPairingRequest() throws Exception { exerciseNativeRefusal(null); }
    @Test public void fastNativeRefusalPreservesTheAuthenticatedTerminalReason() throws Exception {
        for(String state:new String[]{"rejected","expired","cancelled"})exerciseNativeRefusal(state);
    }
    private void exerciseNativeRefusal(String terminalState) throws Exception {
        try(Host host=new Host();java.net.ServerSocket server=new java.net.ServerSocket(0,1,java.net.InetAddress.getByName("127.0.0.1"))) {
            host.nativeTicket=true;
            ExecutorService worker=Executors.newSingleThreadExecutor();
            NvHTTP http=new NvHTTP(new ComputerDetails.AddressTuple("127.0.0.1",server.getLocalPort()),0,"fixture",null,identity());
            Future<String> observed=worker.submit(()->{try(java.net.Socket socket=server.accept()){
                socket.setSoTimeout(5000);BufferedInputStream input=new BufferedInputStream(socket.getInputStream());String line=Host.line(input);
                while(!Host.line(input).isEmpty()){}
                if(terminalState!=null)host.state=terminalState;
                byte[] body="<root status_code=\"400\"/>".getBytes(StandardCharsets.US_ASCII);
                socket.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Length: "+body.length+"\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                socket.getOutputStream().write(body);socket.getOutputStream().flush();return line;
            }});
            try {
                LanPairing pairing=host.begin(http::ownLanPairing);http.setLanPairingSession(pairing);
                assertEquals(host.nativeId,pairing.sessionId());assertEquals("ClipRelay-"+host.nativeId,pairing.sessionName());
                until(()->host.statusReads.get()>0);
                if(terminalState==null)assertTrue(nativePairing(http).contains("400"));
                else {
                    String expected=terminalState.equals("rejected")?"拒绝":terminalState.equals("expired")?"过期":"结束";
                    try{nativePairing(http);fail("Native refusal lost its terminal reason");}catch(IOException error){assertTrue(error.getMessage(),error.getMessage().contains(expected));}
                    assertNotNull(http.pairingFailure());assertTrue(host.statusReads.get()>=2);
                }
                String line=observed.get(5,TimeUnit.SECONDS);
                assertTrue(line.contains("uniqueid="+host.nativeId));assertTrue(line.contains("cliprelay_pairing="+host.nativeId));
                assertTrue(line.contains("devicename=ClipRelay-"+host.nativeId));
            }finally{http.cancelPairing();http.closeLanPairing();server.close();worker.shutdownNow();assertTrue(worker.awaitTermination(3,TimeUnit.SECONDS));}
        }
    }
    @Test public void closingJoinsAnInFlightNativeFailureConfirmation() throws Exception {
        try(Host host=new Host()){
            host.nativeTicket=true;host.stall=true;
            LanPairing pairing=host.begin(ignored->{});
            ExecutorService worker=Executors.newSingleThreadExecutor();
            java.lang.reflect.Method method=LanPairing.class.getDeclaredMethod("confirmNativeFailure");method.setAccessible(true);
            Future<?> confirmation=worker.submit(()->{try{method.invoke(pairing);}catch(Exception expected){}});
            try{
                until(()->host.statusReads.get()==1);long start=System.nanoTime();pairing.close();
                confirmation.get(1,TimeUnit.SECONDS);assertTrue(System.nanoTime()-start<TimeUnit.SECONDS.toNanos(3));
            }finally{pairing.close();worker.shutdownNow();assertTrue(worker.awaitTermination(3,TimeUnit.SECONDS));}
        }
    }
    @Test public void remoteRejectionCancelsAnActualNativeResponseBodyAndPreservesItsReason() throws Exception {
        try(Host host=new Host();java.net.ServerSocket nativeServer=new java.net.ServerSocket(0,1,java.net.InetAddress.getByName("127.0.0.1"))){
            ExecutorService workers=Executors.newFixedThreadPool(2);CountDownLatch reading=new CountDownLatch(1);
            NvHTTP http=new NvHTTP(new ComputerDetails.AddressTuple("127.0.0.1",nativeServer.getLocalPort()),0,"fixture",null,identity());http.beginPairing();
            Future<?> serving=workers.submit(()->{try(java.net.Socket socket=nativeServer.accept()){
                socket.setSoTimeout(5000);BufferedInputStream input=new BufferedInputStream(socket.getInputStream());
                for(String line=Host.line(input);!line.isEmpty();line=Host.line(input)){}
                socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 999\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));socket.getOutputStream().flush();reading.countDown();
                assertEquals(-1,input.read());
            }catch(Exception error){throw new RuntimeException(error);}});
            try {
                LanPairing pairing=host.begin(http::ownLanPairing);http.setLanPairingSession(pairing);
                Future<String> result=workers.submit(()->{try{return nativePairing(http);}catch(IOException error){return error.getMessage();}});
                assertTrue(reading.await(5,TimeUnit.SECONDS));host.state="rejected";
                assertTrue(result.get(5,TimeUnit.SECONDS).contains("拒绝"));serving.get(5,TimeUnit.SECONDS);assertNotNull(http.pairingFailure());
            }finally{http.cancelPairing();http.closeLanPairing();nativeServer.close();workers.shutdownNow();assertTrue(workers.awaitTermination(3,TimeUnit.SECONDS));}
        }
    }
}
