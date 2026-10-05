package com.limelight.ui;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.widget.ScrollView;
import android.widget.TextView;
import com.limelight.R;
import com.limelight.binding.video.StreamStatistics;
import java.util.function.Supplier;

/** On-demand information; no permanent overlay on the remote desktop. */
public final class StreamInfoDialog {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private AlertDialog dialog;

    public void show(Activity activity, Supplier<StreamStatistics> samples, Supplier<String> targets) {
        dismiss();
        TextView text = new TextView(activity);
        text.setId(R.id.streamInfoText);
        text.setTextSize(15);
        int padding = Math.round(20 * activity.getResources().getDisplayMetrics().density);
        text.setPadding(padding, padding / 2, padding, padding);
        text.setLineSpacing(5 * activity.getResources().getDisplayMetrics().density, 1);
        ScrollView scroll = new ScrollView(activity);
        scroll.addView(text);
        AlertDialog shown = new AlertDialog.Builder(activity).setTitle(R.string.stream_info_title)
                .setView(scroll).setPositiveButton(R.string.stream_info_close, null).create();
        dialog = shown;
        shown.setOnDismissListener(ignored -> {
            // Dismiss callbacks are queued; an old dialog must not stop a newer one.
            if (dialog != shown) return;
            handler.removeCallbacksAndMessages(null);
            dialog = null;
        });
        shown.show();
        handler.post(new Runnable() {
            @Override public void run() {
                if (dialog != shown || !shown.isShowing()) return;
                StreamStatistics sample = samples.get();
                String measured = activity.getString(R.string.stream_info_waiting);
                if (sample != null && sample.isFresh(SystemClock.uptimeMillis())) {
                    measured = activity.getString(R.string.stream_info_measured,
                            sample.width, sample.height, sample.codec, sample.videoMbps,
                            sample.receivedFps, sample.renderedFps, sample.lossPercent);
                    measured += "\n" + (sample.rttMs > 0 ?
                            activity.getString(R.string.stream_info_rtt, sample.rttMs) :
                            activity.getString(R.string.stream_info_rtt_unknown));
                }
                text.setText(measured + "\n\n" + targets.get() + "\n\n" +
                        activity.getString(R.string.stream_info_note));
                handler.postDelayed(this, 1000);
            }
        });
    }

    public void dismiss() {
        handler.removeCallbacksAndMessages(null);
        if (dialog != null) dialog.dismiss();
        dialog = null;
    }
}
