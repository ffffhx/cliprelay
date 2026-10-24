package com.limelight.ui;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.SystemClock;
import android.view.View;
import android.widget.FrameLayout;
import androidx.core.content.FileProvider;
import androidx.test.platform.app.InstrumentationRegistry;
import com.limelight.R;
import com.limelight.nvstream.ClipboardData;
import com.limelight.nvstream.http.ComputerDetails;
import com.limelight.nvstream.http.LimelightCryptoProvider;
import com.limelight.nvstream.http.NvHTTP;
import com.limelight.preferences.TouchMode;
import org.json.JSONObject;
import org.junit.*;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.Assert.*;
import static androidx.test.espresso.Espresso.onData;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.Espresso.pressBack;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.matcher.RootMatchers.isDialog;
import static androidx.test.espresso.matcher.RootMatchers.isPlatformPopup;
import static androidx.test.espresso.matcher.ViewMatchers.*;

/** Real local clipboard and toolbar, recorded host writes/keys; never contacts a computer. */
public class ClipboardPasteUiTest {
    private final android.app.Instrumentation instrument=InstrumentationRegistry.getInstrumentation();
    private Activity activity;
    private ClipboardManager clipboard;
    private ClipData saved;
    private RemoteClipboard remote;
    private ExecutorService worker;
    private RecordingHttp http;
    private FrameLayout root;
    private final List<String> keys=new ArrayList<>();
    private final List<File> files=new ArrayList<>();
    private static final List<String> PASTE=Arrays.asList("17:true","86:true","86:false","17:false");

    private static final class RecordingHttp extends NvHTTP {
        final BlockingQueue<JSONObject> writes=new LinkedBlockingQueue<>();
        final Semaphore reply=new Semaphore(0);
        volatile boolean fail;
        RecordingHttp() throws IOException {
            super(new ComputerDetails.AddressTuple("127.0.0.1",1),0,"",null,new LimelightCryptoProvider(){
                public java.security.cert.X509Certificate getClientCertificate(){return null;}
                public java.security.PrivateKey getClientPrivateKey(){return null;}
                public byte[] getPemEncodedClientCertificate(){return new byte[0];}
                public String encodeBase64String(byte[] bytes){return Base64.getEncoder().encodeToString(bytes);}
            });
        }
        @Override public JSONObject clipboardRequest(JSONObject payload) throws IOException {
            writes.add(payload);
            try {
                if(!reply.tryAcquire(10,TimeUnit.SECONDS))throw new IOException("Test reply timed out");
                if(fail)throw new IOException("CLIPBOARD_UNAVAILABLE");
                return new JSONObject().put("ok",true);
            } catch(InterruptedException e) { Thread.currentThread().interrupt();throw new IOException(e); }
            catch(org.json.JSONException e) { throw new IOException(e); }
        }
        // Intentionally allow a late acknowledgement to exercise the cancellation guard.
        @Override public void cancelClipboardRequests() {}
    }
    private void ui(Runnable task) { instrument.runOnMainSync(task);instrument.waitForIdleSync(); }
    @Before public void setup() throws Exception {
        http=new RecordingHttp();
        activity=instrument.startActivitySync(new Intent().setClassName(instrument.getTargetContext().getPackageName(),
                "com.limelight.PcView").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        long deadline=SystemClock.uptimeMillis()+5000;
        while(!activity.hasWindowFocus() && SystemClock.uptimeMillis()<deadline)SystemClock.sleep(50);
        ui(()->{
            clipboard=activity.getSystemService(ClipboardManager.class);saved=clipboard.getPrimaryClip();
            root=new FrameLayout(activity);
            View video=new View(activity);video.setId(R.id.surfaceView);root.addView(video,new FrameLayout.LayoutParams(-1,-1));
            activity.setContentView(root);
            remote=new RemoteClipboard(activity,http);remote.setActive(true);
            DesktopToolbar.Controller toolbar=DesktopToolbar.attachWithSink(activity,root,new DesktopInput.Sink(){
                public void send(int key,boolean down,int modifiers){keys.add(key+":"+down);}
                public void text(String value){}
                public void rightClick(){}
                public void scroll(byte count){}
            },new DesktopToolbar.Actions(){
                public void keyboard(){}
                public TouchMode touchMode(){return TouchMode.PHONE;}
                public void selectTouchMode(TouchMode mode){}
                public void disconnect(){}
                public void gameModeChanged(boolean enabled){}
                public void pasteLocal(Runnable paste){remote.pasteFromDevice(paste);}
            });
            toolbar.setConnected(true);toolbar.setFocused(true);toolbar.setExpanded(true);
        });
        // Drain the actual worker, then the main looper, instead of racing a late reply with a sleep.
        java.lang.reflect.Field field=RemoteClipboard.class.getDeclaredField("worker");field.setAccessible(true);
        worker=(ExecutorService)field.get(remote);
    }
    @After public void cleanup() {
        if(activity!=null)ui(()->{
            if(remote!=null)remote.close();
            if(clipboard!=null){
                if(saved!=null)clipboard.setPrimaryClip(saved);
                else if(android.os.Build.VERSION.SDK_INT>=28)clipboard.clearPrimaryClip();
                else clipboard.setPrimaryClip(ClipData.newPlainText("",""));
            }
            activity.finish();
        });
        for(File file:files)file.delete();
    }
    private void select(int label) {
        ui(()->root.findViewById(R.id.desktopMoreButton).performClick());
        onData(org.hamcrest.Matchers.equalTo(activity.getString(label))).inRoot(isDialog()).perform(click());
    }
    private JSONObject request() throws Exception {
        JSONObject value=http.writes.poll(5,TimeUnit.SECONDS);assertNotNull("No clipboard write",value);
        assertEquals("write",value.getString("op"));assertTrue(keys.isEmpty());return value;
    }
    private void drain() throws Exception { worker.submit(()->{}).get(5,TimeUnit.SECONDS);instrument.waitForIdleSync(); }
    private void acknowledge() throws Exception { http.reply.release();drain(); }
    private ClipData image() throws Exception {
        File directory=new File(activity.getCacheDir(),"clipboard_images");directory.mkdirs();
        File file=File.createTempFile("paste-test-",".png",directory);files.add(file);
        Bitmap bitmap=Bitmap.createBitmap(2,3,Bitmap.Config.ARGB_8888);
        try(FileOutputStream out=new FileOutputStream(file)){bitmap.compress(Bitmap.CompressFormat.PNG,100,out);}
        finally{bitmap.recycle();}
        Uri uri=FileProvider.getUriForFile(activity,activity.getPackageName()+".fileprovider",file);
        return ClipData.newUri(activity.getContentResolver(),"test image",uri);
    }

    @Test public void computerPasteDoesNotReadOrSendThePhoneClip() {
        ui(()->clipboard.setPrimaryClip(ClipData.newPlainText("test","https://example.com/phone")));
        select(R.string.desktop_paste);
        assertEquals(PASTE,keys);assertTrue(http.writes.isEmpty());
    }
    @Test public void latestLinkReplacesOldImageAndPastesOnlyAfterAcknowledgement() throws Exception {
        ClipData previous=image();String link="https://example.com/latest?text=中文";
        ui(()->{clipboard.setPrimaryClip(previous);clipboard.setPrimaryClip(ClipData.newPlainText("test",link));});
        select(R.string.desktop_paste_local);
        JSONObject value=request();assertEquals("text",value.getString("kind"));assertEquals(link,value.getString("text"));
        // Changes after the click must not replace the captured content or trigger a second request.
        ui(()->{clipboard.setPrimaryClip(ClipData.newPlainText("test","later"));remote.pasteFromDevice(()->fail("Duplicate paste"));});
        acknowledge();assertEquals(PASTE,keys);assertTrue(http.writes.isEmpty());
    }
    @Test public void localImageIsUploadedBeforePasting() throws Exception {
        ClipData clip=image();ui(()->clipboard.setPrimaryClip(clip));select(R.string.desktop_paste_local);
        JSONObject value=request();assertEquals("png",value.getString("kind"));
        assertNotNull(ClipboardData.parse(new JSONObject(value.toString()).put("ok",true)).png);
        acknowledge();assertEquals(PASTE,keys);
    }
    @Test public void failedTransferNeverPastesOldHostContentsAndRetryReadsCurrentLink() throws Exception {
        ui(()->clipboard.setPrimaryClip(ClipData.newPlainText("test","first")));select(R.string.desktop_paste_local);
        request();http.fail=true;acknowledge();assertTrue(keys.isEmpty());http.fail=false;
        ui(()->clipboard.setPrimaryClip(ClipData.newRawUri("test",Uri.parse("https://example.com/retry"))));
        select(R.string.desktop_paste_local);assertEquals("https://example.com/retry",request().getString("text"));
        acknowledge();assertEquals(PASTE,keys);
    }
    @Test public void cancelDiscardsLateAcknowledgement() throws Exception {
        ui(()->clipboard.setPrimaryClip(ClipData.newPlainText("test","cancelled")));select(R.string.desktop_paste_local);
        request();ui(remote::cancel);acknowledge();assertTrue(keys.isEmpty());
    }
    @Test public void disconnectDiscardsLateAcknowledgementEvenAfterReactivation() throws Exception {
        ui(()->clipboard.setPrimaryClip(ClipData.newPlainText("test","disconnected")));select(R.string.desktop_paste_local);
        request();ui(()->{remote.setActive(false);remote.setActive(true);});acknowledge();assertTrue(keys.isEmpty());
    }
    @Test public void emptyLocalClipNeverFallsBackToComputerPaste() throws Exception {
        ui(()->clipboard.setPrimaryClip(ClipData.newPlainText("test","")));select(R.string.desktop_paste_local);
        drain();assertTrue(http.writes.isEmpty());assertTrue(keys.isEmpty());
    }
    @Test public void labelsIdentifyTheSourceOnPhonesAndTablets() {
        for(int width:new int[]{360,600}){
            Configuration config=new Configuration(activity.getResources().getConfiguration());
            config.setLocale(Locale.SIMPLIFIED_CHINESE);config.smallestScreenWidthDp=width;
            android.content.Context context=activity.createConfigurationContext(config);
            assertEquals("粘贴：电脑",context.getString(R.string.desktop_paste));
            assertEquals(width==600?"粘贴：平板":"粘贴：手机",context.getString(R.string.desktop_paste_local));
        }
    }
    @Test public void tabletMoreMenuIncludesBothPasteSourcesWithoutIconIndexMismatch() {
        ui(()->{
            int margin=Math.round(120*activity.getResources().getDisplayMetrics().density);
            root.findViewById(R.id.surfaceView).setLayoutParams(new FrameLayout.LayoutParams(-1,
                    root.getHeight()-margin,android.view.Gravity.TOP));
        });
        ui(()->root.findViewById(R.id.desktopMoreButton).performClick());
        onView(withText(R.string.desktop_paste)).inRoot(isPlatformPopup()).check(matches(isDisplayed()));
        onView(withText(R.string.desktop_paste_local)).inRoot(isPlatformPopup()).check(matches(isDisplayed()));
        assertTrue(keys.isEmpty());assertTrue(http.writes.isEmpty());pressBack();
    }
}
