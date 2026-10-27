package com.limelight.ui;

import android.app.Activity;
import android.content.SharedPreferences;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.graphics.drawable.StateListDrawable;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.os.Build;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewTreeObserver;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import com.limelight.R;
import java.util.LinkedHashMap;
import java.util.Map;

/** Compact computer keyboard; does not steal the stream's input focus or resize it. */
public final class VirtualKeyboardView extends LinearLayout {
    private final VirtualKeyboardState state;
    private final LinearLayout body;
    private final Map<Button, Integer> keys = new LinkedHashMap<>();
    private final Button page;
    private final LinearLayout header;
    private final TextView hint;
    private final SharedPreferences preferences;
    private final int touchSlop;
    private final ViewTreeObserver.OnGlobalLayoutListener relayout = this::placeInWindow;
    private FrameLayout root;
    private FloatingKeyboardGeometry geometry;
    private final Rect safeArea = new Rect();
    private float fractionX, fractionY, startX, startY, downX, downY;
    private boolean tracking, dragging;
    private boolean functions, available;
    private int rowHeight;
    private int reservedBottom;
    private RepeatingButton backspaceRepeat;

    public VirtualKeyboardView(Activity activity, GameInputState.KeySink sink, Runnable close, Runnable phoneKeyboard) {
        super(activity);
        preferences = activity.getSharedPreferences("cliprelay_desktop_controls", 0);
        fractionX = FloatingKeyboardGeometry.fraction(preferences.getFloat("keyboard_x", 1));
        fractionY = FloatingKeyboardGeometry.fraction(preferences.getFloat("keyboard_y", 1));
        touchSlop = ViewConfiguration.get(activity).getScaledTouchSlop();
        state = new VirtualKeyboardState(sink, release -> {
            // Sunshine delays absolute left-button UP by 10 ms for right-click
            // emulation. Match the mouse adapter's 100 ms settling window so
            // Windows receives mouse UP while the selected modifiers are held.
            // clear()/setAvailable(false) still release immediately on interruption.
            postDelayed(() -> { release.run(); refresh(); }, 100);
        });
        setId(R.id.virtualKeyboardPanel);
        setOrientation(VERTICAL);
        setClickable(true);
        setFocusable(false);
        setPadding(dp(6), dp(4), dp(6), dp(4));
        setBackground(surface(0xFA142033, 16));
        setElevation(dp(10));
        rowHeight = dp(activity.getResources().getConfiguration().screenHeightDp < 500 ? 36 : 42);
        header = row();
        header.getLayoutParams().height = dp(32);
        TextView title = new TextView(activity);
        title.setId(R.id.virtualKeyboardDragHandle);
        title.setText(R.string.virtual_keyboard_drag);
        title.setContentDescription(activity.getString(R.string.virtual_keyboard_drag_description));
        title.setClickable(true);
        title.setOnTouchListener(this::drag);
        title.setPadding(dp(6), 0, dp(4), 0);
        title.setSingleLine(true);
        title.setTextColor(Color.WHITE); title.setTextSize(13);
        title.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(title, new LayoutParams(0, -1, 1));
        page = action(header, activity.getString(R.string.virtual_keyboard_functions), 0);
        page.setId(R.id.virtualKeyboardPage);
        page.setOnClickListener(v -> { functions = !functions; rebuild(); });
        Button ime = action(header, activity.getString(R.string.virtual_keyboard_phone_short), 0);
        ime.setContentDescription(activity.getString(R.string.virtual_keyboard_phone));
        ime.setOnClickListener(v -> phoneKeyboard.run());
        Button hide = action(header, "×", 0);
        hide.setMinWidth(dp(32));
        hide.setContentDescription(activity.getString(R.string.desktop_controls_collapse));
        hide.setId(R.id.virtualKeyboardClose);
        hide.setOnClickListener(v -> close.run());

        hint = new TextView(activity);
        hint.setText(R.string.virtual_keyboard_hint);
        hint.setTextColor(0xFF9EB4CE); hint.setTextSize(10);
        hint.setSingleLine(true);
        addView(hint, new LayoutParams(-1, dp(18)));

        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(false); scroll.setVerticalScrollBarEnabled(false);
        body = new LinearLayout(activity); body.setOrientation(VERTICAL);
        scroll.addView(body);
        addView(scroll, new LayoutParams(-1, 0, 1));

        LinearLayout modifiers = row();
        key(modifiers, "Ctrl", 0x11, 1.3f);
        key(modifiers, "Alt", 0x12, 1.1f);
        key(modifiers, "Shift", 0x10, 1.3f);
        key(modifiers, "Win", 0x5B, 1.1f);
        key(modifiers, "Space", 0x20, 2);
        key(modifiers, "←", 0x25, 1);
        key(modifiers, "↓", 0x28, 1);
        key(modifiers, "↑", 0x26, 1);
        key(modifiers, "→", 0x27, 1);
        rebuild();
    }

    private LinearLayout row() { return row(this); }
    private LinearLayout row(LinearLayout parent) {
        LinearLayout row = new LinearLayout(getContext());
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setOrientation(HORIZONTAL);
        parent.addView(row, new LayoutParams(-1, rowHeight));
        return row;
    }
    private Button action(LinearLayout row, String label, float weight) {
        Button button = new Button(getContext());
        button.setText(label); button.setTextSize(12); button.setTextColor(Color.WHITE);
        button.setAllCaps(false); button.setFocusable(false);
        button.setMinWidth(0); button.setMinimumWidth(0);
        button.setMinHeight(0); button.setMinimumHeight(0);
        button.setPadding(dp(5), 0, dp(5), 0);
        button.setBackgroundTintList(null);
        button.setBackground(keyBackground());
        LayoutParams placement = new LayoutParams(weight == 0 ? -2 : 0, -1, weight);
        placement.setMargins(dp(2), dp(2), dp(2), dp(2));
        row.addView(button, placement);
        return button;
    }
    private void key(LinearLayout row, String label, int code, float weight) {
        Button button = action(row, label, weight);
        button.setTag("vk:" + code);
        button.setContentDescription(label);
        keys.put(button, code);
        button.setOnClickListener(v -> {
            if (!available) return;
            // Respect Android's touch-feedback setting; no vibration permission is needed.
            v.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
            state.press(code);
            refresh();
        });
        if (VirtualKeyboardState.isModifier(code)) {
            button.setOnLongClickListener(v -> { state.pressAlone(code); refresh(); return true; });
        }
        if (code == 0x08) backspaceRepeat = new RepeatingButton(button,
                () -> available && !state.isClickPending(), () -> { state.press(code); refresh(); });
    }
    private void letters(LinearLayout row, String value) {
        for (int i = 0; i < value.length(); i++) key(row, value.substring(i, i + 1), value.charAt(i), 1);
    }
    private void rebuild() {
        if (backspaceRepeat != null) backspaceRepeat.cancel();
        // Retain the always-visible modifier/navigation row across pages.
        keys.entrySet().removeIf(e -> e.getKey().getParent() instanceof View
                && ((View)e.getKey().getParent()).getParent() == body);
        body.removeAllViews();
        page.setText(functions ? R.string.virtual_keyboard_letters_short : R.string.virtual_keyboard_functions_short);
        page.setContentDescription(getContext().getString(functions ? R.string.virtual_keyboard_letters : R.string.virtual_keyboard_functions));
        if (!functions) {
            LinearLayout first = row(body); letters(first, "1234567890"); key(first, "⌫", 0x08, 1.3f);
            LinearLayout second = row(body); key(second, "Tab", 0x09, 1.2f); letters(second, "QWERTYUIOP");
            LinearLayout third = row(body); letters(third, "ASDFGHJKL"); key(third, "Enter", 0x0D, 1.5f);
            LinearLayout fourth = row(body); letters(fourth, "ZXCVBNM");
            key(fourth, ",", 0xBC, 1); key(fourth, ".", 0xBE, 1); key(fourth, "/", 0xBF, 1);
        } else {
            LinearLayout first = row(body);
            for (int i = 0; i < 6; i++) key(first, "F" + (i + 1), 0x70 + i, 1);
            LinearLayout second = row(body);
            for (int i = 6; i < 12; i++) key(second, "F" + (i + 1), 0x70 + i, 1);
            LinearLayout third = row(body);
            String[] names = {"Esc", "Ins", "Del", "Home", "End", "PgUp", "PgDn"};
            int[] codes = {0x1B, 0x2D, 0x2E, 0x24, 0x23, 0x21, 0x22};
            for (int i = 0; i < codes.length; i++) key(third, names[i], codes[i], 1);
            LinearLayout fourth = row(body);
            String[] symbols = {"-", "=", "[", "]", ";", "'", "\\", "`", "Caps"};
            int[] symbolKeys = {0xBD, 0xBB, 0xDB, 0xDD, 0xBA, 0xDE, 0xDC, 0xC0, 0x14};
            for (int i = 0; i < symbols.length; i++) key(fourth, symbols[i], symbolKeys[i], 1);
        }
        refresh();
    }
    public void setAvailable(boolean value) {
        if (!value) { cancelDrag(); if (backspaceRepeat != null) backspaceRepeat.cancel(); }
        available = value; state.setEnabled(value); refresh();
    }
    public void clearModifiers() {
        cancelDrag(); if (backspaceRepeat != null) backspaceRepeat.cancel(); state.clear(); refresh();
    }
    public boolean hasModifiers() { return available && state.hasModifiers(); }
    public void clickWithModifiers(Runnable click) {
        try { state.clickWithModifiers(click); }
        finally { refresh(); }
    }
    private void refresh() {
        for (Map.Entry<Button, Integer> entry : keys.entrySet()) {
            Button button = entry.getKey();
            boolean selected = state.isSelected(entry.getValue());
            button.setSelected(selected);
            button.setEnabled(available && !state.isClickPending());
            button.setAlpha(available ? 1 : .45f);
            // Keep the drawable so a quick tap's ripple survives the input-state refresh.
        }
    }
    private void fitRows(int height) {
        boolean compact = height < dp(224);
        int visibility = compact ? GONE : VISIBLE;
        if (hint.getVisibility() != visibility) hint.setVisibility(visibility);
        int nextHeight = Math.max(dp(28), Math.min(dp(42), (height - dp(compact ? 40 : 58)) / 5));
        if (nextHeight != rowHeight) {
            rowHeight = nextHeight;
            for (int i = 0; i < getChildCount(); i++) {
                View child = getChildAt(i);
                if (child instanceof LinearLayout && child != header) {
                    child.getLayoutParams().height = rowHeight;
                    child.requestLayout();
                }
            }
            for (int i = 0; i < body.getChildCount(); i++) {
                body.getChildAt(i).getLayoutParams().height = rowHeight;
                body.getChildAt(i).requestLayout();
            }
        }
    }

    public void attachTo(FrameLayout parent) {
        root = parent;
        root.addView(this, new FrameLayout.LayoutParams(dp(320), dp(180), Gravity.TOP | Gravity.LEFT));
        root.post(this::placeInWindow);
    }

    void setReservedBottom(int pixels) {
        int next = Math.max(0, pixels);
        if (reservedBottom == next) return;
        reservedBottom = next;
        placeInWindow();
    }

    private void placeInWindow() {
        if (root == null || root.getWidth() == 0 || root.getHeight() == 0) return;
        int[] origin = new int[2];
        root.getLocationInWindow(origin);
        int left = 0, top = 0, right = 0, bottom = 0;
        WindowInsets insets = root.getRootWindowInsets();
        if (insets != null) {
            left = insets.getSystemWindowInsetLeft(); top = insets.getSystemWindowInsetTop();
            right = insets.getSystemWindowInsetRight(); bottom = insets.getSystemWindowInsetBottom();
            if (Build.VERSION.SDK_INT >= 28 && insets.getDisplayCutout() != null) {
                left = Math.max(left, insets.getDisplayCutout().getSafeInsetLeft());
                top = Math.max(top, insets.getDisplayCutout().getSafeInsetTop());
                right = Math.max(right, insets.getDisplayCutout().getSafeInsetRight());
                bottom = Math.max(bottom, insets.getDisplayCutout().getSafeInsetBottom());
            }
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets visible = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                left = visible.left; top = visible.top; right = visible.right; bottom = visible.bottom;
            }
        }
        Rect next = new Rect(Math.max(root.getPaddingLeft(), left - origin[0]),
                Math.max(root.getPaddingTop(), top - origin[1]),
                Math.min(root.getWidth() - root.getPaddingRight(), root.getRootView().getWidth() - right - origin[0]),
                Math.min(root.getHeight() - root.getPaddingBottom(), root.getRootView().getHeight() - bottom - origin[1]));
        next.bottom = Math.min(next.bottom, root.getHeight() - reservedBottom);
        if (!safeArea.equals(next)) cancelDrag();
        safeArea.set(next);
        geometry = FloatingKeyboardGeometry.fit(next.left, next.top, next.right, next.bottom,
                getResources().getDisplayMetrics().density, getResources().getConfiguration().smallestScreenWidthDp >= 600);
        if (geometry == null) return;
        FrameLayout.LayoutParams placement = (FrameLayout.LayoutParams)getLayoutParams();
        if (placement.width != geometry.width || placement.height != geometry.height) {
            placement.width = geometry.width; placement.height = geometry.height;
            setLayoutParams(placement);
        }
        fitRows(geometry.height);
        movePanel();
    }

    private void movePanel() {
        if (geometry == null) return;
        setTranslationX(geometry.x(fractionX) - root.getPaddingLeft());
        setTranslationY(geometry.y(fractionY) - root.getPaddingTop());
    }

    private boolean drag(View handle, MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                if (geometry == null) return true;
                tracking = true; dragging = false;
                startX = fractionX; startY = fractionY;
                downX = event.getRawX(); downY = event.getRawY();
                handle.setPressed(true);
                root.requestDisallowInterceptTouchEvent(true);
                return true;
            case MotionEvent.ACTION_MOVE:
                if (!tracking) return true;
                float dx = event.getRawX() - downX, dy = event.getRawY() - downY;
                if (Math.hypot(dx, dy) > touchSlop) dragging = true;
                if (dragging) {
                    fractionX = geometry.movedX(startX, dx); fractionY = geometry.movedY(startY, dy);
                    movePanel();
                }
                return true;
            case MotionEvent.ACTION_UP:
                if (Build.VERSION.SDK_INT >= 33 && (event.getFlags() & MotionEvent.FLAG_CANCELED) != 0) {
                    cancelDrag(); return true;
                }
                if (tracking && dragging) preferences.edit().putFloat("keyboard_x", fractionX).putFloat("keyboard_y", fractionY).apply();
                else if (tracking) handle.performClick();
                tracking = dragging = false;
                handle.setPressed(false);
                root.requestDisallowInterceptTouchEvent(false);
                return true;
            case MotionEvent.ACTION_POINTER_DOWN:
            case MotionEvent.ACTION_CANCEL:
                cancelDrag(); return true;
            default: return true;
        }
    }

    private void cancelDrag() {
        if (tracking) { fractionX = startX; fractionY = startY; movePanel(); }
        tracking = dragging = false;
        View handle = findViewById(R.id.virtualKeyboardDragHandle);
        if (handle != null) handle.setPressed(false);
        if (root != null) root.requestDisallowInterceptTouchEvent(false);
    }

    @Override protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        if (root != null) root.getViewTreeObserver().addOnGlobalLayoutListener(relayout);
    }
    @Override protected void onDetachedFromWindow() {
        cancelDrag(); state.setEnabled(false);
        if (root != null && root.getViewTreeObserver().isAlive()) root.getViewTreeObserver().removeOnGlobalLayoutListener(relayout);
        super.onDetachedFromWindow();
    }
    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private RippleDrawable keyBackground() {
        StateListDrawable colors = new StateListDrawable();
        colors.addState(new int[]{android.R.attr.state_enabled, android.R.attr.state_pressed}, surface(0xFF4879A8, 6));
        colors.addState(new int[]{android.R.attr.state_selected}, surface(0xFF146FBE, 6));
        colors.addState(new int[]{}, surface(0xFF25374F, 6));
        return new RippleDrawable(ColorStateList.valueOf(0x66BBDDFF), colors, surface(Color.WHITE, 6));
    }
    private GradientDrawable surface(int color, int radius) {
        GradientDrawable drawable = new GradientDrawable(); drawable.setColor(color); drawable.setCornerRadius(dp(radius));
        return drawable;
    }
}
