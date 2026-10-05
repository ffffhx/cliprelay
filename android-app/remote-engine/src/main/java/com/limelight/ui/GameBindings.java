package com.limelight.ui;

import java.util.ArrayList;
import java.util.List;

/** Windows virtual-key bindings. Each game keeps its own saved controls. */
public final class GameBindings {
    public enum Profile {
        PLATEUP("plateup"), STARDEW("stardew");
        public final String id;
        Profile(String id) { this.id = id; }
        public static Profile fromId(String id) {
            for (Profile profile : values()) if (profile.id.equals(id)) return profile;
            return PLATEUP;
        }
    }
    public static final int UP = 0, DOWN = 1, LEFT = 2, RIGHT = 3;
    public static final int GRAB = 4, ACT = 5, READY = 6, CONFIRM = 7, PAUSE = 8;
    public static final int JOURNAL = 9, MAP = 10;
    public static final int[] DEFAULTS = {'W', 'S', 'A', 'D', 'P', 'O', 'K', 0x0D, 0x1B};
    private static final int[] STARDEW_DEFAULTS = {'W', 'S', 'A', 'D', 'C', 'X', 'E', 0x09, 0x1B, 'F', 'M'};
    public static final int[] INVENTORY_KEYS = {'1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 0xBD, 0xBB};
    public static int[] defaults(Profile profile) {
        return (profile == Profile.STARDEW ? STARDEW_DEFAULTS : DEFAULTS).clone();
    }
    public static String preferencesName(Profile profile) {
        // Keep the original name for PlateUp so existing custom bindings survive upgrades.
        return profile == Profile.PLATEUP ? "cliprelay_game_controls" : "cliprelay_game_controls_stardew";
    }
    public static final int[] OPTIONS;
    static {
        List<Integer> keys = new ArrayList<>();
        for (int key = 'A'; key <= 'Z'; key++) keys.add(key);
        for (int key = '0'; key <= '9'; key++) keys.add(key);
        for (int key : new int[]{0x20, 0x0D, 0x1B, 0x09, 0x10, 0x11, 0x12, 0x25, 0x26, 0x27, 0x28, 0xBD, 0xBB}) keys.add(key);
        OPTIONS = new int[keys.size()];
        for (int i = 0; i < keys.size(); i++) OPTIONS[i] = keys.get(i);
    }

    private GameBindings() {}

    public static int sanitize(int key, int fallback) {
        for (int option : OPTIONS) if (key == option) return key;
        return fallback;
    }

    public static String name(int key) {
        switch (key) {
            case 0x20: return "Space";
            case 0x0D: return "Enter";
            case 0x1B: return "Esc";
            case 0x09: return "Tab";
            case 0x10: return "Shift";
            case 0x11: return "Ctrl";
            case 0x12: return "Alt";
            case 0x25: return "←";
            case 0x26: return "↑";
            case 0x27: return "→";
            case 0x28: return "↓";
            case 0xBD: return "-";
            case 0xBB: return "=";
            default: return Character.toString((char) key);
        }
    }
}
