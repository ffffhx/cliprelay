package com.limelight.files;

import android.app.*;
import android.content.*;
import android.os.SystemClock;
import android.view.*;
import android.widget.*;
import androidx.test.platform.app.InstrumentationRegistry;
import com.limelight.Game;
import com.limelight.R;
import com.limelight.binding.crypto.AndroidCryptoProvider;
import org.json.JSONObject;
import org.junit.Test;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.X509Certificate;
import java.util.*;
import javax.net.ssl.*;
import static org.junit.Assert.*;

/** UI test talks only to an ephemeral TLS server inside the emulator. No paired PC is contacted. */
public class FileTransferUiTest {
    private static final class Host implements AutoCloseable {
        final String alias="cliprelay-file-ui-test-"+UUID.randomUUID();final File fixture;
        final SSLServerSocket server;final Thread thread;final X509Certificate certificate;volatile boolean closed;volatile Exception failure;
        Host()throws Exception{
            Context target=InstrumentationRegistry.getInstrumentation().getTargetContext();
            fixture=new File(target.getCacheDir(),alias);assertTrue(fixture.mkdirs());
            // The fixture needs a normal TLS server key, not a hardware key whose
            // raw RSA operations vary by device. Never read the user's identity files.
            AndroidCryptoProvider crypto=new AndroidCryptoProvider(new ContextWrapper(target){@Override public File getFilesDir(){return fixture;}});
            certificate=crypto.getClientCertificate();PrivateKey privateKey=crypto.getClientPrivateKey();
            X509KeyManager keys=new X509KeyManager(){
                public String chooseClientAlias(String[] types,Principal[] issuers,Socket socket){return alias;}
                public String chooseServerAlias(String type,Principal[] issuers,Socket socket){return type.equals("RSA")?alias:null;}
                public String[] getClientAliases(String type,Principal[] issuers){return new String[]{alias};}
                public String[] getServerAliases(String type,Principal[] issuers){return new String[]{alias};}
                public X509Certificate[] getCertificateChain(String key){return new X509Certificate[]{certificate};}
                public PrivateKey getPrivateKey(String key){return privateKey;}
            };
            // Trust is relaxed only by the isolated test server. The production
            // Android client still enforces its pinned host and sends its client certificate.
            X509TrustManager trust=new X509TrustManager(){public X509Certificate[] getAcceptedIssuers(){return new X509Certificate[0];}public void checkClientTrusted(X509Certificate[] chain,String type){}public void checkServerTrusted(X509Certificate[] chain,String type){}};
            SSLContext tls=SSLContext.getInstance("TLSv1.2");tls.init(new KeyManager[]{keys},new TrustManager[]{trust},new SecureRandom());
            server=(SSLServerSocket)tls.getServerSocketFactory().createServerSocket(0,8,InetAddress.getByName("127.0.0.1"));server.setNeedClientAuth(true);server.setEnabledProtocols(new String[]{"TLSv1.2"});
            thread=new Thread(()->{while(!closed)try(SSLSocket socket=(SSLSocket)server.accept()){
                socket.setSoTimeout(5000);InputStream input=socket.getInputStream();String line=line(input);int length=0;
                if(!line.startsWith("POST /v1/files "))continue;
                while(!(line=line(input)).isEmpty())if(line.toLowerCase(Locale.ROOT).startsWith("content-length:"))length=Integer.parseInt(line.substring(15).trim());
                if(length<0||length>400*1024)continue;byte[] body=new byte[length];int count=0,read;while(count<body.length&&(read=input.read(body,count,body.length-count))>0)count+=read;
                JSONObject request=new JSONObject(new String(body,StandardCharsets.UTF_8));String response=request.optString("op").equals("roots")?
                        "{\"ok\":true,\"roots\":[{\"id\":\"downloads\",\"name\":\"downloads\",\"writable\":true}]}":
                        "{\"ok\":true,\"entries\":[{\"name\":\"alpha.txt\",\"directory\":false,\"size\":12},{\"name\":\"beta.bin\",\"directory\":false,\"size\":32}],\"next\":\"\"}";
                byte[] bytes=response.getBytes(StandardCharsets.UTF_8);OutputStream output=socket.getOutputStream();output.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "+bytes.length+"\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));output.write(bytes);output.flush();
            }catch(Exception error){if(!closed)failure=error;}} ,"isolated file UI server");thread.start();
        }
        static String line(InputStream input)throws IOException{ByteArrayOutputStream bytes=new ByteArrayOutputStream();int ch;while((ch=input.read())!=-1&&ch!='\n'){if(bytes.size()>4096)throw new IOException();if(ch!='\r')bytes.write(ch);}if(ch==-1)throw new EOFException();return bytes.toString("US-ASCII");}
        public void close()throws Exception{
            closed=true;server.close();thread.join(6000);assertFalse(thread.isAlive());
            for(String name:new String[]{"client.crt","client.key"}){File file=new File(fixture,name);if(file.exists())assertTrue(file.delete());}
            assertTrue(fixture.delete());
        }
    }
    private static View find(View view,String text){
        if(view instanceof TextView&&((TextView)view).getText().toString().equals(text))return view;
        if(view instanceof ViewGroup)for(int n=0;n<((ViewGroup)view).getChildCount();n++){View found=find(((ViewGroup)view).getChildAt(n),text);if(found!=null)return found;}return null;
    }
    private static void describe(View view,StringBuilder result){
        if(view instanceof TextView)result.append(((TextView)view).getText()).append(" | ");
        if(view instanceof ViewGroup)for(int n=0;n<((ViewGroup)view).getChildCount();n++)describe(((ViewGroup)view).getChildAt(n),result);
    }
    private void await(Instrumentation instrument,Activity screen,Host host,String text)throws Exception{
        long end=SystemClock.uptimeMillis()+15000;boolean[] found={false};while(SystemClock.uptimeMillis()<end){instrument.runOnMainSync(()->found[0]=find(screen.getWindow().getDecorView(),text)!=null);if(found[0])return;SystemClock.sleep(100);}
        StringBuilder shown=new StringBuilder();instrument.runOnMainSync(()->describe(screen.getWindow().getDecorView(),shown));
        throw new AssertionError("Missing UI text: "+text+"; screen: "+shown,host.failure);
    }
    @Test public void pairedBrowserSupportsMultipleSelectionAndBothSystemPickers()throws Exception{
        Instrumentation instrument=InstrumentationRegistry.getInstrumentation();Context context=instrument.getTargetContext();
        try(Host host=new Host()){
            Intent intent=new Intent(context,FileTransferActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra(Game.EXTRA_HOST,"127.0.0.1").putExtra(Game.EXTRA_PORT,host.server.getLocalPort()-2)
                    .putExtra(Game.EXTRA_PC_UUID,"isolated-ui-fixture").putExtra(Game.EXTRA_PC_NAME,"Test computer")
                    .putExtra(Game.EXTRA_UNIQUEID,"fixture").putExtra(Game.EXTRA_SERVER_CERT,host.certificate.getEncoded());
            Activity screen=instrument.startActivitySync(intent);
            IntentFilter uploadFilter=new IntentFilter(Intent.ACTION_OPEN_DOCUMENT);uploadFilter.addCategory(Intent.CATEGORY_OPENABLE);uploadFilter.addDataType("*/*");
            Instrumentation.ActivityMonitor upload=instrument.addMonitor(uploadFilter,new Instrumentation.ActivityResult(Activity.RESULT_CANCELED,null),true);
            Instrumentation.ActivityMonitor download=instrument.addMonitor(new IntentFilter(Intent.ACTION_OPEN_DOCUMENT_TREE),new Instrumentation.ActivityResult(Activity.RESULT_CANCELED,null),true);
            try{
                await(instrument,screen,host,context.getString(R.string.files_downloads));instrument.runOnMainSync(()->find(screen.getWindow().getDecorView(),context.getString(R.string.files_downloads)).performClick());
                await(instrument,screen,host,"alpha.txt  ·  12 B");
                instrument.runOnMainSync(()->{
                    View page=screen.getWindow().getDecorView();Button receive=(Button)find(page,context.getString(R.string.files_download));assertFalse(receive.isEnabled());
                    find(page,"alpha.txt  ·  12 B").performClick();find(page,"beta.bin  ·  32 B").performClick();assertTrue(receive.isEnabled());receive.performClick();
                });
                instrument.waitForIdleSync();assertEquals(1,download.getHits());assertFalse(screen.isFinishing());
                instrument.runOnMainSync(()->find(screen.getWindow().getDecorView(),context.getString(R.string.files_upload)).performClick());
                instrument.waitForIdleSync();assertEquals(1,upload.getHits());assertFalse(screen.isFinishing());
            }finally{instrument.removeMonitor(upload);instrument.removeMonitor(download);instrument.runOnMainSync(screen::finish);}
        }
    }
}
