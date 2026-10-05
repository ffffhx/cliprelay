package com.limelight.ui;

import android.app.Activity;
import android.app.AlertDialog;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

/** Licenses stay available offline inside the combined ClipRelay APK. */
public final class OpenSourceNotice {
    private OpenSourceNotice() {}
    public static void show(Activity activity) {
        StringBuilder text = new StringBuilder("ClipRelay source: https://github.com/ffffhx/cliprelay\n\n");
        for (String file : new String[]{"NOTICE.txt", "upstream.json", "COPYING.txt", "ENet.txt", "nanors.txt", "Opus.txt", "OpenSSL.txt", "NETWORK-LICENSES.txt"}) {
            text.append("\n\n").append(file).append("\n\n");
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                    activity.getAssets().open("cliprelay-remote/" + file), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) text.append(line).append('\n');
            } catch (java.io.IOException error) {
                text.append("Source and license notices: https://github.com/ffffhx/cliprelay\n");
            }
        }
        new AlertDialog.Builder(activity).setTitle("远控开源组件许可")
                .setMessage(text).setPositiveButton(android.R.string.ok, null).show();
    }
}
