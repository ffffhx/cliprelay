package com.limelight.preferences;

import android.content.Context;
import android.content.SharedPreferences;
import android.preference.PreferenceManager;
import com.limelight.R;

public enum TouchMode {
    PHONE("phone", R.string.touch_mode_phone),
    DIRECT("direct", R.string.touch_mode_direct),
    TRACKPAD("trackpad", R.string.touch_mode_trackpad);

    public static final String PREF = "cliprelay_touch_mode";
    public final String value;
    public final int label;
    TouchMode(String value, int label) { this.value = value; this.label = label; }

    public static TouchMode read(Context context) {
        SharedPreferences prefs = PreferenceManager.getDefaultSharedPreferences(context);
        String value = prefs.getString(PREF, "");
        for (TouchMode mode : values()) if (mode.value.equals(value)) return mode;
        // Preserve the user's old choice on upgrade, until they select the new mode.
        return prefs.getBoolean("checkbox_touchscreen_trackpad", true) ? TRACKPAD : DIRECT;
    }

    public void save(Context context) {
        PreferenceManager.getDefaultSharedPreferences(context).edit().putString(PREF, value).apply();
    }
}
