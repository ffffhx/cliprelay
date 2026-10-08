package com.limelight.binding.input.touch;

import android.animation.ValueAnimator;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.drawable.Drawable;
import android.view.View;

/** Local feedback for wheel-compatible gestures; never receives or sends input. */
public final class PhoneTouchFeedback extends Drawable implements PhoneTouchContext.ScrollFeedback {
    private final View video;
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint edge = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint halo = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final float radius;
    private float x, y;
    private int alpha;
    private ValueAnimator fade;

    public PhoneTouchFeedback(View video) {
        this.video = video;
        float density = video.getResources().getDisplayMetrics().density;
        radius = 10 * density;
        fill.setColor(0xffeeeeee);
        edge.setColor(0xff444444);
        edge.setStyle(Paint.Style.STROKE);
        edge.setStrokeWidth(density);
        halo.setColor(0xffffffff);
        halo.setStyle(Paint.Style.STROKE);
        halo.setStrokeWidth(3 * density);
        video.getOverlay().add(this);
    }

    @Override public void show(float x, float y) {
        if (!Float.isFinite(x) || !Float.isFinite(y)) { clear(); return; }
        stopFade();
        this.x = x;
        this.y = y;
        setBounds(0, 0, video.getWidth(), video.getHeight());
        setAlpha(255);
    }

    @Override public void release() {
        stopFade();
        if (alpha == 0) return;
        fade = ValueAnimator.ofInt(alpha, 0);
        fade.setDuration(280);
        fade.addUpdateListener(animation -> setAlpha((Integer)animation.getAnimatedValue()));
        fade.start();
    }

    @Override public void clear() {
        stopFade();
        setAlpha(0);
    }

    private void stopFade() {
        if (fade != null) {
            fade.cancel();
            fade.removeAllUpdateListeners();
            fade = null;
        }
    }

    @Override public void draw(Canvas canvas) {
        if (alpha == 0) return;
        fill.setAlpha(alpha * 2 / 5);
        halo.setAlpha(alpha / 2);
        edge.setAlpha(alpha * 3 / 4);
        canvas.drawCircle(x, y, radius, fill);
        canvas.drawCircle(x, y, radius, halo);
        canvas.drawCircle(x, y, radius, edge);
    }

    @Override public void setAlpha(int value) {
        alpha = Math.max(0, Math.min(255, value));
        invalidateSelf();
    }

    @Override public int getAlpha() { return alpha; }
    @Override public void setColorFilter(ColorFilter filter) {
        fill.setColorFilter(filter);
        edge.setColorFilter(filter);
        halo.setColorFilter(filter);
        invalidateSelf();
    }
    @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
}
