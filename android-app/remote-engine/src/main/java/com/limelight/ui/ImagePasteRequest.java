package com.limelight.ui;

/** Retained across stream recreation, consumed only once after the upload was acknowledged. */
public final class ImagePasteRequest {
    private boolean pending;

    public void uploaded() { pending = true; }
    public boolean isPending() { return pending; }

    public boolean dispatch(boolean connected, boolean resumed, boolean focused, boolean inPip,
                            GameInputState.KeySink sink) {
        if (!pending || !connected || !resumed || !focused || inPip) return false;
        pending = false;
        GameInputState keyboard = new GameInputState(sink);
        keyboard.setEnabled(true);
        try { keyboard.update("image-paste", 0x11, 'V'); }
        finally { keyboard.releaseAll(); }
        return true;
    }
}
