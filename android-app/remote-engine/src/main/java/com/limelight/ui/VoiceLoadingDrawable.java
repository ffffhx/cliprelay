package com.limelight.ui;

import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.Animatable;
import android.graphics.drawable.Drawable;
import android.os.SystemClock;

/** Small loading ring; its owning button stops it when detached or recording starts. */
final class VoiceLoadingDrawable extends Drawable implements Animatable, Runnable {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private boolean running;

    VoiceLoadingDrawable() {
        paint.setColor(0xFFFFD166);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeCap(Paint.Cap.ROUND);
    }

    @Override public void draw(Canvas canvas) {
        Rect bounds = getBounds();
        float width = Math.max(1, bounds.height() / 7f);
        float radius = (bounds.height() - width) / 2f;
        paint.setStrokeWidth(width);
        float cx = bounds.exactCenterX(), cy = bounds.exactCenterY();
        float angle = (SystemClock.uptimeMillis() % 900) * .4f;
        canvas.drawArc(cx - radius, cy - radius, cx + radius, cy + radius,
                angle, 260, false, paint);
    }
    @Override public void start() {
        if (running) return;
        running = true;
        run();
    }
    @Override public void stop() { running = false; unscheduleSelf(this); }
    @Override public boolean isRunning() { return running; }
    @Override public void run() {
        if (!running) return;
        invalidateSelf();
        scheduleSelf(this, SystemClock.uptimeMillis() + 32);
    }
    @Override public void setAlpha(int alpha) { paint.setAlpha(alpha); invalidateSelf(); }
    @Override public void setColorFilter(ColorFilter filter) { paint.setColorFilter(filter); invalidateSelf(); }
    @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
}
