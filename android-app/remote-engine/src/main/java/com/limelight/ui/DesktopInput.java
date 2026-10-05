package com.limelight.ui;

/** Ordered, momentary shortcuts and chat text. Never leaves a modifier held. */
public final class DesktopInput {
    public interface Sink extends GameInputState.KeySink {
        void text(String value);
        void rightClick();
        void scroll(byte clicks);
    }

    private final Sink sink;
    private final GameInputState keyboard;

    public DesktopInput(Sink sink) {
        this.sink = sink;
        keyboard = new GameInputState(sink);
        keyboard.setEnabled(true);
    }

    public void tap(int... keys) {
        try { keyboard.update("shortcut", keys); }
        finally { keyboard.releaseAll(); }
    }

    public void type(String text, boolean chat, boolean submit) {
        if (text.isEmpty()) return;
        if (chat) {
            // Newline characters injected as text can act like Submit in desktop editors.
            // Send explicit Shift+Enter between lines, including trailing blank lines.
            String[] lines = text.replace("\r\n", "\n").replace('\r', '\n').split("\n", -1);
            for (int i = 0; i < lines.length; i++) {
                if (i > 0) tap(0x10, 0x0D);
                if (!lines[i].isEmpty()) sink.text(lines[i]);
            }
        } else {
            sink.text(text);
        }
        if (submit) tap(0x0D);
    }
}
