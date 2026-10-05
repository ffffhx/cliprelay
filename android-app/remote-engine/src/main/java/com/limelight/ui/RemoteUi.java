package com.limelight.ui;

import android.app.Activity;
import android.content.res.Configuration;
import android.os.Build;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;

import com.limelight.R;
import com.limelight.utils.UiHelper;

/** Shared presentation for ClipRelay's connection pages; streaming owns its own window. */
public final class RemoteUi {
    private RemoteUi() {}

    public static void apply(Activity activity) {
        UiHelper.notifyNewRootView(activity);
        activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
        int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
        if (activity.getResources().getBoolean(R.bool.remote_light_system_bars)) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        activity.getWindow().getDecorView().setSystemUiVisibility(flags);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            activity.getWindow().setDecorFitsSystemWindows(false);
        }
        View content = activity.findViewById(android.R.id.content);
        content.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets safe = insets.getInsets(WindowInsets.Type.systemBars() |
                        WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                return WindowInsets.CONSUMED;
            }
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        content.requestApplyInsets();
        View back = activity.findViewById(R.id.remoteBack);
        if (back != null) back.setOnClickListener(v -> activity.finish());
    }

    public static void compactHeader(Activity activity) {
        Configuration config = activity.getResources().getConfiguration();
        boolean compact = config.screenHeightDp < 480;
        View intro = activity.findViewById(R.id.remotePageIntro);
        View hint = activity.findViewById(R.id.remoteHintCard);
        if (intro != null) intro.setVisibility(compact ? View.GONE : View.VISIBLE);
        if (hint != null) hint.setVisibility(compact ? View.GONE : View.VISIBLE);
    }

    public static String computerName(String name) {
        return name != null && name.startsWith("ClipRelay - ") ? name.substring(12) : name;
    }
}
