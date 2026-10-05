package com.limelight.ui;

import android.content.Context;
import com.limelight.Game;
import java.lang.ref.WeakReference;
import java.util.concurrent.CopyOnWriteArrayList;

/** A shortcut to the existing stream; never retains a stopped Activity or starts a replacement. */
public final class LiveStreamSession {
    private static WeakReference<Game> current = new WeakReference<>(null);
    private static final CopyOnWriteArrayList<Runnable> listeners = new CopyOnWriteArrayList<>();
    private LiveStreamSession() {}
    public static boolean isActive() {
        Game game = current.get();
        return game != null && game.isStreamConnected();
    }
    public static void connected(Game game) {
        current = new WeakReference<>(game);
        for (Runnable listener : listeners) listener.run();
    }
    public static void clear(Game game) {
        if (current.get() != game) return;
        current.clear();
        for (Runnable listener : listeners) listener.run();
    }
    public static boolean resume(Context context) {
        Game game = current.get();
        if (game == null || !game.isStreamConnected()) return false;
        // Game owns a separate singleTask stack, so launching its component
        // expands that exact PiP activity instead of rearranging the home stack.
        game.resumeFromClipRelay(context);
        return true;
    }
    public static void addListener(Runnable listener) { listeners.add(listener); listener.run(); }
    public static void removeListener(Runnable listener) { listeners.remove(listener); }
}
