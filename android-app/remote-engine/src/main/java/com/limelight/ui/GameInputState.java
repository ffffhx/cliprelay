package com.limelight.ui;

import java.util.HashMap;
import java.util.Comparator;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/** Held keyboard state shared by simultaneous touches. All calls belong to the UI thread. */
public final class GameInputState {
    private static final Comparator<Integer> KEY_ORDER = Comparator.comparingInt(
            key -> (key >= 0x10 && key <= 0x12) || key == 0x5B || key == 0x5C ? key - 256 : key);
    public interface KeySink {
        void send(int virtualKey, boolean down, int modifiers);
    }

    private final KeySink sink;
    private final Map<String, Set<Integer>> sources = new HashMap<>();
    private final TreeSet<Integer> held = new TreeSet<>();
    private boolean enabled;

    public GameInputState(KeySink sink) { this.sink = sink; }

    public boolean isEnabled() { return enabled; }

    public void setEnabled(boolean enabled) {
        if (!enabled) releaseAll();
        this.enabled = enabled;
    }

    public void update(String source, int... keys) {
        if (!enabled) return;
        TreeSet<Integer> next = new TreeSet<>();
        for (int key : keys) {
            if (key <= 0 || key > 255) throw new IllegalArgumentException("Invalid keyboard key");
            next.add(key);
        }
        if (next.isEmpty()) sources.remove(source);
        else sources.put(source, next);
        TreeSet<Integer> target = new TreeSet<>();
        for (Set<Integer> sourceKeys : sources.values()) target.addAll(sourceKeys);
        reconcile(target);
    }

    public void releaseAll() {
        sources.clear();
        reconcile(new TreeSet<>());
    }

    private void reconcile(TreeSet<Integer> target) {
        // Release ordinary keys before modifiers; press modifiers before ordinary keys.
        TreeSet<Integer> ordered = new TreeSet<>(KEY_ORDER);
        ordered.addAll(held);
        for (int key : ordered.descendingSet()) {
            if (!target.contains(key)) {
                held.remove(key);
                sink.send(key, false, modifiers());
            }
        }
        ordered.clear();
        ordered.addAll(target);
        for (int key : ordered) {
            if (held.add(key)) sink.send(key, true, modifiers());
        }
    }

    private int modifiers() {
        return (held.contains(0x10) ? 1 : 0) | (held.contains(0x11) ? 2 : 0) |
                (held.contains(0x12) ? 4 : 0) | (held.contains(0x5B) || held.contains(0x5C) ? 8 : 0);
    }

    /** Eight-way movement with a radial dead zone and diagonal sectors. */
    public static int direction(float x, float y) {
        if (!Float.isFinite(x) || !Float.isFinite(y) || x * x + y * y < 0.04f) return 0;
        int horizontal = Math.abs(x) >= Math.abs(y) * 0.45f ? (x < 0 ? 1 : 2) : 0;
        int vertical = Math.abs(y) >= Math.abs(x) * 0.45f ? (y < 0 ? 4 : 8) : 0;
        return horizontal | vertical;
    }
}
