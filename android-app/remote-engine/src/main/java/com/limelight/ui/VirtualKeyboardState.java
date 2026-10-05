package com.limelight.ui;

import java.util.LinkedHashSet;
import java.util.Set;

/** Selected modifiers remain local until an atomic key chord is sent. */
public final class VirtualKeyboardState {
    private final GameInputState keyboard;
    private final Set<Integer> selected = new LinkedHashSet<>();
    private boolean enabled;

    public VirtualKeyboardState(GameInputState.KeySink sink) { keyboard = new GameInputState(sink); }
    public static boolean isModifier(int key) { return key == 0x10 || key == 0x11 || key == 0x12 || key == 0x5B; }
    public boolean isSelected(int key) { return selected.contains(key); }
    public void setEnabled(boolean value) {
        enabled = value; keyboard.setEnabled(value);
        if (!value) clear();
    }
    public void press(int key) {
        if (!enabled) return;
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
        if (!enabled) return;
        try { keyboard.update("virtual-keyboard", key); }
        finally { clear(); }
    }
    public void clear() { selected.clear(); keyboard.releaseAll(); }
}
