package com.limelight.ui;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.InsetDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Build;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.content.Context;
import android.content.SharedPreferences;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.Toast;
import com.limelight.preferences.TouchMode;
import com.limelight.nvstream.NvConnection;
import com.limelight.nvstream.input.KeyboardPacket;
import com.limelight.nvstream.input.MouseButtonPacket;
import com.limelight.R;

/** ClipRelay controls around the embedded streaming engine. GPL-3.0-only. */
public final class DesktopToolbar {
    public interface Actions {
        void keyboard();
        TouchMode touchMode();
        void selectTouchMode(TouchMode mode);
        void disconnect();
        void gameModeChanged(boolean enabled);
        default void gamePointerModeChanged(boolean enabled) {}
        default void applicationChanged() {}
        default void virtualKeyboardChanged(boolean visible) {}
        default void image() {}
        default void home() {}
        default void streamInfo() {}
    }

    public static final class Controller {
        private GameControlsView game;
        private View desktop;
        private EdgeHandle handle;
        private Actions actions;
        private Button touchModeButton;
        private DesktopProfile profile;
        private SharedPreferences preferences;
        private Runnable rebuild;
        private boolean automatic;
        private String detectedApp, appliedApp;
        private VirtualKeyboardView virtualKeyboard;
        private boolean keyboardOpen;
        private DesktopSideRails sideRails;

        public boolean isSideRailsActive() { return sideRails != null && sideRails.isAvailable(); }

        public boolean isVirtualKeyboardOpen() { return keyboardOpen; }
        public void showVirtualKeyboard() {
            if (!canSend()) return;
            releaseTouches();
            keyboardOpen = true;
            actions.virtualKeyboardChanged(true);
            update();
        }
        public boolean hideVirtualKeyboard() {
            if (!keyboardOpen) return false;
            keyboardOpen = false;
            virtualKeyboard.setAvailable(false);
            actions.virtualKeyboardChanged(false);
            update();
            return true;
        }

        public DesktopProfile getProfile() { return profile; }
        public void setProfile(DesktopProfile value) {
            setAutomaticMode(false);
            profile = value;
            preferences.edit().putString("profile", value.id).apply();
            rebuild.run();
        }
        public boolean isAutomaticMode() { return automatic; }
        public void setAutomaticMode(boolean enabled) {
            automatic = enabled; appliedApp = null;
            preferences.edit().putBoolean("automatic_app", enabled).apply();
            rebuild.run();
            if (enabled && detectedApp != null) observeApplication(detectedApp);
        }
        public void observeApplication(String app) {
            // The first identification after connecting is not an app switch.
            // Cancelling input here can discard the user's first tap/IME request.
            if (detectedApp != null && !app.equals(detectedApp)) actions.applicationChanged();
            detectedApp = app;
            if (!automatic || app.equals(appliedApp) || !canSend() || !focused) return;
            if (app.equals("stardew") || app.equals("plateup")) {
                game.setProfile(GameBindings.Profile.fromId(app), false);
                setGameMode(true);
            } else {
                if (gameMode) setGameMode(false);
                profile = DesktopProfile.fromId(app);
                rebuild.run();
            }
            appliedApp = app;
        }
        private boolean canSend() { return connected && !paused && !pip; }

        public void updateTouchMode(TouchMode mode) {
            String label = touchModeButton.getContext().getString(R.string.touch_mode_button,
                    touchModeButton.getContext().getString(mode.label));
            touchModeButton.setText(label);
            touchModeButton.setContentDescription(label);
        }
        private boolean gameMode, connected, focused, paused, pip, expanded;

        public void setExpanded(boolean value) { expanded = value; update(); }
        public boolean isExpanded() { return expanded; }

        public boolean isGameMode() { return gameMode; }
        public void setGameMode(boolean enabled) {
            hideVirtualKeyboard();
            game.releaseTouches();
            gameMode = enabled;
            if (enabled) expanded = false;
            actions.gameModeChanged(enabled);
            update();
        }
        public void setConnected(boolean value) { connected = value; update(); }
        public void setFocused(boolean value) { focused = value; update(); }
        public void setPaused(boolean value) { paused = value; update(); }
        public void setPictureInPicture(boolean value) { pip = value; update(); }
        public void releaseTouches() {
            game.releaseTouches();
            if (virtualKeyboard != null) virtualKeyboard.clearModifiers();
        }
        private void update() {
            boolean ready = connected && focused && !paused && !pip;
            if (keyboardOpen && !ready) {
                keyboardOpen = false;
                actions.virtualKeyboardChanged(false);
            }
            virtualKeyboard.setAvailable(ready && keyboardOpen);
            virtualKeyboard.setVisibility(keyboardOpen ? View.VISIBLE : View.GONE);
            game.setAvailable(ready && !keyboardOpen);
            game.setVisibility(gameMode && !pip && !keyboardOpen ? View.VISIBLE : View.GONE);
            boolean desktopVisible = !gameMode && !pip && !keyboardOpen;
            sideRails.setVisible(desktopVisible);
            desktop.setVisibility(desktopVisible && !isSideRailsActive() && expanded ? View.VISIBLE : View.GONE);
            handle.setVisibility(desktopVisible && !isSideRailsActive() && !expanded ? View.VISIBLE : View.GONE);
            if (!focused || paused || pip || gameMode) handle.cancelGesture();
        }
    }

    public static Controller attach(Activity activity, FrameLayout root, NvConnection connection, Actions actions) {
        return attachWithSink(activity, root, new DesktopInput.Sink() {
            public void send(int key, boolean down, int modifiers) {
                connection.sendKeyboardInput((short)(0x8000 | key),
                        down ? KeyboardPacket.KEY_DOWN : KeyboardPacket.KEY_UP, (byte)modifiers, (byte)0);
            }
            public void text(String value) { connection.sendUtf8Text(value); }
            public void rightClick() {
                connection.sendMouseButtonDown(MouseButtonPacket.BUTTON_RIGHT);
                connection.sendMouseButtonUp(MouseButtonPacket.BUTTON_RIGHT);
            }
            public void scroll(byte clicks) { connection.sendMouseScroll(clicks); }
        }, actions);
    }

    public static Controller attachWithSink(Activity activity, FrameLayout root, DesktopInput.Sink sink, Actions actions) {
        Controller controller = new Controller();
        controller.actions = actions;
        controller.focused = activity.hasWindowFocus();
        controller.preferences = activity.getSharedPreferences("cliprelay_desktop_controls", 0);
        controller.profile = DesktopProfile.fromId(controller.preferences.getString("profile", "general"));
        controller.automatic = controller.preferences.getBoolean("automatic_app", true);
        DesktopInput keyboard = new DesktopInput(sink);
        controller.game = new GameControlsView(activity, sink,
                () -> { controller.setAutomaticMode(false); controller.setGameMode(false); }, actions::gamePointerModeChanged);
        controller.game.setApplicationModeActions(() -> controller.setAutomaticMode(true),
                () -> controller.setAutomaticMode(false));
        controller.game.setVirtualKeyboardAction(controller::showVirtualKeyboard);
        controller.game.setHomeAction(actions::home);
        controller.game.setStreamInfoAction(actions::streamInfo);
        controller.game.setVisibility(View.GONE);
        root.addView(controller.game, new FrameLayout.LayoutParams(-1, -1));
        int dp = Math.round(44 * activity.getResources().getDisplayMetrics().density);
        LinearLayout bar = new LinearLayout(activity);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(0xDD172033);
        HorizontalScrollView scroll = new HorizontalScrollView(activity);
        scroll.setId(R.id.desktopToolbar);
        scroll.setHorizontalScrollBarEnabled(false);
        scroll.addView(bar);
        FrameLayout.LayoutParams placement = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, dp, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        root.addView(scroll, placement);
        controller.desktop = scroll;

        // The collapsed control is a separate small view. The bottom toolbar is GONE,
        // including its background and touch area, so desktop content remains accessible.
        controller.handle = new EdgeHandle(activity, root);
        FrameLayout.LayoutParams handlePlacement = new FrameLayout.LayoutParams(
                Math.round(48 * activity.getResources().getDisplayMetrics().density),
                Math.round(48 * activity.getResources().getDisplayMetrics().density), Gravity.TOP | Gravity.RIGHT);
        root.addView(controller.handle, handlePlacement);
        controller.handle.setOnClickListener(v -> controller.setExpanded(true));

        controller.virtualKeyboard = new VirtualKeyboardView(activity, sink, controller::hideVirtualKeyboard,
                () -> { controller.hideVirtualKeyboard(); actions.keyboard(); });
        controller.virtualKeyboard.setVisibility(View.GONE);
        FrameLayout.LayoutParams keyboardPlacement = new FrameLayout.LayoutParams(-1,
                Math.round(282 * activity.getResources().getDisplayMetrics().density), Gravity.BOTTOM);
        root.addView(controller.virtualKeyboard, keyboardPlacement);
        root.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
            int height = controller.virtualKeyboard.preferredHeight(b - t);
            if (height > 0 && keyboardPlacement.height != height) {
                keyboardPlacement.height = height;
                controller.virtualKeyboard.setLayoutParams(keyboardPlacement);
            }
        });

        LinearLayout tools = new LinearLayout(activity);
        tools.setOrientation(LinearLayout.HORIZONTAL);
        Button toggle = button(activity, bar, activity.getString(R.string.desktop_controls_collapse));
        toggle.setId(R.id.desktopCollapseButton);
        bar.addView(tools);
        toggle.setOnClickListener(v -> controller.setExpanded(false));
        controller.sideRails = new DesktopSideRails(activity, root, () -> {
            controller.rebuild.run();
            controller.update();
        });
        controller.rebuild = () -> {
            tools.removeAllViews();
            controller.sideRails.clear();
            LinearLayout primary = controller.isSideRailsActive() ? controller.sideRails.leftButtons() : tools;
            LinearLayout secondary = controller.isSideRailsActive() ? controller.sideRails.rightButtons() : tools;
            Button home = button(activity, secondary, activity.getString(R.string.desktop_home));
            home.setId(R.id.desktopHomeButton);
            if (controller.isSideRailsActive()) home.setText(R.string.desktop_rail_home);
            home.setOnClickListener(v -> { if (controller.canSend()) actions.home(); });
            Button profile = button(activity, primary, (controller.automatic ? activity.getString(R.string.desktop_auto_prefix) : "")
                    + activity.getString(controller.profile.label) + " ▾");
            profile.setId(R.id.desktopProfileButton);
            if (controller.isSideRailsActive()) profile.setText(activity.getString(R.string.desktop_rail_profile));
            profile.setOnClickListener(v -> {
                DesktopProfile[] profiles = DesktopProfile.values();
                int gameChoice = profiles.length + 1;
                String[] labels = new String[profiles.length + 2];
                labels[0] = activity.getString(R.string.desktop_auto_app);
                for (int i = 0; i < profiles.length; i++) labels[i + 1] = activity.getString(profiles[i].label);
                labels[gameChoice] = activity.getString(R.string.game_mode);
                new AlertDialog.Builder(activity).setTitle(R.string.desktop_profile_title)
                        .setSingleChoiceItems(labels, controller.automatic ? 0 : controller.profile.ordinal() + 1, (d, which) -> {
                            d.dismiss();
                            if (which == gameChoice) {
                                if (!controller.canSend()) return;
                                controller.game.showProfiles(() -> {
                                    if (controller.canSend()) controller.setGameMode(true);
                                });
                            }
                            else if (which == 0) controller.setAutomaticMode(true);
                            else controller.setProfile(profiles[which - 1]);
                        }).setNegativeButton(android.R.string.cancel, null).show();
            });
            Button info = button(activity, primary, activity.getString(R.string.stream_info_title));
            info.setId(R.id.streamInfoButton);
            info.setOnClickListener(v -> { controller.releaseTouches(); actions.streamInfo(); });
            Button virtual = button(activity, primary, activity.getString(R.string.virtual_keyboard));
            virtual.setId(R.id.virtualKeyboardButton);
            virtual.setOnClickListener(v -> controller.showVirtualKeyboard());
            Button image = button(activity, primary, activity.getString(R.string.desktop_image));
            image.setId(R.id.desktopImageButton);
            image.setOnClickListener(v -> { if (controller.canSend()) actions.image(); });
            button(activity, primary, activity.getString(R.string.virtual_keyboard_phone)).setOnClickListener(v -> actions.keyboard());
            if (controller.profile.isChat()) {
                shortcut(activity, secondary, controller, keyboard, "Enter", 0x0D);
                shortcut(activity, secondary, controller, keyboard, activity.getString(controller.isSideRailsActive()
                        ? R.string.desktop_rail_newline : R.string.desktop_newline), 0x10, 0x0D);
                shortcut(activity, primary, controller, keyboard, activity.getString(R.string.desktop_paste), 0x11, 'V');
                shortcut(activity, primary, controller, keyboard, activity.getString(R.string.desktop_copy), 0x11, 'C');
                shortcut(activity, primary, controller, keyboard, activity.getString(R.string.desktop_select_all), 0x11, 'A');
                shortcut(activity, primary, controller, keyboard, activity.getString(R.string.desktop_undo), 0x11, 'Z');
                shortcut(activity, primary, controller, keyboard, activity.getString(R.string.desktop_redo), 0x11, 'Y');
                button(activity, secondary, activity.getString(R.string.desktop_scroll_up)).setOnClickListener(v -> {
                    if (controller.canSend()) sink.scroll((byte)3);
                });
                button(activity, secondary, activity.getString(R.string.desktop_scroll_down)).setOnClickListener(v -> {
                    if (controller.canSend()) sink.scroll((byte)-3);
                });
            } else {
                shortcut(activity, secondary, controller, keyboard, "Win", 0x5B);
                shortcut(activity, secondary, controller, keyboard, "Enter", 0x0D);
            }
            shortcut(activity, secondary, controller, keyboard, "Tab", 0x09);
            if (controller.profile == DesktopProfile.ORCA) shortcut(activity, secondary, controller, keyboard, "Shift+Tab", 0x10, 0x09);
            shortcut(activity, secondary, controller, keyboard, "Esc", 0x1B);
            button(activity, secondary, activity.getString(R.string.desktop_right_click)).setOnClickListener(v -> {
                if (controller.canSend()) sink.rightClick();
            });
            controller.touchModeButton = button(activity, secondary, "");
            controller.touchModeButton.setId(R.id.touchModeButton);
            controller.updateTouchMode(actions.touchMode());
            controller.touchModeButton.setOnClickListener(v -> new AlertDialog.Builder(activity)
                    .setTitle(R.string.touch_mode_title)
                    .setSingleChoiceItems(R.array.touch_mode_entries, actions.touchMode().ordinal(), (dialog, which) -> {
                        TouchMode mode = TouchMode.values()[which];
                        actions.selectTouchMode(mode);
                        controller.updateTouchMode(mode);
                        dialog.dismiss();
                        if (mode == TouchMode.PHONE) Toast.makeText(activity, R.string.touch_mode_phone_hint, Toast.LENGTH_LONG).show();
                    })
                    .setNeutralButton(R.string.touch_mode_help, (dialog, which) -> new AlertDialog.Builder(activity)
                            .setTitle(R.string.touch_mode_help).setMessage(R.string.touch_mode_help_body)
                            .setPositiveButton(android.R.string.ok, null).show())
                    .setNegativeButton(android.R.string.cancel, null).show());
            button(activity, secondary, activity.getString(R.string.desktop_disconnect)).setOnClickListener(v -> actions.disconnect());
        };
        controller.rebuild.run();
        controller.update();
        return controller;
    }

    /** A 28dp visible circle with a 48dp touch target, kept against the right edge. */
    private static final class EdgeHandle extends ImageButton {
        private final FrameLayout root;
        private final float density;
        private final int slop;
        private float fraction, startFraction, downX, downY;
        private boolean tracking, dragging, cancelled;

        EdgeHandle(Context context, FrameLayout root) {
            super(context);
            this.root = root;
            density = getResources().getDisplayMetrics().density;
            slop = ViewConfiguration.get(context).getScaledTouchSlop();
            fraction = context.getSharedPreferences("cliprelay_desktop_controls", 0).getFloat("handle_y", .5f);
            if (!Float.isFinite(fraction)) fraction = .5f;
            fraction = Math.max(0, Math.min(1, fraction));
            setId(R.id.desktopControlsHandle);
            setImageResource(R.drawable.remote_ic_more);
            setColorFilter(Color.WHITE);
            setPadding(dp(15), dp(15), dp(15), dp(15));
            GradientDrawable circle = new GradientDrawable();
            circle.setColor(0xD90B1F33);
            circle.setShape(GradientDrawable.OVAL);
            setBackground(new InsetDrawable(circle, dp(10)));
            setAlpha(.38f);
            setFocusable(false);
            setContentDescription(context.getString(R.string.desktop_controls_open));
            root.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> position());
        }

        private int dp(int value) { return Math.round(value * density); }
        @Override protected void onSizeChanged(int w, int h, int oldw, int oldh) {
            super.onSizeChanged(w, h, oldw, oldh);
            position();
        }
        private float travel() { return Math.max(0, root.getHeight() - dp(48) - 2 * dp(8)); }
        private void position() {
            float margin = Math.min(dp(8), Math.max(0, root.getHeight() - dp(48)) / 2f);
            setTranslationY(margin + fraction * travel());
        }

        void cancelGesture() {
            if (tracking) { fraction = startFraction; position(); }
            tracking = dragging = false;
            setPressed(false);
            setAlpha(.38f);
        }

        @Override public boolean onTouchEvent(MotionEvent event) {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    tracking = true;
                    dragging = cancelled = false;
                    startFraction = fraction;
                    downX = event.getRawX(); downY = event.getRawY();
                    setPressed(true); setAlpha(.85f);
                    return true;
                case MotionEvent.ACTION_POINTER_DOWN:
                    // Never turn a multi-finger gesture into a toolbar click.
                    cancelled = true;
                    return true;
                case MotionEvent.ACTION_MOVE:
                    if (!tracking || cancelled) return true;
                    if (Math.hypot(event.getRawX() - downX, event.getRawY() - downY) > slop) dragging = true;
                    if (dragging && travel() > 0) {
                        fraction = Math.max(0, Math.min(1, startFraction + (event.getRawY() - downY) / travel()));
                        position();
                    }
                    return true;
                case MotionEvent.ACTION_UP:
                    if (!tracking) return true;
                    if (Build.VERSION.SDK_INT >= 33 && (event.getFlags() & MotionEvent.FLAG_CANCELED) != 0) cancelled = true;
                    boolean clicked = !dragging && !cancelled;
                    if (cancelled) fraction = startFraction;
                    else if (dragging) getContext().getSharedPreferences("cliprelay_desktop_controls", 0)
                            .edit().putFloat("handle_y", fraction).apply();
                    tracking = dragging = false;
                    position(); setPressed(false); setAlpha(.38f);
                    if (clicked) performClick();
                    return true;
                case MotionEvent.ACTION_CANCEL:
                    cancelGesture();
                    return true;
                default:
                    return true;
            }
        }

        @Override public boolean performClick() { super.performClick(); return true; }
    }
    private static Button button(Activity activity, LinearLayout parent, String label) {
        Button button = new Button(activity);
        button.setText(label); button.setContentDescription(label); button.setTextSize(12);
        button.setAllCaps(false);
        button.setTextColor(Color.WHITE); button.setBackgroundColor(Color.TRANSPARENT);
        button.setMinWidth(0); button.setMinimumWidth(0); button.setFocusable(false);
        int padding = Math.round(12 * activity.getResources().getDisplayMetrics().density);
        button.setPadding(padding, 0, padding, 0);
        if (parent.getOrientation() == LinearLayout.VERTICAL) {
            float density = activity.getResources().getDisplayMetrics().density;
            button.setTextSize(11);
            button.setMinHeight(0); button.setMinimumHeight(0);
            button.setMaxLines(3);
            button.setPadding(Math.round(2 * density), 0, Math.round(2 * density), 0);
            StateListDrawable background = new StateListDrawable();
            for (boolean pressed : new boolean[]{true, false}) {
                GradientDrawable surface = new GradientDrawable();
                surface.setColor(pressed ? 0xFF284D73 : 0xFF111D2C);
                surface.setCornerRadius(8 * density);
                background.addState(pressed ? new int[]{android.R.attr.state_pressed} : new int[]{}, surface);
            }
            button.setBackground(background);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, Math.round(48 * density));
            params.bottomMargin = Math.round(4 * density);
            parent.addView(button, params);
        } else {
            parent.addView(button, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.MATCH_PARENT));
        }
        return button;
    }
    private static void shortcut(Activity activity, LinearLayout tools, Controller controller,
                                 DesktopInput input, String label, int... keys) {
        button(activity, tools, label).setOnClickListener(v -> {
            if (controller.canSend()) input.tap(keys);
        });
    }

}
