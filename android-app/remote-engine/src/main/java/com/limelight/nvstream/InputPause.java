package com.limelight.nvstream;

import java.util.HashSet;
import java.util.HashMap;
import java.util.Set;

/** Releases held remote input before changing capture and discards input while waiting. */
public final class InputPause {
    public static final int DISPLAY = 1, NETWORK = 2;
    public interface Releases {
        void key(short key);
        void button(byte button);
        void touches();
        void pen();
        void controller(short number, short activeMask);
        void controllerTouch(byte number, int pointer, float x, float y);
    }
    private final Set<Short> keys = new HashSet<>();
    private final Set<Byte> buttons = new HashSet<>();
    private final HashMap<Long, Contact> contacts = new HashMap<>();
    private boolean paused, touched, penned;
    private int reasons;
    private short controllers;

    private static final class Contact {
        byte number; int pointer; float x, y;
        Contact(byte number, int pointer, float x, float y) {
            this.number = number; this.pointer = pointer; this.x = x; this.y = y;
        }
    }

    // The connection serializes calls with the native sends on the same monitor.
    public boolean allowed() { return !paused; }
    public boolean key(short key, boolean down) {
        if (paused) return false;
        if (down) keys.add(key); else keys.remove(key);
        return true;
    }
    public boolean button(byte button, boolean down) {
        if (paused) return false;
        if (down) buttons.add(button); else buttons.remove(button);
        return true;
    }
    public boolean touch() { if (paused) return false; touched = true; return true; }
    public boolean pen() { if (paused) return false; penned = true; return true; }
    public boolean controller(short mask) { if (paused) return false; controllers = mask; return true; }
    public boolean controllerTouch(byte number, byte event, int pointer, float x, float y) {
        if (paused) return false;
        long id = ((long)(number & 255) << 32) | Integer.toUnsignedLong(pointer);
        if (event == 7) contacts.entrySet().removeIf(entry -> entry.getValue().number == number);
        else if (event == 2 || event == 4) contacts.remove(id); // UP or CANCEL
        else if (event == 1 || event == 3) contacts.put(id, new Contact(number, pointer, x, y)); // DOWN or MOVE
        return true;
    }

    public void setPaused(boolean value, Releases releases) {
        setPaused(DISPLAY, value, releases);
    }

    public void setPaused(int reason, boolean value, Releases releases) {
        if (reason != DISPLAY && reason != NETWORK) throw new IllegalArgumentException("Unknown pause reason");
        if (value) reasons |= reason; else reasons &= ~reason;
        value = reasons != 0;
        if (paused == value) return;
        paused = value;
        if (!value) return; // never replay a key press or gesture from the old screen
        for (short key : keys) releases.key(key);
        for (byte button : buttons) releases.button(button);
        if (touched) releases.touches();
        if (penned) releases.pen();
        for (short n = 0; n < 16; n++) if ((controllers & (1 << n)) != 0) releases.controller(n, controllers);
        for (Contact contact : contacts.values()) releases.controllerTouch(contact.number, contact.pointer, contact.x, contact.y);
        keys.clear(); buttons.clear(); contacts.clear(); touched = penned = false; controllers = 0;
    }
}
