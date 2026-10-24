package com.limelight.ui;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.CancellationSignal;
import android.content.res.AssetFileDescriptor;
import android.widget.Toast;
import androidx.core.content.FileProvider;
import com.limelight.R;
import com.limelight.nvstream.ClipboardData;
import com.limelight.nvstream.http.NvHTTP;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.IOException;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;

/** Explicit user actions only; no clipboard listener or background clipboard reads. */
public final class RemoteClipboard implements AutoCloseable {
    private final Activity activity;
    private final NvHTTP http;
    private final Handler main=new Handler(Looper.getMainLooper());
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private boolean active,busy;
    private volatile boolean closed;
    private volatile int token;
    private volatile InputStream source;
    private volatile CancellationSignal opening;
    private AlertDialog dialog;
    private final Runnable timeout=()->{ if(busy)toast(R.string.clipboard_failed); cancel(); };
    public RemoteClipboard(Activity activity,NvHTTP http) { this.activity=activity; this.http=http; }
    private boolean usable() { return active && !closed && !activity.isFinishing() && !activity.isDestroyed(); }
    public void setActive(boolean value) { active=value; if (!value) cancel(); }
    public void show() {
        if (!usable() || busy) return;
        dismiss();
        dialog=new AlertDialog.Builder(activity).setTitle(R.string.clipboard_title)
                .setItems(new String[]{activity.getString(R.string.clipboard_send),activity.getString(R.string.clipboard_receive)},
                        (d,which)->start(which==0,null)).setNegativeButton(android.R.string.cancel,null).show();
    }
    /** Capture the current local clip now; paste only after the host acknowledges the write. */
    public void pasteFromDevice(Runnable paste) { start(true,java.util.Objects.requireNonNull(paste)); }
    private void start(boolean send,Runnable paste) {
        if (!usable() || busy) return;
        ClipboardManager manager=activity.getSystemService(ClipboardManager.class);
        String text=null; Uri uri=null;
        if (send) {
            try {
                ClipData current=manager.getPrimaryClip();
                if (current==null || current.getItemCount()!=1) { toast(R.string.clipboard_empty); return; }
                ClipData.Item item=current.getItemAt(0);
                if (item.getText()!=null) text=item.getText().toString();
                else uri=item.getUri();
                if (text==null && uri!=null && ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()))) {
                    text=uri.toString(); uri=null;
                }
                if (text==null && (uri==null || !"content".equals(uri.getScheme()))) { toast(R.string.clipboard_empty); return; }
            } catch (RuntimeException error) { toast(R.string.clipboard_failed); return; }
        }
        final String captured=text; final Uri image=uri;
        int request=++token; busy=true; dismiss();
        dialog=new AlertDialog.Builder(activity).setTitle(paste!=null?R.string.desktop_paste_local:R.string.clipboard_title)
                .setMessage(paste!=null?R.string.clipboard_paste_working:R.string.clipboard_working).setCancelable(false)
                .setNegativeButton(android.R.string.cancel,(d,w)->cancel()).show();
        main.postDelayed(timeout,45000);
        worker.execute(()->{
            File prepared=null;
            try {
                ClipboardData received=null;
                if (send) {
                    ClipboardData value=captured!=null?ClipboardData.text(captured):loadImage(image,request);
                    if (closed || token!=request) return;
                    http.clipboardRequest(value.request(UUID.randomUUID().toString().replace("-","")));
                } else {
                    received=ClipboardData.parse(http.clipboardRequest(new JSONObject().put("op","read")));
                    if (received.png!=null) {
                        // Decode before publishing an image URI; a header alone is insufficient.
                        Bitmap bitmap=BitmapFactory.decodeByteArray(received.png,0,received.png.length);
                        if (bitmap==null) throw new IOException("CLIPBOARD_INVALID_RESPONSE");
                        bitmap.recycle();
                        File directory=new File(activity.getCacheDir(),"clipboard_images");
                        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Clipboard cache unavailable");
                        prepared=new File(directory,"paired-"+UUID.randomUUID()+".png");
                        try (FileOutputStream out=new FileOutputStream(prepared)) { out.write(received.png); }
                    }
                }
                final ClipboardData result=received; final File file=prepared;
                if (closed || token!=request) { if (file!=null) file.delete(); return; }
                main.post(()->{
                    if (!usable() || token!=request) { if(file!=null)file.delete(); return; }
                    try {
                        if (!send) {
                            if (file==null) manager.setPrimaryClip(ClipData.newPlainText("ClipRelay",result.text));
                            else {
                                Uri shared=FileProvider.getUriForFile(activity,activity.getPackageName()+".fileprovider",file);
                                manager.setPrimaryClip(ClipData.newUri(activity.getContentResolver(),"ClipRelay",shared));
                                File[] old=file.getParentFile().listFiles((dir,name)->name.startsWith("paired-") && name.endsWith(".png"));
                                if (old!=null) for(File prior:old) if(!prior.equals(file)) prior.delete();
                            }
                        }
                        // Never fall back to Ctrl+V on failure: the host may still hold an old image.
                        // The token/usable checks above also discard late replies after cancellation.
                        if (paste!=null) {
                            finish();
                            paste.run();
                            return;
                        }
                        toast(send?R.string.clipboard_sent:R.string.clipboard_received);
                    } catch (RuntimeException error) { if(file!=null)file.delete(); toast(R.string.clipboard_failed); }
                    finish();
                });
            } catch (Exception error) {
                if(prepared!=null)prepared.delete();
                final String code=error.getMessage();
                main.post(()->{
                    if (!usable() || token!=request) return;
                    finish(); toast("UPDATE_HOST".equals(code)?R.string.clipboard_update_host:
                            "CLIPBOARD_EMPTY".equals(code)?R.string.clipboard_empty:
                            "CLIPBOARD_LOCKED".equals(code)?R.string.clipboard_locked:R.string.clipboard_failed);
                });
            }
        });
    }
    private ClipboardData loadImage(Uri uri,int request) throws Exception {
        byte[] bytes;
        CancellationSignal signal=new CancellationSignal(); opening=signal;
        if(closed || token!=request)signal.cancel();
        try (AssetFileDescriptor descriptor=activity.getContentResolver().openAssetFileDescriptor(uri,"r",signal);
             InputStream input=descriptor==null?null:descriptor.createInputStream(); ByteArrayOutputStream out=new ByteArrayOutputStream()) {
            if(input==null)throw new IOException("Image unavailable");
            source=input;
            if(closed || token!=request)throw new IOException("Cancelled");
            byte[] buffer=new byte[32768]; int size;
            while((size=input.read(buffer))!=-1) {
                if(closed || token!=request)throw new IOException("Cancelled");
                if(out.size()+size>ClipboardData.IMAGE_LIMIT)throw new IOException("Image too large");
                out.write(buffer,0,size);
            }
            bytes=out.toByteArray();
        } finally { source=null; opening=null; }
        BitmapFactory.Options bounds=new BitmapFactory.Options(); bounds.inJustDecodeBounds=true;
        BitmapFactory.decodeByteArray(bytes,0,bytes.length,bounds);
        if(bounds.outWidth<=0 || bounds.outHeight<=0 || bounds.outWidth>4096 || bounds.outHeight>4096 ||
                (long)bounds.outWidth*bounds.outHeight>6000000)throw new IOException("Image too large");
        Bitmap bitmap=BitmapFactory.decodeByteArray(bytes,0,bytes.length);
        if(bitmap==null)throw new IOException("Invalid image");
        try (ByteArrayOutputStream png=new ByteArrayOutputStream()) {
            if(!bitmap.compress(Bitmap.CompressFormat.PNG,100,png))throw new IOException("Image conversion failed");
            return ClipboardData.png(png.toByteArray());
        } finally { bitmap.recycle(); }
    }
    private void toast(int id) { if(usable())Toast.makeText(activity,id,Toast.LENGTH_LONG).show(); }
    private void dismiss() { if(dialog!=null){dialog.dismiss();dialog=null;} }
    private void finish() { busy=false; main.removeCallbacks(timeout); dismiss(); }
    public void cancel() {
        token++; http.cancelClipboardRequests();
        CancellationSignal signal=opening; if(signal!=null)signal.cancel();
        InputStream input=source; if(input!=null)try{input.close();}catch(IOException ignored){}
        finish();
    }
    @Override public void close() { closed=true; cancel(); worker.shutdownNow(); }
}
