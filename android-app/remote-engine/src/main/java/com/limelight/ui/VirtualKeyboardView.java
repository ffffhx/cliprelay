package com.limelight.ui;

import android.app.Activity;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.graphics.drawable.StateListDrawable;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.widget.Button;
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
    private boolean functions, available;
    private int rowHeight;

    public VirtualKeyboardView(Activity activity, GameInputState.KeySink sink, Runnable close, Runnable phoneKeyboard) {
        super(activity);
        state = new VirtualKeyboardState(sink);
        setId(R.id.virtualKeyboardPanel);
        setOrientation(VERTICAL);
        setClickable(true);
        setFocusable(false);
        setPadding(dp(6), dp(4), dp(6), dp(4));
        setBackground(surface(0xFA142033, 16));
        setElevation(dp(10));
        rowHeight = dp(activity.getResources().getConfiguration().screenHeightDp < 500 ? 36 : 42);
        LinearLayout header = row();
        TextView title = new TextView(activity);
        title.setText(R.string.virtual_keyboard);
        title.setTextColor(Color.WHITE); title.setTextSize(13);
        title.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(title, new LayoutParams(0, -1, 1));
        page = action(header, activity.getString(R.string.virtual_keyboard_functions), 0);
        page.setId(R.id.virtualKeyboardPage);
        page.setOnClickListener(v -> { functions = !functions; rebuild(); });
        Button ime = action(header, activity.getString(R.string.virtual_keyboard_phone), 0);
        ime.setOnClickListener(v -> phoneKeyboard.run());
        Button hide = action(header, activity.getString(R.string.desktop_controls_collapse), 0);
        hide.setId(R.id.virtualKeyboardClose);
        hide.setOnClickListener(v -> close.run());

        TextView hint = new TextView(activity);
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
    }
    private void letters(LinearLayout row, String value) {
        for (int i = 0; i < value.length(); i++) key(row, value.substring(i, i + 1), value.charAt(i), 1);
    }
    private void rebuild() {
        // Retain the always-visible modifier/navigation row across pages.
        keys.entrySet().removeIf(e -> e.getKey().getParent() instanceof View
                && ((View)e.getKey().getParent()).getParent() == body);
        body.removeAllViews();
        page.setText(functions ? R.string.virtual_keyboard_letters : R.string.virtual_keyboard_functions);
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
    public void setAvailable(boolean value) { available = value; state.setEnabled(value); refresh(); }
    public void clearModifiers() { state.clear(); refresh(); }
    private void refresh() {
        for (Map.Entry<Button, Integer> entry : keys.entrySet()) {
            Button button = entry.getKey();
            boolean selected = state.isSelected(entry.getValue());
            button.setSelected(selected);
            button.setEnabled(available);
            button.setAlpha(available ? 1 : .45f);
            // Keep the drawable so a quick tap's ripple survives the input-state refresh.
        }
    }
    public int preferredHeight(int availableHeight) {
        boolean compact = availableHeight / getResources().getDisplayMetrics().density < 500;
        int height = Math.min(dp(compact ? 242 : 282), Math.round(availableHeight * .62f));
        height = Math.min(availableHeight, Math.max(dp(194), height));
        // Header + four key rows + modifiers should all fit on a landscape phone.
        // Retain scrolling only for exceptionally short windows or large font settings.
        int nextHeight = Math.max(dp(28), Math.min(dp(compact ? 36 : 42), (height - dp(26)) / 6));
        if (nextHeight != rowHeight) {
            rowHeight = nextHeight;
            for (int i = 0; i < getChildCount(); i++) {
                View child = getChildAt(i);
                if (child instanceof LinearLayout) {
                    child.getLayoutParams().height = rowHeight;
                    child.requestLayout();
                }
            }
            for (int i = 0; i < body.getChildCount(); i++) {
                body.getChildAt(i).getLayoutParams().height = rowHeight;
                body.getChildAt(i).requestLayout();
            }
        }
        return height;
    }
    @Override protected void onDetachedFromWindow() { state.setEnabled(false); super.onDetachedFromWindow(); }
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
