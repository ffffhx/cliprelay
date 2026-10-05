package com.limelight.ui;

import android.app.Activity;
import android.graphics.Rect;
import android.os.Build;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;

import com.limelight.R;

/** Places desktop controls only in the unused space beside the actual video view. */
final class DesktopSideRails {
    private final Activity activity;
    private final FrameLayout root;
    private final View video;
    private final Runnable changed;
    private final ScrollView left, right;
    private final LinearLayout leftButtons, rightButtons;
    private final Rect leftBounds = new Rect(), rightBounds = new Rect();
    private boolean available;

    DesktopSideRails(Activity activity, FrameLayout root, Runnable changed) {
        this.activity = activity;
        this.root = root;
        this.changed = changed;
        video = root.findViewById(R.id.surfaceView);
        left = rail(R.id.desktopLeftRail);
        right = rail(R.id.desktopRightRail);
        leftButtons = buttons(left);
        rightButtons = buttons(right);
        // Global layout also catches IME/inset changes when the video dimensions stay the same.
        root.getViewTreeObserver().addOnGlobalLayoutListener(this::refresh);
        root.post(this::refresh);
    }

    private int dp(float value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }

    private ScrollView rail(int id) {
        ScrollView rail = new ScrollView(activity);
        rail.setId(id);
        rail.setBackgroundColor(0xFF000000);
        rail.setVerticalScrollBarEnabled(true);
        rail.setScrollbarFadingEnabled(false);
        rail.setClipToPadding(true);
        rail.setPadding(dp(2), dp(4), dp(2), dp(4));
        rail.setVisibility(View.GONE);
        // Consume the gaps between buttons, so scrolling the rail never touches the desktop.
        rail.setClickable(true);
        root.addView(rail, new FrameLayout.LayoutParams(0, 0, Gravity.TOP | Gravity.LEFT));
        return rail;
    }

    private LinearLayout buttons(ScrollView rail) {
        LinearLayout buttons = new LinearLayout(activity);
        buttons.setOrientation(LinearLayout.VERTICAL);
        buttons.setGravity(Gravity.CENTER_HORIZONTAL);
        rail.addView(buttons, new ScrollView.LayoutParams(-1, -2));
        return buttons;
    }

    boolean isAvailable() { return available; }
    LinearLayout leftButtons() { return leftButtons; }
    LinearLayout rightButtons() { return rightButtons; }

    void clear() {
        leftButtons.removeAllViews();
        rightButtons.removeAllViews();
        left.scrollTo(0, 0);
        right.scrollTo(0, 0);
    }

    void setVisible(boolean visible) {
        int visibility = visible && available ? View.VISIBLE : View.GONE;
        left.setVisibility(visibility);
        right.setVisibility(visibility);
    }

    private void refresh() {
        boolean fits = video != null && video.getParent() == root && root.getWidth() > root.getHeight()
                && video.getWidth() > 0 && video.getHeight() > 0;
        if (fits) {
            int[] location = new int[2];
            root.getLocationInWindow(location);
            int windowWidth = root.getRootView().getWidth(), windowHeight = root.getRootView().getHeight();
            int insetLeft = 0, insetRight = 0, insetTop = 0, insetBottom = 0;
            WindowInsets insets = root.getRootWindowInsets();
            if (insets != null) {
                insetLeft = insets.getSystemWindowInsetLeft();
                insetRight = insets.getSystemWindowInsetRight();
                insetTop = insets.getSystemWindowInsetTop();
                insetBottom = insets.getSystemWindowInsetBottom();
                if (Build.VERSION.SDK_INT >= 28 && insets.getDisplayCutout() != null) {
                    insetLeft = Math.max(insetLeft, insets.getDisplayCutout().getSafeInsetLeft());
                    insetRight = Math.max(insetRight, insets.getDisplayCutout().getSafeInsetRight());
                    insetTop = Math.max(insetTop, insets.getDisplayCutout().getSafeInsetTop());
                    insetBottom = Math.max(insetBottom, insets.getDisplayCutout().getSafeInsetBottom());
                }
                if (Build.VERSION.SDK_INT >= 30) insetBottom = Math.max(insetBottom,
                        insets.getInsets(WindowInsets.Type.ime()).bottom);
            }
            // Insets are window coordinates. Do not subtract them twice if the root already fits them.
            int safeLeft = Math.max(root.getPaddingLeft(), insetLeft - location[0]);
            int safeRight = Math.min(root.getWidth() - root.getPaddingRight(), windowWidth - insetRight - location[0]);
            int top = Math.max(root.getPaddingTop(), insetTop - location[1]);
            int bottom = Math.min(root.getHeight() - root.getPaddingBottom(), windowHeight - insetBottom - location[1]);
            DesktopRailGeometry.Layout layout = DesktopRailGeometry.fit(root.getWidth(), root.getHeight(),
                    video.getLeft(), video.getRight(), safeLeft, top, safeRight, bottom,
                    activity.getResources().getDisplayMetrics().density);
            fits = layout != null;
            if (fits) {
                place(left, leftBounds, new Rect(layout.left, layout.top, layout.left + layout.width, layout.top + layout.height));
                place(right, rightBounds, new Rect(layout.right, layout.top, layout.right + layout.width, layout.top + layout.height));
            }
        }
        if (available != fits) {
            available = fits;
            changed.run();
        }
    }

    private void place(View rail, Rect previous, Rect next) {
        if (previous.equals(next)) return;
        previous.set(next);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(next.width(), next.height(), Gravity.TOP | Gravity.LEFT);
        params.leftMargin = next.left - root.getPaddingLeft();
        params.topMargin = next.top - root.getPaddingTop();
        rail.setLayoutParams(params);
    }
}
