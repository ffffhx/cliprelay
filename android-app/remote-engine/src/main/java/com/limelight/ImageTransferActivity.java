package com.limelight;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.limelight.binding.PlatformBinding;
import com.limelight.nvstream.http.ComputerDetails;
import com.limelight.nvstream.http.NvHTTP;
import com.limelight.ui.RemoteImageCodec;
import java.io.ByteArrayInputStream;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Open the photo picker immediately, upload the selected image, then return for one paste. */
public final class ImageTransferActivity extends Activity {
    private static final int PICK_IMAGE = 80;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private RemoteImageCodec.Image selected;
    private ImageView preview;
    private TextView status;
    private Button choose, send, done;
    private boolean busy, pickerOpen, showRecovery;
    private int generation;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL); root.setPadding(dp(20), dp(16), dp(20), dp(16));
        root.setBackgroundColor(0xFF142033);
        TextView title = new TextView(this);
        title.setText(R.string.desktop_image); title.setTextSize(22); title.setTextColor(-1);
        root.addView(title);
        TextView hint = new TextView(this);
        hint.setText(R.string.image_transfer_hint); hint.setTextColor(0xFFBED0E6); hint.setTextSize(14);
        hint.setPadding(0, dp(12), 0, dp(8)); root.addView(hint);
        preview = new ImageView(this);
        preview.setId(R.id.remoteImagePreview);
        preview.setScaleType(ImageView.ScaleType.FIT_CENTER);
        root.addView(preview, new LinearLayout.LayoutParams(-1, 0, 1));
        status = new TextView(this);
        status.setId(R.id.remoteImageStatus);
        status.setText(R.string.image_choose_hint); status.setTextColor(0xFFBED0E6);
        status.setPadding(0, dp(8), 0, dp(8)); root.addView(status);
        LinearLayout buttons = new LinearLayout(this); buttons.setGravity(Gravity.CENTER);
        choose = button(buttons, R.string.image_choose, R.id.remoteImageChoose);
        send = button(buttons, R.string.image_send, R.id.remoteImageSend);
        done = button(buttons, R.string.image_back, R.id.remoteImageBack);
        root.addView(buttons); setContentView(root);
        choose.setOnClickListener(v -> pick());
        send.setOnClickListener(v -> upload());
        done.setOnClickListener(v -> finish());
        update();
        if (saved == null) pick();
        else if (saved.getBoolean("pickerOpen")) pickerOpen = true;
        else {
            // Never repeat a possibly completed upload after process death.
            showRecovery = true;
            status.setText(R.string.image_transfer_interrupted);
            update();
        }
    }
    private Button button(LinearLayout parent, int text, int id) {
        Button b = new Button(this); b.setId(id); b.setText(text); b.setTextSize(13); b.setAllCaps(false);
        parent.addView(b, new LinearLayout.LayoutParams(0, dp(52), 1)); return b;
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private void update() {
        choose.setVisibility(showRecovery ? View.VISIBLE : View.GONE);
        send.setVisibility(showRecovery && selected != null ? View.VISIBLE : View.GONE);
        done.setVisibility(showRecovery ? View.VISIBLE : View.GONE);
        choose.setEnabled(!busy); send.setEnabled(!busy && selected != null); done.setEnabled(!busy);
    }
    private void pick() {
        if (busy || pickerOpen) return;
        Intent intent = Build.VERSION.SDK_INT >= 33 ? new Intent(MediaStore.ACTION_PICK_IMAGES) :
                new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        pickerOpen = true;
        try { startActivityForResult(intent, PICK_IMAGE); }
        catch (android.content.ActivityNotFoundException e) {
            try {
                startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("image/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), PICK_IMAGE);
            } catch (android.content.ActivityNotFoundException missing) {
                pickerOpen = false; showRecovery = true;
                status.setText(R.string.image_picker_missing); update();
            }
        }
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK_IMAGE) return;
        pickerOpen = false;
        if (result != RESULT_OK || data == null || data.getData() == null) { finish(); return; }
        busy = true; showRecovery = false; update(); status.setText(R.string.image_preparing);
        final int token = ++generation;
        worker.execute(() -> {
            RemoteImageCodec.Image image = null;
            try { image = RemoteImageCodec.read(getContentResolver(), data.getData()); }
            catch (Exception | OutOfMemoryError ignored) {}
            RemoteImageCodec.Image prepared = image;
            runOnUiThread(() -> {
                if (isDestroyed() || isFinishing() || token != generation) {
                    if (prepared != null) prepared.preview.recycle(); return;
                }
                busy = false;
                preview.setImageDrawable(null);
                if (selected != null) selected.preview.recycle();
                selected = prepared;
                if (prepared == null) { showRecovery = true; status.setText(R.string.image_invalid); }
                else {
                    preview.setImageBitmap(prepared.preview);
                }
                update();
                if (prepared != null) upload();
            });
        });
    }
    private NvHTTP connection() throws Exception {
        byte[] cert = getIntent().getByteArrayExtra(Game.EXTRA_SERVER_CERT);
        if (cert == null) throw new java.io.IOException("UNPAIRED");
        X509Certificate server = (X509Certificate)CertificateFactory.getInstance("X.509")
                .generateCertificate(new ByteArrayInputStream(cert));
        return new NvHTTP(new ComputerDetails.AddressTuple(getIntent().getStringExtra(Game.EXTRA_HOST),
                getIntent().getIntExtra(Game.EXTRA_PORT, NvHTTP.DEFAULT_HTTP_PORT)),
                getIntent().getIntExtra(Game.EXTRA_HTTPS_PORT, 0), getIntent().getStringExtra(Game.EXTRA_UNIQUEID),
                server, PlatformBinding.getCryptoProvider(this));
    }
    private void upload() {
        if (busy || selected == null) return;
        busy = true; update(); status.setText(R.string.image_sending);
        final byte[] png = selected.png;
        worker.execute(() -> {
            int message = R.string.image_sent;
            try { connection().sendClipboardImage(png); }
            catch (Exception e) { message = "UPDATE_HOST".equals(e.getMessage()) ? R.string.image_update_host : R.string.image_send_failed; }
            int text = message;
            runOnUiThread(() -> {
                if (isDestroyed() || isFinishing()) return;
                busy = false;
                if (text == R.string.image_sent) {
                    setResult(RESULT_OK);
                    finish();
                } else {
                    showRecovery = true; status.setText(text); update();
                }
            });
        });
    }
    @Override public void onBackPressed() { if (!busy) super.onBackPressed(); }
    @Override protected void onSaveInstanceState(Bundle out) {
        out.putBoolean("pickerOpen", pickerOpen);
        super.onSaveInstanceState(out);
    }
    @Override protected void onDestroy() {
        generation++; worker.shutdownNow();
        preview.setImageDrawable(null);
        if (selected != null) { selected.preview.recycle(); selected = null; }
        super.onDestroy();
    }
}
