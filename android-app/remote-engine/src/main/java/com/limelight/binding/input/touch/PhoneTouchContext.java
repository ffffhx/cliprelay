package com.limelight.binding.input.touch;

import android.os.Build;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import com.limelight.nvstream.jni.MoonBridge;

/** Sends real touchscreen contacts. Windows and the target application interpret the gestures. */
public final class PhoneTouchContext {
    public interface TapListener { void tapped(float x, float y); }
    private final NativeTouchState state;
    private final View video;
    private final Runnable unsupported;
    private final TapListener tapped;
    private final int touchSlop;
    private float downX, downY;
    private long downTime;
    private boolean tapCandidate;
    private boolean ignoredGesture;
    private final int[] sourceLocation = new int[2];
    private final int[] videoLocation = new int[2];

    public PhoneTouchContext(View video, NativeTouchState.Sink sink, Runnable unsupported) {
        this(video, sink, unsupported, (x, y) -> {});
    }

    public PhoneTouchContext(View video, NativeTouchState.Sink sink, Runnable unsupported, TapListener tapped) {
        this.video = video;
        this.state = new NativeTouchState(sink);
        this.unsupported = unsupported;
        this.tapped = tapped;
        this.touchSlop = ViewConfiguration.get(video.getContext()).getScaledTouchSlop();
    }

    public void cancel() {
        tapCandidate = false; ignoredGesture = true;
        state.cancel();
    }

    public boolean onTouch(View source, MotionEvent event) {
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_CANCEL || video.getWidth() == 0 || video.getHeight() == 0) {
            cancel();
            return true;
        }
        if (action == MotionEvent.ACTION_DOWN) {
            state.begin(); downX = event.getX(); downY = event.getY(); downTime = event.getEventTime(); tapCandidate = true;
            ignoredGesture = false;
        }
        if (event.getPointerCount() > 1 || Math.abs(event.getX() - downX) > touchSlop ||
                Math.abs(event.getY() - downY) > touchSlop) tapCandidate = false;
        float dx = 0, dy = 0;
        if (source != null && source != video) {
            source.getLocationOnScreen(sourceLocation);
            video.getLocationOnScreen(videoLocation);
            dx = sourceLocation[0] - videoLocation[0];
            dy = sourceLocation[1] - videoLocation[1];
        }
        if (ignoredGesture) return true;
        if (action == MotionEvent.ACTION_MOVE) {
            for (int i = 0; i < event.getPointerCount(); i++) {
                state.move(event.getPointerId(i), (event.getX(i) + dx) / video.getWidth(),
                        (event.getY(i) + dy) / video.getHeight());
            }
        } else {
            int i = event.getActionIndex();
            int id = event.getPointerId(i);
            float x = (event.getX(i) + dx) / video.getWidth();
            float y = (event.getY(i) + dy) / video.getHeight();
            if (action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_POINTER_DOWN) {
                if (x < 0 || x > 1 || y < 0 || y > 1) tapCandidate = false;
                if (state.down(id, x, y) == MoonBridge.LI_ERR_UNSUPPORTED) { tapCandidate = false; unsupported.run(); }
            } else if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_POINTER_UP) {
                state.up(id, x, y, Build.VERSION.SDK_INT >= 33 && (event.getFlags() & MotionEvent.FLAG_CANCELED) != 0);
                if (action == MotionEvent.ACTION_UP) {
                    boolean tap = tapCandidate && event.getEventTime() - downTime < ViewConfiguration.getLongPressTimeout()
                            && !(Build.VERSION.SDK_INT >= 33 && (event.getFlags() & MotionEvent.FLAG_CANCELED) != 0);
                    cancel();
                    if (tap) tapped.tapped(x, y);
                }
            }
        }
        return true;
    }
}
