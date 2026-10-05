package com.limelight.ui;

import com.limelight.R;

/** Explicit user-selected layouts; selecting one never launches or submits to an app. */
public enum DesktopProfile {
    GENERAL("general", R.string.desktop_profile_general),
    CHATGPT("chatgpt", R.string.desktop_profile_chatgpt),
    ORCA("orca", R.string.desktop_profile_orca);

    public final String id;
    public final int label;
    DesktopProfile(String id, int label) { this.id = id; this.label = label; }
    public boolean isChat() { return this != GENERAL; }
    public static DesktopProfile fromId(String id) {
        for (DesktopProfile profile : values()) if (profile.id.equals(id)) return profile;
        return GENERAL;
    }
}
