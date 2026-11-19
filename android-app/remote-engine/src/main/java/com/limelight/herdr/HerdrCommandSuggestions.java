package com.limelight.herdr;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.List;

/** A bounded, non-modal picker. Choosing a command edits only the phone draft. */
final class HerdrCommandSuggestions extends ScrollView {
    private final EditText composer;
    private final LinearLayout rows;
    private final HerdrPalette colors;
    private String agent = "", rendered = "";
    private boolean available;

    HerdrCommandSuggestions(Context context, EditText composer) {
        super(context);
        this.composer = composer;
        colors = new HerdrPalette(context);
        setVisibility(GONE);
        setFocusable(false);
        setFillViewport(false);
        setBackground(background(colors.surface));
        setContentDescription("Codex 常用命令候选");
        rows = new LinearLayout(context);
        rows.setOrientation(LinearLayout.VERTICAL);
        addView(rows, new ScrollView.LayoutParams(-1, -2));
        composer.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            public void onTextChanged(CharSequence s, int start, int before, int count) { refresh(); }
            public void afterTextChanged(Editable text) {}
        });
    }

    void setContext(String agent, boolean available) {
        this.agent = agent;
        this.available = available;
        refresh();
    }

    private void refresh() {
        String draft = composer.getText().toString();
        String signature = agent + "\n" + available + "\n" + draft;
        if (signature.equals(rendered)) return;
        rendered = signature;
        rows.removeAllViews();
        List<HerdrSlashCommands.Command> matches = HerdrSlashCommands.matching(available ? agent : "", draft);
        setVisibility(matches.isEmpty() ? GONE : VISIBLE);
        if (matches.isEmpty()) return;

        TextView hint = label("Codex 常用命令 · 点选后发送", 11, colors.muted);
        hint.setPadding(dp(12), dp(6), dp(12), dp(4));
        rows.addView(hint);
        for (HerdrSlashCommands.Command command : matches) {
            LinearLayout row = new LinearLayout(getContext());
            row.setOrientation(LinearLayout.VERTICAL);
            row.setPadding(dp(12), dp(7), dp(12), dp(7));
            row.setMinimumHeight(dp(52));
            row.setBackground(new RippleDrawable(ColorStateList.valueOf(colors.selection), background(colors.surface), null));
            TextView name = label(command.text, 15, colors.ink);
            name.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
            row.addView(name);
            row.addView(label(command.description, 12, colors.muted));
            row.setContentDescription(command.text + "，" + command.description + "，填入消息输入框");
            row.setOnClickListener(v -> {
                // Guard stale taps if the draft or session changed since rendering.
                if (!available || !"codex".equals(agent) || !draft.equals(composer.getText().toString())) return;
                composer.setText(command.text);
                composer.setSelection(command.text.length());
                composer.requestFocus();
            });
            rows.addView(row, new LinearLayout.LayoutParams(-1, -2));
        }
        scrollTo(0, 0);
    }

    @Override protected void onMeasure(int widthSpec, int heightSpec) {
        int limit = dp(180);
        if (View.MeasureSpec.getMode(heightSpec) != View.MeasureSpec.UNSPECIFIED) {
            limit = Math.min(limit, View.MeasureSpec.getSize(heightSpec));
        }
        super.onMeasure(widthSpec, View.MeasureSpec.makeMeasureSpec(limit, View.MeasureSpec.AT_MOST));
    }

    private TextView label(String text, int size, int color) {
        TextView view = new TextView(getContext());
        view.setText(text);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setIncludeFontPadding(false);
        return view;
    }

    private GradientDrawable background(int color) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(10));
        return drawable;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
