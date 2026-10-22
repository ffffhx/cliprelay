package com.limelight.ui;

import java.util.LinkedHashSet;
import java.util.Set;

/** Selected modifiers remain local until a key chord or mouse click is sent. */
public final class VirtualKeyboardState {
    public interface ReleaseScheduler { void afterMouseUp(Runnable release); }
    private final GameInputState keyboard;
    private final ReleaseScheduler releaseScheduler;
    private final Set<Integer> selected = new LinkedHashSet<>();
    private boolean enabled, clickPending;
    private long generation;

    public VirtualKeyboardState(GameInputState.KeySink sink) { this(sink, Runnable::run); }
    public VirtualKeyboardState(GameInputState.KeySink sink, ReleaseScheduler releaseScheduler) {
        keyboard = new GameInputState(sink);
        this.releaseScheduler = releaseScheduler;
    }
    public static boolean isModifier(int key) { return key == 0x10 || key == 0x11 || key == 0x12 || key == 0x5B; }
    public boolean isSelected(int key) { return selected.contains(key); }
    public boolean hasModifiers() { return enabled && !clickPending && !selected.isEmpty(); }
    public boolean isClickPending() { return clickPending; }
    /** Keep modifiers down through both mouse events, then release even on failure. */
    public void clickWithModifiers(Runnable click) {
        if (!hasModifiers()) return;
        int[] modifiers = new int[selected.size()];
        int i = 0;
        for (int key : selected) modifiers[i++] = key;
        boolean scheduled = false;
        try {
            keyboard.update("virtual-keyboard", modifiers);
            click.run();
            selected.clear();
            clickPending = true;
            long clickGeneration = ++generation;
            releaseScheduler.afterMouseUp(() -> {
                if (generation == clickGeneration) clear();
            });
            scheduled = true;
        } finally { if (!scheduled) clear(); }
    }
    public void setEnabled(boolean value) {
        enabled = value; keyboard.setEnabled(value);
        if (!value) clear();
    }
    public void press(int key) {
        if (!enabled || clickPending) return;
        if (isModifier(key)) {
            if (!selected.remove(key)) selected.add(key);
            return;
        }
        int[] chord = new int[selected.size() + 1];
        int i = 0;
        for (int modifier : selected) chord[i++] = modifier;
        chord[i] = key;
        try { keyboard.update("virtual-keyboard", chord); }
        finally { clear(); }
    }
    /** Long press on a modifier sends that key alone (for example the Windows menu). */
    public void pressAlone(int key) {
        if (!enabled || clickPending) return;
        try { keyboard.update("virtual-keyboard", key); }
        finally { clear(); }
    }
    public void clear() { generation++; clickPending = false; selected.clear(); keyboard.releaseAll(); }
}
