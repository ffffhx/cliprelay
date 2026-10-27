package com.limelight.ui;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.InsetDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Build;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.content.Context;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.Toast;
import android.widget.PopupWindow;
import android.view.WindowInsets;
import java.util.function.IntConsumer;
import static com.limelight.ui.DesktopToolbarStyle.Icon;
import static com.limelight.ui.DesktopToolbarStyle.Tone;
import com.limelight.binding.input.ApplicationPolicy;
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
        default void scrollCompatibilityChanged(boolean enabled) {}
        default void pinchCompatibilityChanged(boolean enabled) {}
        default void virtualKeyboardChanged(boolean visible) {}
        default void image() {}
        default void files() {}
        default void terminal() {}
        default void displays() {}
        default void clipboard() {}
        default void pasteLocal(Runnable paste) {}
        default void privacy() {}
        default void voice() {}
        default void voiceSettings() {}
        default int voiceLabel() { return R.string.voice_input; }
        default void home() {}
        default void streamInfo() {}
    }

    public static final class Controller {
        private GameControlsView game;
        private HorizontalScrollView desktop;
        private Button collapseButton;
        private EdgeHandle handle;
        private Actions actions;
        private Button voiceButton;
        private Button phoneKeyboardButton, virtualKeyboardButton, moreButton;
        private PopupWindow morePopup;
        private RemoteVoiceInput.State voiceState = RemoteVoiceInput.State.IDLE;
        private Runnable rebuild;
        private String detectedApp;
        private VirtualKeyboardView virtualKeyboard;
        private boolean keyboardOpen;
        private DesktopSideRails sideRails;
        private CustomShortcutPanel shortcuts;
        private RepeatingButton backspaceRepeat;

        public boolean isSideRailsActive() { return sideRails != null && sideRails.isAvailable(); }
        private boolean isBottomDocked() {
            return sideRails != null && sideRails.bottomBounds() != null && !isSideRailsActive();
        }
        private void style(Button button, String label, Icon icon, Tone tone) {
            if (isSideRailsActive()) DesktopToolbarStyle.applyRail(button, label, icon, tone);
            else DesktopToolbarStyle.apply(button, label, icon, tone);
        }

        public void setVoiceState(RemoteVoiceInput.State state) {
            voiceState = state;
            updateVoiceButton();
        }
        private void updateVoiceButton() {
            if (voiceButton == null) return;
            DesktopToolbarStyle.animate(voiceButton, false);
            boolean active = voiceState != RemoteVoiceInput.State.IDLE;
            boolean stopping = voiceState == RemoteVoiceInput.State.STOPPING;
            boolean loading = voiceState == RemoteVoiceInput.State.STARTING || stopping;
            Context context = voiceButton.getContext();
            int label = voiceState == RemoteVoiceInput.State.LISTENING ? R.string.tablet_voice_stop
                    : voiceState == RemoteVoiceInput.State.STARTING ? R.string.tablet_voice_starting
                    : stopping ? R.string.tablet_voice_stopping : actions.voiceLabel();
            style(voiceButton, context.getString(label),
                    voiceState == RemoteVoiceInput.State.LISTENING ? Icon.WAVE : Icon.MIC,
                    loading ? Tone.AMBER : Tone.TEAL);
            if (loading) {
                Drawable spinner = new VoiceLoadingDrawable();
                int size = Math.round(20 * context.getResources().getDisplayMetrics().density);
                spinner.setBounds(0, 0, size, size);
                voiceButton.setCompoundDrawablesRelative(isSideRailsActive() ? null : spinner,
                        isSideRailsActive() ? spinner : null, null, null);
            }
            voiceButton.setSelected(active); voiceButton.setEnabled(!stopping); voiceButton.setAlpha(1f);
            voiceButton.setTooltipText(context.getString(R.string.speech_provider_hint_short));
            voiceButton.setContentDescription(context.getString(actions.voiceLabel())
                    + (active ? " · " + context.getString(label) : ""));
            if (voiceButton.isAttachedToWindow()) DesktopToolbarStyle.animate(voiceButton, true);
        }

        public boolean isVirtualKeyboardOpen() { return keyboardOpen; }
        public boolean hasClickModifiers() {
            return canSend() && focused && keyboardOpen && virtualKeyboard.hasModifiers();
        }
        public void clickWithModifiers(Runnable click) {
            if (hasClickModifiers()) virtualKeyboard.clickWithModifiers(click);
        }
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

        public void observeApplication(String app) {
            // The first identification after connecting is not an app switch.
            // Cancelling input here can discard the user's first tap/IME request.
            if (app == null) return;
            if (detectedApp != null && !app.equals(detectedApp)) {
                releaseTouches();
                actions.applicationChanged();
            }
            detectedApp = app;
            updateScrollCompatibility();
        }
        private void updateScrollCompatibility() {
            actions.scrollCompatibilityChanged(ApplicationPolicy.usesPhoneScrollCompatibility(detectedApp, gameMode));
            actions.pinchCompatibilityChanged(ApplicationPolicy.usesPhonePinchCompatibility(detectedApp, gameMode));
        }
        private boolean canSend() { return connected && !paused && !pip; }

        private boolean gameMode, connected, focused, paused, pip, expanded;

        public void setExpanded(boolean value) { expanded = value; update(); }
        public boolean isExpanded() { return expanded; }

        public boolean isGameMode() { return gameMode; }
        public void setGameMode(boolean enabled) {
            hideVirtualKeyboard();
            releaseTouches();
            if (gameMode != enabled) actions.applicationChanged();
            gameMode = enabled;
            updateScrollCompatibility();
            if (enabled) expanded = false;
            actions.gameModeChanged(enabled);
            update();
        }
        public void setConnected(boolean value) { connected = value; update(); }
        public void setFocused(boolean value) { focused = value; if (value) updateVoiceButton(); update(); }
        public void setPaused(boolean value) { paused = value; update(); }
        public void setPictureInPicture(boolean value) { pip = value; update(); }
        public void releaseTouches() {
            if (backspaceRepeat != null) backspaceRepeat.cancel();
            game.releaseTouches();
            if (virtualKeyboard != null) virtualKeyboard.clearModifiers();
        }
        private void update() {
            if (shortcuts != null && (!connected || paused || pip)) shortcuts.close();
            if (morePopup != null && (!connected || paused || pip)) { morePopup.dismiss(); morePopup = null; }
            boolean ready = connected && focused && !paused && !pip;
            if ((!ready || gameMode) && backspaceRepeat != null) backspaceRepeat.cancel();
            if (keyboardOpen && !ready) {
                keyboardOpen = false;
                actions.virtualKeyboardChanged(false);
            }
            Rect bottom = sideRails.bottomBounds();
            boolean docked = isBottomDocked();
            FrameLayout root = (FrameLayout) desktop.getParent();
            virtualKeyboard.setReservedBottom(docked && keyboardOpen ? root.getHeight() - bottom.top : 0);
            virtualKeyboard.setAvailable(ready && keyboardOpen);
            virtualKeyboard.setVisibility(keyboardOpen ? View.VISIBLE : View.GONE);
            game.setAvailable(ready && !keyboardOpen);
            game.setVisibility(gameMode && !pip && !keyboardOpen ? View.VISIBLE : View.GONE);
            boolean desktopVisible = !gameMode && !pip && (!keyboardOpen || docked);
            sideRails.setVisible(desktopVisible);
            if (virtualKeyboardButton != null) virtualKeyboardButton.setSelected(docked && keyboardOpen);
            if (phoneKeyboardButton != null && Build.VERSION.SDK_INT >= 30) {
                WindowInsets insets = root.getRootWindowInsets();
                phoneKeyboardButton.setSelected(insets != null && insets.isVisible(WindowInsets.Type.ime()));
            }
            boolean showExpanded = expanded || docked;
            collapseButton.setVisibility(docked ? View.GONE : View.VISIBLE);
            desktop.setFillViewport(docked);
            // Keep the toolbar in existing letterboxing, outside system bars and the IME.
            FrameLayout.LayoutParams placement = (FrameLayout.LayoutParams) desktop.getLayoutParams();
            int left = docked ? bottom.left - root.getPaddingLeft() : 0;
            int right = docked ? root.getWidth() - root.getPaddingRight() - bottom.right : 0;
            int below = docked ? root.getHeight() - root.getPaddingBottom() - bottom.bottom : 0;
            int height = docked ? bottom.height() : Math.round(44 * root.getResources().getDisplayMetrics().density);
            int width = docked ? FrameLayout.LayoutParams.MATCH_PARENT : FrameLayout.LayoutParams.WRAP_CONTENT;
            if (placement.leftMargin != left || placement.rightMargin != right || placement.bottomMargin != below
                    || placement.height != height || placement.width != width) {
                placement.leftMargin = left; placement.rightMargin = right; placement.bottomMargin = below;
                placement.height = height; placement.width = width;
                desktop.setLayoutParams(placement);
            }
            desktop.setVisibility(desktopVisible && !isSideRailsActive() && showExpanded ? View.VISIBLE : View.GONE);
            handle.setVisibility(desktopVisible && !isSideRailsActive() && !showExpanded ? View.VISIBLE : View.GONE);
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
        DesktopInput keyboard = new DesktopInput(sink);
        controller.shortcuts = new CustomShortcutPanel(activity, keyboard, controller::canSend, controller::releaseTouches);
        controller.game = new GameControlsView(activity, sink,
                () -> controller.setGameMode(false), actions::gamePointerModeChanged);
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
        controller.virtualKeyboard.attachTo(root);

        LinearLayout tools = new LinearLayout(activity);
        tools.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout endTools = new LinearLayout(activity);
        endTools.setOrientation(LinearLayout.HORIZONTAL);
        Button toggle = button(activity, bar, activity.getString(R.string.desktop_controls_collapse));
        controller.collapseButton = toggle;
        toggle.setId(R.id.desktopCollapseButton);
        bar.addView(tools);
        // Fill the free bottom border with two edge-aligned groups. On narrow
        // layouts the gap becomes zero and the existing scroll fallback remains.
        bar.addView(new View(activity), new LinearLayout.LayoutParams(0, 0, 1));
        bar.addView(endTools);
        toggle.setOnClickListener(v -> controller.setExpanded(false));
        controller.sideRails = new DesktopSideRails(activity, root, () -> {
            controller.rebuild.run();
            controller.update();
        });
        controller.rebuild = () -> {
            if (controller.backspaceRepeat != null) controller.backspaceRepeat.cancel();
            if (controller.morePopup != null) { controller.morePopup.dismiss(); controller.morePopup = null; }
            tools.removeAllViews();
            endTools.removeAllViews();
            controller.sideRails.clear();
            LinearLayout primary = controller.isSideRailsActive() ? controller.sideRails.leftButtons() : tools;
            LinearLayout secondary = controller.isSideRailsActive() ? controller.sideRails.rightButtons()
                    : controller.isBottomDocked() ? endTools : tools;
            Button home = button(activity, secondary, activity.getString(R.string.desktop_home));
            home.setId(R.id.desktopHomeButton);
            home.setOnClickListener(v -> { if (controller.canSend()) actions.home(); });
            boolean tablet = controller.isBottomDocked();
            bar.setBackgroundColor(tablet ? 0xFF0D1520 : 0xDD172033);
            controller.style(home, activity.getString(R.string.phone_computer_list), Icon.HOME, Tone.NEUTRAL);
            home.setContentDescription(activity.getString(R.string.desktop_home));
            home.setTooltipText(activity.getString(R.string.desktop_home));
            Button phone = button(activity, primary, activity.getString(R.string.virtual_keyboard_phone));
            controller.phoneKeyboardButton = phone;
            phone.setOnClickListener(v -> actions.keyboard());
            controller.style(phone, activity.getString(controller.isSideRailsActive()
                    ? R.string.phone_device_input : R.string.tablet_phone_input), Icon.PHONE, Tone.BLUE);
            phone.setContentDescription(activity.getString(R.string.tablet_phone_input));
            phone.setTooltipText(activity.getString(R.string.tablet_phone_input));
            Button virtual = button(activity, primary, activity.getString(R.string.virtual_keyboard));
            controller.virtualKeyboardButton = virtual;
            virtual.setId(R.id.virtualKeyboardButton);
            virtual.setOnClickListener(v -> { if (!tablet || !controller.hideVirtualKeyboard()) controller.showVirtualKeyboard(); });
            controller.style(virtual, activity.getString(R.string.tablet_computer_keyboard), Icon.KEYBOARD, Tone.PURPLE);
            Button voice = button(activity, primary, activity.getString(R.string.voice_input));
            voice.setId(R.id.desktopVoiceButton);
            voice.addOnAttachStateChangeListener(new View.OnAttachStateChangeListener() {
                public void onViewAttachedToWindow(View view) {
                    DesktopToolbarStyle.animate(voice, true);
                }
                public void onViewDetachedFromWindow(View view) {
                    DesktopToolbarStyle.animate(voice, false);
                }
            });
            controller.voiceButton = voice;
            controller.updateVoiceButton();
            voice.setOnClickListener(v -> { if (controller.canSend()) { controller.releaseTouches(); actions.voice(); } });
            voice.setOnLongClickListener(v -> { if (controller.canSend()) actions.voiceSettings(); return true; });
            voice.setTooltipText(activity.getString(R.string.speech_provider_hint_short));
            Button image = button(activity, primary, activity.getString(R.string.desktop_image));
            image.setId(R.id.desktopImageButton);
            image.setOnClickListener(v -> { if (controller.canSend()) actions.image(); });
            controller.style(image, activity.getString(R.string.desktop_image), Icon.IMAGE, Tone.AMBER);
            Button enter = shortcut(activity, secondary, controller, keyboard, "Enter", 0x0D);
            Button up = shortcut(activity, secondary, controller, keyboard, "Alt + \u2191", 0x12, 0x26);
            controller.style(enter, "Enter", Icon.ENTER, Tone.NEUTRAL);
            controller.style(up, "Alt + \u2191", Icon.UP, Tone.NEUTRAL);
            Button backspace = button(activity, secondary, activity.getString(R.string.desktop_backspace));
            controller.style(backspace, activity.getString(R.string.desktop_backspace), Icon.BACKSPACE, Tone.NEUTRAL);
            backspace.setId(R.id.desktopBackspaceButton);
            controller.backspaceRepeat = new RepeatingButton(backspace,
                    () -> controller.canSend() && controller.focused, () -> keyboard.tap(0x08));
            Button esc = shortcut(activity, secondary, controller, keyboard, "Esc", 0x1B);
            controller.style(esc, "Esc", Icon.ESC, Tone.NEUTRAL);
            // Keep More reachable even when the other right-hand controls must scroll.
            Button more = button(activity, controller.isSideRailsActive()
                    ? controller.sideRails.rightFooter() : secondary, activity.getString(R.string.desktop_more_button));
            controller.moreButton = more;
            controller.style(more, activity.getString(R.string.tablet_more), Icon.MORE, Tone.NEUTRAL);
            more.setId(R.id.desktopMoreButton);
            more.setOnClickListener(v -> showMore(activity, controller, keyboard, sink, actions));
        };
        controller.rebuild.run();
        controller.update();
        controller.updateScrollCompatibility();
        return controller;
    }

    private static void showProfileModes(Activity activity, Controller controller) {
        controller.releaseTouches();
        String[] labels = { activity.getString(R.string.desktop_profile_general),
                activity.getString(R.string.game_mode) };
        new AlertDialog.Builder(activity).setTitle(R.string.desktop_profile_title)
                .setSingleChoiceItems(labels, 0, (dialog, which) -> {
                    dialog.dismiss();
                    if (which == 1) {
                        if (!controller.canSend()) return;
                        controller.game.showProfiles(() -> {
                            if (controller.canSend()) controller.setGameMode(true);
                        });
                    } else controller.setGameMode(false);
                }).setNegativeButton(android.R.string.cancel, null).show();
    }

    private static void showMore(Activity activity, Controller controller, DesktopInput keyboard,
                                 DesktopInput.Sink sink, Actions actions) {
        controller.releaseTouches();
        String[] labels = {activity.getString(R.string.desktop_mode), activity.getString(R.string.desktop_win_key),
                activity.getString(R.string.shortcuts_title),
                activity.getString(R.string.desktop_copy), activity.getString(R.string.desktop_paste),
                activity.getString(R.string.desktop_paste_local),
                activity.getString(R.string.desktop_select_all),
                activity.getString(R.string.touch_mode_button, activity.getString(actions.touchMode().label)),
                activity.getString(R.string.desktop_undo), activity.getString(R.string.desktop_redo),
                activity.getString(R.string.desktop_scroll_up), activity.getString(R.string.desktop_scroll_down),
                activity.getString(R.string.stream_info_title), activity.getString(R.string.desktop_disconnect), activity.getString(R.string.files_title), activity.getString(R.string.displays_title), activity.getString(R.string.clipboard_title), activity.getString(R.string.privacy_title), activity.getString(R.string.terminal_title), activity.getString(R.string.speech_provider)};
        IntConsumer select = which -> {
                    if (which == 0) { showProfileModes(activity, controller); return; }
                    if (which == 7) { showTouchModes(activity, actions); return; }
                    if (which == 12) { actions.streamInfo(); return; }
                    if (which == 13) { actions.disconnect(); return; }
                    if (!controller.canSend()) return;
                    if (which == 2) { controller.shortcuts.show(); return; }
                    if (which == 5) {
                        actions.pasteLocal(() -> { if (controller.canSend()) keyboard.tap(0x11, 'V'); });
                        return;
                    }
                    if (which == 14) { actions.files(); return; }
                    if (which == 15) { actions.displays(); return; }
                    if (which == 16) { actions.clipboard(); return; }
                    if (which == 17) { actions.privacy(); return; }
                    if (which == 18) { actions.terminal(); return; }
                    if (which == 19) { actions.voiceSettings(); return; }
                    switch (which) {
                        case 1: keyboard.tap(0x5B); break;
                        case 3: keyboard.tap(0x11, 'C'); break;
                        case 4: keyboard.tap(0x11, 'V'); break;
                        case 6: keyboard.tap(0x11, 'A'); break;
                        case 8: keyboard.tap(0x11, 'Z'); break;
                        case 9: keyboard.tap(0x11, 'Y'); break;
                        case 10: sink.scroll((byte)3); break;
                        case 11: sink.scroll((byte)-3); break;
                    }
                };
        if (controller.isSideRailsActive() || controller.isBottomDocked()) {
            controller.morePopup = DesktopToolbarStyle.showMore(activity, controller.moreButton, labels,
                    controller.isSideRailsActive(), select);
        } else {
            new AlertDialog.Builder(activity).setTitle(R.string.desktop_more)
                    .setItems(labels, (dialog, which) -> { dialog.dismiss(); select.accept(which); })
                    .setNegativeButton(android.R.string.cancel, null).show();
        }
    }

    private static void showTouchModes(Activity activity, Actions actions) {
        new AlertDialog.Builder(activity).setTitle(R.string.touch_mode_title)
                .setSingleChoiceItems(R.array.touch_mode_entries, actions.touchMode().ordinal(), (dialog, which) -> {
                    TouchMode mode = TouchMode.values()[which];
                    actions.selectTouchMode(mode);
                    dialog.dismiss();
                    if (mode == TouchMode.PHONE) Toast.makeText(activity, R.string.touch_mode_phone_hint, Toast.LENGTH_LONG).show();
                })
                .setNeutralButton(R.string.touch_mode_help, (dialog, which) -> new AlertDialog.Builder(activity)
                        .setTitle(R.string.touch_mode_help).setMessage(activity.getString(R.string.touch_mode_help_body)
                                + "\n\n" + activity.getString(R.string.desktop_navigation_help))
                        .setPositiveButton(android.R.string.ok, null).show())
                .setNegativeButton(android.R.string.cancel, null).show();
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
        button.setTextColor(Color.WHITE);
        button.setMinWidth(0);
        if (parent.getOrientation() == LinearLayout.VERTICAL) {
            button.setTextSize(11);
            button.setMinHeight(0);
            button.setMaxLines(3);
        }
        placeButton(activity, parent, button);
        return button;
    }
    private static void placeButton(Activity activity, LinearLayout parent, View button) {
        button.setBackgroundColor(Color.TRANSPARENT);
        button.setMinimumWidth(0); button.setMinimumHeight(0); button.setFocusable(false);
        int padding = Math.round(12 * activity.getResources().getDisplayMetrics().density);
        button.setPadding(padding, 0, padding, 0);
        if (parent.getOrientation() == LinearLayout.VERTICAL) {
            float density = activity.getResources().getDisplayMetrics().density;
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
            parent.addView(button, new LinearLayout.LayoutParams(button instanceof ImageButton ? padding * 4
                    : LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.MATCH_PARENT));
        }
    }
    private static Button shortcut(Activity activity, LinearLayout tools, Controller controller,
                                 DesktopInput input, String label, int... keys) {
        Button result = button(activity, tools, label);
        result.setOnClickListener(v -> {
            if (controller.canSend()) input.tap(keys);
        });
        return result;
    }

}
