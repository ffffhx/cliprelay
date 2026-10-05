package com.limelight.ui;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.InsetDrawable;
import android.os.Build;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.Spinner;
import android.widget.TextView;

import com.limelight.R;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;
import java.util.function.Consumer;

/** Touch keyboard controls layered over the stream. Blank areas consume touches in game mode. */
public final class GameControlsView extends FrameLayout {
    private static final int[] LABELS = {R.string.game_up, R.string.game_down, R.string.game_left,
            R.string.game_right, R.string.game_grab, R.string.game_act, R.string.game_ready,
            R.string.game_confirm, R.string.game_pause};
    private static final int[] STARDEW_LABELS = {R.string.game_up, R.string.game_down,
            R.string.game_left, R.string.game_right, R.string.stardew_tool, R.string.stardew_action,
            R.string.stardew_inventory, R.string.stardew_toolbar, R.string.game_pause,
            R.string.stardew_journal, R.string.stardew_map};
    private final Activity activity;
    private final GameInputState input;
    private SharedPreferences preferences;
    private GameBindings.Profile profile;
    private int[] keys;
    private final Consumer<Boolean> pointerChanged;
    private final ArrayList<HoldButton> holdButtons = new ArrayList<>();
    private final Joystick joystick;
    private final FrameLayout actions;
    private final ImageButton menuToggle;
    private final LinearLayout menuPanel;
    private final ScrollView menuScroll;
    private final Button profileButton, pointerButton, journal, map;
    private final HorizontalScrollView hotbar;
    private final Button pause;
    private int size, opacity;
    private boolean mirrored, available, settingsOpen, menuOpen, pointerMode, dismissGesture;
    private Runnable automaticMode = () -> {}, manualMode = () -> {};
    private Runnable virtualKeyboard = () -> {};
    private Runnable home = () -> {};
    public void setVirtualKeyboardAction(Runnable action) { virtualKeyboard = action; }
    public void setHomeAction(Runnable action) { home = action; }
    private Runnable streamInfo = () -> {};
    public void setStreamInfoAction(Runnable action) { streamInfo = action; }

    public void setApplicationModeActions(Runnable automatic, Runnable manual) {
        automaticMode = automatic; manualMode = manual;
    }

    public GameControlsView(Activity activity, GameInputState.KeySink sink, Runnable exit) {
        this(activity, sink, exit, enabled -> {});
    }

    public GameControlsView(Activity activity, GameInputState.KeySink sink, Runnable exit, Consumer<Boolean> pointerChanged) {
        super(activity);
        this.activity = activity;
        this.pointerChanged = pointerChanged;
        input = new GameInputState(sink);
        profile = GameBindings.Profile.fromId(activity.getSharedPreferences("cliprelay_game_profiles", 0).getString("profile", "plateup"));
        preferences = activity.getSharedPreferences(GameBindings.preferencesName(profile), 0);
        loadPreferences();
        setId(R.id.gameControlsOverlay);
        setMotionEventSplittingEnabled(true);
        setClickable(true);
        setFocusable(false);

        joystick = new Joystick();
        joystick.setId(R.id.gameJoystick);
        joystick.setContentDescription(activity.getString(R.string.game_move));
        addView(joystick);
        actions = new FrameLayout(activity);
        actions.setMotionEventSplittingEnabled(true);
        addView(actions);
        addAction(GameBindings.GRAB, R.id.gameGrab);
        addAction(GameBindings.ACT, R.id.gameAct);
        addAction(GameBindings.READY, R.id.gameReady);
        addAction(GameBindings.CONFIRM, R.id.gameConfirm);

        // A small corner control leaves the top of the stream unobstructed.
        // Its visible circle is 36dp; the touch target remains 48dp.
        menuToggle = new ImageButton(activity);
        menuToggle.setId(R.id.gameMenuButton);
        menuToggle.setImageResource(R.drawable.remote_ic_more);
        menuToggle.setColorFilter(Color.WHITE);
        menuToggle.setPadding(dp(13), dp(13), dp(13), dp(13));
        menuToggle.setBackground(new InsetDrawable(surface(0xD90B1F33, 24), dp(6)));
        menuToggle.setFocusable(false);
        LayoutParams togglePlacement = new LayoutParams(dp(48), dp(48), Gravity.TOP | Gravity.RIGHT);
        togglePlacement.setMargins(dp(8), dp(4), dp(8), 0);
        addView(menuToggle, togglePlacement);

        menuPanel = new LinearLayout(activity);
        menuPanel.setId(R.id.gameMenuPanel);
        menuPanel.setOrientation(LinearLayout.VERTICAL);
        menuPanel.setPadding(dp(6), dp(6), dp(6), dp(6));
        menuPanel.setBackground(surface(0xF20B1F33, 18));
        menuPanel.setClickable(true);
        Button homeButton = menuButton(R.string.desktop_home);
        homeButton.setId(R.id.gameHomeButton);
        menuPanel.addView(homeButton, new LinearLayout.LayoutParams(-1, dp(48)));
        homeButton.setOnClickListener(v -> { setMenuOpen(false); if (available) home.run(); });
        Button infoButton = menuButton(R.string.stream_info_title);
        infoButton.setId(R.id.gameStreamInfoButton);
        menuPanel.addView(infoButton, new LinearLayout.LayoutParams(-1, dp(48)));
        infoButton.setOnClickListener(v -> { setMenuOpen(false); if (available) streamInfo.run(); });
        profileButton = menuButton(R.string.game_choose_profile);
        profileButton.setId(R.id.gameProfileButton);
        menuPanel.addView(profileButton, new LinearLayout.LayoutParams(-1, dp(48)));
        profileButton.setOnClickListener(v -> showProfiles());
        Button settings = menuButton(R.string.game_settings);
        settings.setId(R.id.gameSettings);
        menuPanel.addView(settings, new LinearLayout.LayoutParams(-1, dp(48)));
        settings.setOnClickListener(v -> showSettings());
        Button keyboard = menuButton(R.string.virtual_keyboard);
        keyboard.setId(R.id.gameVirtualKeyboardButton);
        menuPanel.addView(keyboard, new LinearLayout.LayoutParams(-1, dp(48)));
        keyboard.setOnClickListener(v -> { setMenuOpen(false); virtualKeyboard.run(); });
        pause = menuButton(R.string.game_pause);
        pause.setId(R.id.gamePause);
        menuPanel.addView(pause, new LinearLayout.LayoutParams(-1, dp(48)));
        pause.setOnClickListener(v -> {
            if (!menuOpen) return;
            setMenuOpen(false);
            tapKey(keys[GameBindings.PAUSE]);
        });
        journal = menuButton(R.string.stardew_journal);
        journal.setId(R.id.gameJournal);
        menuPanel.addView(journal, new LinearLayout.LayoutParams(-1, dp(48)));
        journal.setOnClickListener(v -> { setMenuOpen(false); tapKey(keys[GameBindings.JOURNAL]); });
        map = menuButton(R.string.stardew_map);
        map.setId(R.id.gameMap);
        menuPanel.addView(map, new LinearLayout.LayoutParams(-1, dp(48)));
        map.setOnClickListener(v -> { setMenuOpen(false); tapKey(keys[GameBindings.MAP]); });
        Button desktop = menuButton(R.string.game_back_desktop);
        desktop.setId(R.id.gameDesktop);
        menuPanel.addView(desktop, new LinearLayout.LayoutParams(-1, dp(48)));
        desktop.setOnClickListener(v -> { setMenuOpen(false); exit.run(); });
        LayoutParams panelPlacement = new LayoutParams(dp(164), -2, Gravity.TOP | Gravity.RIGHT);
        panelPlacement.setMargins(dp(12), dp(56), dp(12), 0);
        menuScroll = new ScrollView(activity);
        menuScroll.addView(menuPanel);
        addView(menuScroll, panelPlacement);

        pointerButton = menuButton(R.string.game_pointer_mode);
        pointerButton.setId(R.id.gamePointerButton);
        pointerButton.setBackground(surface(0xD90B1F33, 14));
        LayoutParams pointerPlacement = new LayoutParams(-2, dp(48), Gravity.TOP | Gravity.LEFT);
        pointerPlacement.setMargins(dp(8), dp(4), 0, 0);
        addView(pointerButton, pointerPlacement);
        pointerButton.setOnClickListener(v -> setPointerMode(!pointerMode));

        hotbar = new HorizontalScrollView(activity);
        hotbar.setId(R.id.gameHotbar);
        hotbar.setHorizontalScrollBarEnabled(false);
        LinearLayout slots = new LinearLayout(activity);
        slots.setBackground(surface(0xAA0B1F33, 12));
        for (int i = 0; i < GameBindings.INVENTORY_KEYS.length; i++) {
            final int key = GameBindings.INVENTORY_KEYS[i];
            Button slot = menuButton(R.string.stardew_slot);
            slot.setText(String.valueOf(i + 1));
            slot.setContentDescription(activity.getString(R.string.stardew_slot_number, i + 1));
            slots.addView(slot, new LinearLayout.LayoutParams(dp(44), dp(44)));
            slot.setOnClickListener(v -> { if (!menuOpen && !pointerMode) tapKey(key); });
        }
        hotbar.addView(slots);
        LayoutParams hotbarPlacement = new LayoutParams(-2, dp(44), Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        hotbarPlacement.setMargins(dp(132), dp(4), dp(60), 0);
        addView(hotbar, hotbarPlacement);
        menuToggle.setOnClickListener(v -> setMenuOpen(!menuOpen));
        setMenuOpen(false);
        refreshProfile();

        setOnApplyWindowInsetsListener((view, insets) -> {
            int left = 0, right = 0, topInset = 0;
            if (Build.VERSION.SDK_INT >= 28 && insets.getDisplayCutout() != null) {
                left = insets.getDisplayCutout().getSafeInsetLeft();
                right = insets.getDisplayCutout().getSafeInsetRight();
                topInset = insets.getDisplayCutout().getSafeInsetTop();
            }
            setPadding(left, topInset, right, insets.getSystemWindowInsetBottom());
            post(this::arrangeControls);
            return insets;
        });
    }

    public void setAvailable(boolean available) {
        this.available = available;
        if (!available) setMenuOpen(false);
        updateInputEnabled();
    }

    private void updateInputEnabled() {
        input.setEnabled(available && getVisibility() == VISIBLE && !settingsOpen && !menuOpen && !pointerMode);
    }

    private void setMenuOpen(boolean open) {
        releaseTouches();
        menuOpen = open;
        menuPanel.setVisibility(open ? VISIBLE : GONE);
        menuScroll.setVisibility(open ? VISIBLE : GONE);
        setClickable(!pointerMode || open);
        menuToggle.setAlpha(open ? 1f : 0.55f);
        menuToggle.setContentDescription(activity.getString(open ? R.string.game_menu_close : R.string.game_menu));
        updateInputEnabled();
    }

    @Override public boolean onInterceptTouchEvent(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) dismissGesture = false;
        if (menuOpen && event.getActionMasked() == MotionEvent.ACTION_DOWN &&
                !isInside(menuScroll, event) && !isInside(menuToggle, event)) {
            setMenuOpen(false);
            dismissGesture = true;
            // Consume this gesture: closing the menu must not also move or interact.
            return true;
        }
        return super.onInterceptTouchEvent(event);
    }

    @Override public boolean onTouchEvent(MotionEvent event) {
        // Menu touch normally passes through this view. The gesture that closes
        // its menu must still be consumed in full, including after it becomes non-clickable.
        if (dismissGesture) {
            if (event.getActionMasked() == MotionEvent.ACTION_UP || event.getActionMasked() == MotionEvent.ACTION_CANCEL) {
                dismissGesture = false;
            }
            return true;
        }
        return super.onTouchEvent(event);
    }

    private boolean isInside(View view, MotionEvent event) {
        return event.getX() >= view.getLeft() && event.getX() < view.getRight() &&
                event.getY() >= view.getTop() && event.getY() < view.getBottom();
    }

    @Override public void setVisibility(int visibility) {
        if (menuPanel != null && visibility != VISIBLE) { setMenuOpen(false); setPointerMode(false); }
        super.setVisibility(visibility);
        if (input != null) updateInputEnabled();
    }

    public void releaseTouches() {
        input.releaseAll();
        if (joystick != null) joystick.reset();
        for (HoldButton button : holdButtons) button.reset();
    }

    @Override protected void onDetachedFromWindow() {
        setMenuOpen(false);
        setPointerMode(false);
        input.setEnabled(false);
        super.onDetachedFromWindow();
    }

    @Override protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        if (menuPanel != null) setMenuOpen(false);
        post(this::arrangeControls);
    }

    private void addAction(int action, int id) {
        HoldButton button = new HoldButton(action);
        button.setId(id);
        actions.addView(button);
    }

    private void arrangeControls() {
        if (getWidth() == 0 || getHeight() == 0) return;
        float availableWidth = (getWidth() - getPaddingLeft() - getPaddingRight()) / getResources().getDisplayMetrics().density;
        float availableHeight = (getHeight() - getPaddingTop() - getPaddingBottom()) / getResources().getDisplayMetrics().density;
        LayoutParams slots = (LayoutParams) hotbar.getLayoutParams();
        slots.gravity = Gravity.TOP | Gravity.LEFT;
        slots.width = dp(Math.max(44, Math.min(528, availableWidth - 200)));
        hotbar.setLayoutParams(slots);
        LayoutParams panel = (LayoutParams) menuScroll.getLayoutParams();
        panel.height = dp(Math.min(profile == GameBindings.Profile.STARDEW ? 300 : 204, Math.max(96, availableHeight - 68)));
        menuScroll.setLayoutParams(panel);
        float scale = Math.min(size / 100f, Math.min((availableWidth - 32) / 418f, (availableHeight - 100) / 204f));
        scale = Math.max(0.5f, scale);
        LayoutParams stickLayout = new LayoutParams(dp(174 * scale), dp(174 * scale),
                Gravity.BOTTOM | (mirrored ? Gravity.RIGHT : Gravity.LEFT));
        stickLayout.setMargins(dp(16), 0, dp(16), dp(16));
        joystick.setLayoutParams(stickLayout);
        joystick.setAlpha(opacity / 100f);
        LayoutParams buttonsLayout = new LayoutParams(dp(244 * scale), dp(188 * scale),
                Gravity.BOTTOM | (mirrored ? Gravity.LEFT : Gravity.RIGHT));
        buttonsLayout.setMargins(dp(16), 0, dp(16), dp(16));
        actions.setLayoutParams(buttonsLayout);
        actions.setAlpha(opacity / 100f);
        int[][] positions = {{0, 24, 88, 88}, {128, 76, 88, 88}, {8, 126, 72, 48}, {112, 12, 88, 48}};
        for (int i = 0; i < actions.getChildCount(); i++) {
            HoldButton button = (HoldButton) actions.getChildAt(i);
            int[] p = positions[i];
            LayoutParams params = new LayoutParams(dp(p[2] * scale), dp(p[3] * scale));
            params.leftMargin = dp(p[0] * scale);
            params.topMargin = dp(p[1] * scale);
            button.setLayoutParams(params);
            button.setTextSize(Math.max(11, 14 * scale));
            button.refreshLabel();
        }
        for (HoldButton button : holdButtons) button.refreshLabel();
        pause.setText(activity.getString(R.string.game_pause) + " · " + GameBindings.name(keys[GameBindings.PAUSE]));
        joystick.invalidate();
    }

    private void loadPreferences() {
        int[] defaults = GameBindings.defaults(profile);
        keys = defaults.clone();
        for (int i = 0; i < keys.length; i++) keys[i] = GameBindings.sanitize(
                preferences.getInt("key_" + i, defaults[i]), defaults[i]);
        size = Math.max(80, Math.min(130, preferences.getInt("size", 100)));
        opacity = Math.max(40, Math.min(100, preferences.getInt("opacity", 80)));
        mirrored = preferences.getBoolean("mirrored", false);
    }

    private void showSettings() {
        setMenuOpen(false);
        settingsOpen = true;
        updateInputEnabled();
        LinearLayout content = new LinearLayout(activity);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(20), dp(8), dp(20), dp(12));
        TextView explanation = new TextView(activity);
        explanation.setText(activity.getString(R.string.game_hint) + "\n" + activity.getString(R.string.game_settings_hint));
        explanation.setTextSize(13);
        content.addView(explanation);
        String[] choices = new String[GameBindings.OPTIONS.length];
        for (int i = 0; i < choices.length; i++) choices[i] = GameBindings.name(GameBindings.OPTIONS[i]);
        Spinner[] selectors = new Spinner[keys.length];
        for (int action = 0; action < keys.length; action++) {
            LinearLayout row = new LinearLayout(activity);
            row.setGravity(Gravity.CENTER_VERTICAL);
            TextView label = new TextView(activity);
            label.setText(labels()[action]);
            row.addView(label, new LinearLayout.LayoutParams(0, dp(48), 1));
            label.setGravity(Gravity.CENTER_VERTICAL);
            Spinner selector = new Spinner(activity);
            selector.setContentDescription(activity.getString(labels()[action]));
            ArrayAdapter<String> adapter = new ArrayAdapter<>(activity, android.R.layout.simple_spinner_item, choices);
            adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
            selector.setAdapter(adapter);
            for (int option = 0; option < choices.length; option++) {
                if (GameBindings.OPTIONS[option] == keys[action]) selector.setSelection(option);
            }
            row.addView(selector, new LinearLayout.LayoutParams(dp(120), dp(48)));
            selectors[action] = selector;
            content.addView(row);
        }
        SeekBar sizeControl = slider(content, R.string.game_size, 80, 130, size);
        SeekBar opacityControl = slider(content, R.string.game_opacity, 40, 100, opacity);
        CheckBox leftHanded = new CheckBox(activity);
        leftHanded.setText(R.string.game_left_handed);
        leftHanded.setChecked(mirrored);
        content.addView(leftHanded);
        ScrollView scroll = new ScrollView(activity);
        scroll.addView(content);
        AlertDialog dialog = new AlertDialog.Builder(activity)
                .setTitle(activity.getString(profileLabel()) + " · " + activity.getString(R.string.game_settings)).setView(scroll)
                .setNegativeButton(android.R.string.cancel, null)
                .setNeutralButton(profile == GameBindings.Profile.PLATEUP ? R.string.game_reset : R.string.stardew_reset, (d, which) -> {
                    preferences.edit().clear().apply();
                    loadPreferences();
                    arrangeControls();
                })
                .setPositiveButton(R.string.game_save, (d, which) -> {
                    SharedPreferences.Editor edit = preferences.edit();
                    for (int i = 0; i < keys.length; i++) edit.putInt("key_" + i, GameBindings.OPTIONS[selectors[i].getSelectedItemPosition()]);
                    edit.putInt("size", sizeControl.getProgress() + 80);
                    edit.putInt("opacity", opacityControl.getProgress() + 40);
                    edit.putBoolean("mirrored", leftHanded.isChecked()).apply();
                    loadPreferences();
                    arrangeControls();
                }).create();
        dialog.setOnDismissListener(d -> { settingsOpen = false; updateInputEnabled(); });
        dialog.show();
    }

    private SeekBar slider(LinearLayout parent, int label, int min, int max, int value) {
        TextView title = new TextView(activity);
        title.setText(activity.getString(label) + " · " + value + "%");
        parent.addView(title);
        SeekBar bar = new SeekBar(activity);
        bar.setContentDescription(activity.getString(label));
        bar.setMax(max - min);
        bar.setProgress(value - min);
        bar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            public void onProgressChanged(SeekBar b, int progress, boolean user) { title.setText(activity.getString(label) + " · " + (progress + min) + "%"); }
            public void onStartTrackingTouch(SeekBar b) {}
            public void onStopTrackingTouch(SeekBar b) {}
        });
        parent.addView(bar, new LinearLayout.LayoutParams(-1, dp(48)));
        return bar;
    }

    private final class HoldButton extends TextView {
        private final int action;
        private final Set<Integer> pointers = new HashSet<>();

        HoldButton(int action) {
            super(activity);
            this.action = action;
            holdButtons.add(this);
            setGravity(Gravity.CENTER);
            setTextSize(13);
            setTextColor(Color.WHITE);
            setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
            setPadding(dp(4), dp(2), dp(4), dp(2));
            setClickable(true);
            setFocusable(false);
            refreshLabel();
            reset();
        }

        void refreshLabel() {
            setText(activity.getString(labels()[action]) + "\n" + GameBindings.name(keys[action]));
            setContentDescription(activity.getString(labels()[action]) + " · " + GameBindings.name(keys[action]));
        }

        private String source(int pointer) { return "button:" + action + ":" + pointer; }

        void reset() {
            for (int pointer : pointers) input.update(source(pointer));
            pointers.clear();
            setPressed(false);
            setAlpha(0.88f);
            setBackground(surface(action == GameBindings.ACT ? 0xE62F80ED : 0xE6173046,
                    action == GameBindings.GRAB || action == GameBindings.ACT ? 100 : 14));
        }

        @Override public boolean onTouchEvent(MotionEvent event) {
            if (!input.isEnabled()) return true;
            int index = event.getActionIndex();
            int pointer = event.getPointerId(index);
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                case MotionEvent.ACTION_POINTER_DOWN:
                    getParent().requestDisallowInterceptTouchEvent(true);
                    pointers.add(pointer);
                    input.update(source(pointer), keys[action]);
                    break;
                case MotionEvent.ACTION_MOVE:
                    for (int id : pointers) {
                        int at = event.findPointerIndex(id);
                        boolean inside = at >= 0 && event.getX(at) >= 0 && event.getY(at) >= 0 &&
                                event.getX(at) < getWidth() && event.getY(at) < getHeight();
                        if (inside) input.update(source(id), keys[action]);
                        else input.update(source(id));
                    }
                    break;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_POINTER_UP:
                    input.update(source(pointer));
                    pointers.remove(pointer);
                    break;
                case MotionEvent.ACTION_CANCEL:
                    reset();
                    return true;
            }
            setPressed(!pointers.isEmpty());
            setAlpha(isPressed() ? 1f : 0.88f);
            return true;
        }

        @Override public boolean performClick() {
            super.performClick();
            if (input.isEnabled()) {
                input.update("accessibility:" + action, keys[action]);
                input.update("accessibility:" + action);
            }
            return true;
        }
    }

    private final class Joystick extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private int pointer = -1;
        private float x, y;

        Joystick() { super(activity); setClickable(true); setFocusable(false); }

        void reset() { pointer = -1; x = y = 0; invalidate(); }

        @Override protected void onDraw(Canvas canvas) {
            float center = getWidth() / 2f, radius = center - dp(3);
            paint.setStyle(Paint.Style.FILL);
            paint.setColor(0xD90B1F33);
            canvas.drawCircle(center, center, radius, paint);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(dp(1.5f));
            paint.setColor(0xFF7AB7FF);
            canvas.drawCircle(center, center, radius, paint);
            paint.setStyle(Paint.Style.FILL);
            paint.setColor(0xFFE8F1FA);
            paint.setTextSize(getWidth() * 0.095f);
            paint.setTextAlign(Paint.Align.CENTER);
            canvas.drawText(GameBindings.name(keys[GameBindings.UP]), center, center - radius * .68f, paint);
            canvas.drawText(GameBindings.name(keys[GameBindings.DOWN]), center, center + radius * .84f, paint);
            canvas.drawText(GameBindings.name(keys[GameBindings.LEFT]), center - radius * .77f, center + dp(5), paint);
            canvas.drawText(GameBindings.name(keys[GameBindings.RIGHT]), center + radius * .77f, center + dp(5), paint);
            paint.setColor(pointer >= 0 ? 0xFF3DD6D0 : 0xFF2F80ED);
            canvas.drawCircle(center + x * radius * .46f, center + y * radius * .46f, radius * .31f, paint);
        }

        @Override public boolean onTouchEvent(MotionEvent event) {
            if (!input.isEnabled()) return true;
            int action = event.getActionMasked();
            if (action == MotionEvent.ACTION_DOWN) {
                getParent().requestDisallowInterceptTouchEvent(true);
                pointer = event.getPointerId(0);
            } else if (action == MotionEvent.ACTION_CANCEL || action == MotionEvent.ACTION_UP ||
                    (action == MotionEvent.ACTION_POINTER_UP && event.getPointerId(event.getActionIndex()) == pointer)) {
                input.update("joystick");
                reset();
                return true;
            }
            int index = event.findPointerIndex(pointer);
            if (index < 0) return true;
            x = (event.getX(index) - getWidth() / 2f) / (getWidth() / 2f);
            y = (event.getY(index) - getHeight() / 2f) / (getHeight() / 2f);
            float length = (float) Math.sqrt(x * x + y * y);
            if (length > 1) { x /= length; y /= length; }
            int direction = GameInputState.direction(x, y);
            ArrayList<Integer> pressed = new ArrayList<>();
            if ((direction & 1) != 0) pressed.add(keys[GameBindings.LEFT]);
            if ((direction & 2) != 0) pressed.add(keys[GameBindings.RIGHT]);
            if ((direction & 4) != 0) pressed.add(keys[GameBindings.UP]);
            if ((direction & 8) != 0) pressed.add(keys[GameBindings.DOWN]);
            int[] held = new int[pressed.size()];
            for (int i = 0; i < held.length; i++) held[i] = pressed.get(i);
            input.update("joystick", held);
            invalidate();
            return true;
        }

        @Override public boolean performClick() { super.performClick(); return true; }
    }

    public GameBindings.Profile getProfile() { return profile; }

    public void setProfile(GameBindings.Profile value) {
        setProfile(value, true);
    }

    public void setProfile(GameBindings.Profile value, boolean persist) {
        if (settingsOpen) return;
        releaseTouches();
        setMenuOpen(false);
        setPointerMode(false);
        profile = value;
        if (persist) activity.getSharedPreferences("cliprelay_game_profiles", 0).edit().putString("profile", value.id).apply();
        preferences = activity.getSharedPreferences(GameBindings.preferencesName(profile), 0);
        loadPreferences();
        refreshProfile();
        arrangeControls();
    }

    private int[] labels() { return profile == GameBindings.Profile.STARDEW ? STARDEW_LABELS : LABELS; }
    private int profileLabel() { return profile == GameBindings.Profile.STARDEW ? R.string.game_profile_stardew : R.string.game_profile; }

    private void refreshProfile() {
        boolean stardew = profile == GameBindings.Profile.STARDEW;
        profileButton.setText(activity.getString(profileLabel()) + " ▾");
        journal.setVisibility(stardew ? VISIBLE : GONE);
        map.setVisibility(stardew ? VISIBLE : GONE);
        pointerButton.setVisibility(stardew ? VISIBLE : GONE);
        hotbar.setVisibility(stardew && !pointerMode ? VISIBLE : GONE);
        for (HoldButton button : holdButtons) button.refreshLabel();
    }

    public boolean isPointerMode() { return pointerMode; }
    public void setPointerMode(boolean enabled) {
        enabled = enabled && profile == GameBindings.Profile.STARDEW;
        releaseTouches();
        boolean changed = pointerMode != enabled;
        pointerMode = enabled;
        setMenuOpen(false);
        joystick.setVisibility(enabled ? GONE : VISIBLE);
        actions.setVisibility(enabled ? GONE : VISIBLE);
        hotbar.setVisibility(!enabled && profile == GameBindings.Profile.STARDEW ? VISIBLE : GONE);
        pointerButton.setText(enabled ? R.string.game_pointer_back : R.string.game_pointer_mode);
        updateInputEnabled();
        if (changed) pointerChanged.accept(enabled);
    }

    private void tapKey(int key) {
        if (!available || getVisibility() != VISIBLE || settingsOpen) return;
        input.setEnabled(true);
        input.update("menu-shortcut", key);
        input.update("menu-shortcut");
        updateInputEnabled();
    }

    private void showProfiles() {
        showProfiles(() -> {});
    }

    public void showProfiles(Runnable onSelected) {
        if (settingsOpen) return;
        setMenuOpen(false);
        settingsOpen = true;
        updateInputEnabled();
        String[] names = {activity.getString(R.string.game_profile), activity.getString(R.string.game_profile_stardew)};
        AlertDialog dialog = new AlertDialog.Builder(activity).setTitle(R.string.game_choose_profile)
                .setSingleChoiceItems(names, profile.ordinal(), (d, which) -> {
                    settingsOpen = false;
                    manualMode.run();
                    setProfile(GameBindings.Profile.values()[which]);
                    onSelected.run();
                    d.dismiss();
                }).setNeutralButton(R.string.desktop_auto_app, (d, which) -> {
                    settingsOpen = false; automaticMode.run();
                }).setNegativeButton(android.R.string.cancel, null).create();
        dialog.setOnDismissListener(d -> { settingsOpen = false; updateInputEnabled(); });
        dialog.show();
    }

    private Button menuButton(int label) {
        Button button = new Button(activity);
        button.setText(label);
        button.setTextColor(Color.WHITE);
        button.setTextSize(12);
        button.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        button.setAllCaps(false);
        button.setBackgroundColor(Color.TRANSPARENT);
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setPadding(dp(12), 0, dp(12), 0);
        button.setFocusable(false);
        return button;
    }

    private GradientDrawable surface(int color, int radius) {
        GradientDrawable background = new GradientDrawable();
        background.setColor(color);
        background.setCornerRadius(dp(radius));
        background.setStroke(dp(1), 0x997AB7FF);
        return background;
    }

    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
