package com.limelight.ui;

import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.widget.Button;
import java.util.function.BooleanSupplier;

/** A remote key repeats as complete taps, with no held key left on the host. */
final class RepeatingButton implements View.OnTouchListener, View.OnAttachStateChangeListener {
    private final Button button;
    private final BooleanSupplier available;
    private final Runnable press;
    private boolean held;
    private final Runnable repeat = new Runnable() {
        public void run() {
            if (!held || !available.getAsBoolean() || !button.isShown() || !button.isEnabled()) {
                cancel(); return;
            }
            press.run();
            if (held) button.postDelayed(this, 60);
        }
    };

    RepeatingButton(Button button, BooleanSupplier available, Runnable press) {
        this.button = button; this.available = available; this.press = press;
        button.setOnClickListener(v -> { if (available.getAsBoolean()) press.run(); });
        button.setOnTouchListener(this);
        button.addOnAttachStateChangeListener(this);
    }

    public boolean onTouch(View view, MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                cancel();
                if (!available.getAsBoolean() || !button.isEnabled()) return true;
                held = true; button.setPressed(true);
                button.performClick();
                button.postDelayed(repeat, ViewConfiguration.getLongPressTimeout());
                break;
            case MotionEvent.ACTION_MOVE:
                if (event.getX() < 0 || event.getY() < 0
                        || event.getX() >= button.getWidth() || event.getY() >= button.getHeight()) cancel();
                break;
            case MotionEvent.ACTION_POINTER_DOWN:
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                cancel();
                break;
        }
        return true;
    }

    void cancel() {
        held = false; button.removeCallbacks(repeat); button.setPressed(false);
    }
    public void onViewAttachedToWindow(View view) {}
    public void onViewDetachedFromWindow(View view) { cancel(); }
}
