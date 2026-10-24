package com.limelight.ui;

import android.app.Activity;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.*;
import android.graphics.drawable.*;
import android.os.SystemClock;
import android.view.*;
import android.widget.*;
import com.limelight.R;
import java.util.function.IntConsumer;

/** Phone and tablet controls share a 24-unit, round-stroke icon vocabulary. */
final class DesktopToolbarStyle {
    enum Icon { PHONE, KEYBOARD, MIC, IMAGE, HOME, ENTER, UP, BACKSPACE, ESC, MORE,
        MODE, WIN, CUSTOM, COPY, PASTE, SELECT, TOUCH, UNDO, REDO, SCROLL_UP,
        SCROLL_DOWN, STATS, DISCONNECT, FILES, DISPLAY, CLIPBOARD, PRIVACY, TERMINAL, WAVE }
    enum Tone {
        BLUE(0xFF79B6FF, 0xFF172C44), PURPLE(0xFFBCA5FF, 0xFF2B2442),
        TEAL(0xFF65DCC3, 0xFF153730), AMBER(0xFFF2C578, 0xFF352D20),
        NEUTRAL(0xFFECF2FA, 0xFF17202E);
        final int ink, background;
        Tone(int ink, int background) { this.ink = ink; this.background = background; }
    }

    private static int dp(Context context, float value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
    private static GradientDrawable surface(Context context, int color, int stroke) {
        GradientDrawable result = new GradientDrawable();
        result.setColor(color); result.setCornerRadius(dp(context, 8));
        if (stroke != 0) result.setStroke(dp(context, 1), stroke);
        return result;
    }
    private static Drawable background(Context context, Tone tone) {
        StateListDrawable states = new StateListDrawable();
        states.addState(new int[]{android.R.attr.state_selected}, surface(context, tone.background, tone.ink));
        states.addState(new int[]{}, surface(context, tone.background, 0));
        return new RippleDrawable(ColorStateList.valueOf(0x30FFFFFF), states,
                surface(context, Color.WHITE, 0));
    }

    static Drawable icon(Context context, Icon kind, int color) {
        Drawable result = new Glyph(kind, color);
        result.setBounds(0, 0, dp(context, 20), dp(context, 20));
        return result;
    }
    static void apply(Button button, String label, Icon kind, Tone tone) {
        Context context = button.getContext();
        button.setText(label); button.setContentDescription(label); button.setTooltipText(label);
        button.setTextSize(12); button.setAllCaps(false); button.setSingleLine(true);
        button.setTextColor(tone.ink); button.setIncludeFontPadding(false);
        button.setGravity(Gravity.CENTER);
        button.setPadding(dp(context, 10), 0, dp(context, 10), 0);
        button.setCompoundDrawablePadding(dp(context, 6));
        button.setCompoundDrawablesRelative(icon(context, kind, tone.ink), null, null, null);
        button.setBackgroundTintList(null); button.setBackground(background(context, tone));
        LinearLayout.LayoutParams placement = (LinearLayout.LayoutParams) button.getLayoutParams();
        placement.setMargins(dp(context, 4), dp(context, 3), dp(context, 4), dp(context, 3));
        button.setLayoutParams(placement);
    }
    static void applyRail(Button button, String label, Icon kind, Tone tone) {
        apply(button, label, kind, tone);
        Context context = button.getContext();
        button.setPadding(dp(context, 2), dp(context, 4), dp(context, 2), dp(context, 4));
        button.setSingleLine(false); button.setMaxLines(2);
        button.setAutoSizeTextTypeUniformWithConfiguration(9, 11, 1, android.util.TypedValue.COMPLEX_UNIT_SP);
        button.setCompoundDrawablePadding(dp(context, 3));
        button.setCompoundDrawablesRelative(null, icon(context, kind, tone.ink), null, null);
        LinearLayout.LayoutParams placement = (LinearLayout.LayoutParams) button.getLayoutParams();
        placement.height = dp(context, 52);
        placement.setMargins(0, 0, 0, dp(context, 4));
        button.setLayoutParams(placement);
    }
    static void animate(Button button, boolean start) {
        for (Drawable drawable : button.getCompoundDrawablesRelative()) {
            if (drawable instanceof Animatable) {
                if (start) ((Animatable)drawable).start(); else ((Animatable)drawable).stop();
            }
        }
    }

    private static final Icon[] MENU_ICONS = {Icon.MODE, Icon.WIN, Icon.CUSTOM,
            Icon.COPY, Icon.PASTE, Icon.CLIPBOARD, Icon.SELECT, Icon.TOUCH, Icon.UNDO, Icon.REDO,
            Icon.SCROLL_UP, Icon.SCROLL_DOWN, Icon.STATS, Icon.DISCONNECT,
            Icon.FILES, Icon.DISPLAY, Icon.CLIPBOARD, Icon.PRIVACY, Icon.TERMINAL, Icon.MIC};

    static PopupWindow showMore(Activity activity, View anchor, String[] labels, boolean sideRail, IntConsumer selected) {
        LinearLayout body = new LinearLayout(activity);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(dp(activity, 12), dp(activity, 8), dp(activity, 12), dp(activity, 12));
        body.setBackground(surface(activity, 0xFF111A27, 0));
        PopupWindow popup = new PopupWindow(body, 0, 0, true);
        LinearLayout heading = new LinearLayout(activity);
        heading.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = new TextView(activity);
        title.setText(R.string.desktop_more); title.setTextSize(18); title.setTextColor(Color.WHITE);
        title.setTypeface(null, Typeface.BOLD); title.setPadding(dp(activity, 8), 0, 0, 0);
        heading.addView(title, new LinearLayout.LayoutParams(0, dp(activity, 44), 1));
        Button close = new Button(activity); close.setText("×"); close.setTextSize(22);
        close.setContentDescription(activity.getString(android.R.string.cancel)); close.setTextColor(0xFF9EB0C6);
        close.setMinWidth(0); close.setMinimumWidth(0); close.setPadding(0, 0, 0, 0);
        close.setBackgroundColor(Color.TRANSPARENT); close.setOnClickListener(v -> popup.dismiss());
        heading.addView(close, new LinearLayout.LayoutParams(dp(activity, 48), dp(activity, 48)));
        body.addView(heading);
        ScrollView scroll = new ScrollView(activity); scroll.setFillViewport(false);
        LinearLayout items = new LinearLayout(activity); items.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(items); body.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        for (int i = 0; i < labels.length; i++) {
            final int index = i;
            LinearLayout row;
            if (i < 3 || (i - 3) % 2 == 0) {
                row = new LinearLayout(activity);
                items.addView(row, new LinearLayout.LayoutParams(-1, dp(activity, i < 3 ? 52 : 46)));
                if (i == 3) row.setPadding(0, dp(activity, 4), 0, 0);
            } else row = (LinearLayout) items.getChildAt(items.getChildCount() - 1);
            Button button = new Button(activity);
            button.setMinWidth(0); button.setMinimumWidth(0); button.setMinHeight(0); button.setMinimumHeight(0);
            row.addView(button, new LinearLayout.LayoutParams(0, -1, 1));
            apply(button, labels[i], i < MENU_ICONS.length ? MENU_ICONS[i] : Icon.MORE, Tone.NEUTRAL);
            button.setTextSize(13); button.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
            button.setSingleLine(false); button.setMaxLines(2);
            button.setOnClickListener(v -> { popup.dismiss(); selected.accept(index); });
        }
        Rect safe = new Rect(); anchor.getWindowVisibleDisplayFrame(safe);
        int[] position = new int[2]; anchor.getLocationOnScreen(position);
        int width = Math.min(dp(activity, 420), safe.width() - dp(activity, 16));
        int height = Math.min(dp(activity, 602), Math.max(dp(activity, 120),
                safe.height() - (sideRail ? dp(activity, 16) : anchor.getHeight() + dp(activity, 24))));
        popup.setWidth(width); popup.setHeight(height);
        popup.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        popup.setElevation(dp(activity, 18)); popup.setOutsideTouchable(true);
        int left = Math.max(safe.left + dp(activity, 8), Math.min(position[0] + anchor.getWidth() - width, safe.right - width - dp(activity, 8)));
        int top = Math.max(safe.top + dp(activity, 8), position[1] - height - dp(activity, 8));
        if (sideRail) {
            left = Math.max(safe.left + dp(activity, 8), position[0] - width - dp(activity, 8));
            top = safe.top + dp(activity, 8);
        }
        popup.showAtLocation(anchor, Gravity.TOP | Gravity.LEFT, left, top);
        return popup;
    }

    private static final class Glyph extends Drawable implements Animatable, Runnable {
        private final Icon kind;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();
        private boolean running;
        Glyph(Icon kind, int color) {
            this.kind = kind; paint.setColor(color); paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(1.8f); paint.setStrokeCap(Paint.Cap.ROUND); paint.setStrokeJoin(Paint.Join.ROUND);
        }
        private void line(Canvas c, float... p) {
            path.reset(); path.moveTo(p[0], p[1]);
            for (int i = 2; i < p.length; i += 2) path.lineTo(p[i], p[i+1]);
            c.drawPath(path, paint);
        }
        private void box(Canvas c, float x, float y, float w, float h, float radius) {
            c.drawRoundRect(x, y, x+w, y+h, radius, radius, paint);
        }
        private void dot(Canvas c, float x, float y, float radius) {
            paint.setStyle(Paint.Style.FILL); c.drawCircle(x, y, radius, paint); paint.setStyle(Paint.Style.STROKE);
        }
        @Override public void draw(Canvas c) {
            int save = c.save(); Rect b = getBounds(); c.translate(b.left, b.top); c.scale(b.width()/24f, b.height()/24f);
            switch (kind) {
                case PHONE:
                    box(c,5,1,14,22,3); line(c,10,4,14,4); line(c,10,19,14,19);
                    line(c,12,8,12,15); line(c,10,8,14,8); line(c,10,15,14,15); break;
                case KEYBOARD: case CUSTOM:
                    box(c,1,4,22,16,3);
                    for (int x=5;x<=20;x+=5) { dot(c,x,8,.7f); dot(c,x,12,.7f); }
                    line(c,7,16,17,16);
                    if(kind==Icon.CUSTOM) {line(c,17,1,17,7);line(c,14,4,20,4);} break;
                case MIC:
                    box(c,8,1,8,14,4); line(c,4,10,4,13,6,17,10,19,14,19,18,17,20,13,20,10);
                    line(c,12,19,12,23);line(c,8,23,16,23);break;
                case IMAGE:
                    box(c,2,2,20,20,3);c.drawCircle(8,8,2,paint);line(c,3,18,9,12,13,16,17,11,22,17);break;
                case HOME: line(c,8,5,2,11,8,17);line(c,2,11,15,11);line(c,13,4,22,4,22,21,13,21);break;
                case ENTER: line(c,20,3,20,14,4,14);line(c,10,8,4,14,10,20);break;
                case UP: case SCROLL_UP: line(c,12,21,12,3);line(c,5,10,12,3,19,10);break;
                case SCROLL_DOWN: line(c,12,3,12,21);line(c,5,14,12,21,19,14);break;
                case BACKSPACE: line(c,21,12,3,12);line(c,10,5,3,12,10,19);break;
                case ESC:
                    box(c,1,4,22,16,3);paint.setStyle(Paint.Style.FILL);paint.setTextSize(7);paint.setTypeface(Typeface.DEFAULT_BOLD);
                    paint.setTextAlign(Paint.Align.CENTER);c.drawText("Esc",12,14.5f,paint);paint.setStyle(Paint.Style.STROKE);break;
                case MORE: dot(c,4,12,1.7f);dot(c,12,12,1.7f);dot(c,20,12,1.7f);break;
                case MODE: box(c,2,3,20,7,3);box(c,2,14,20,7,3);dot(c,7,6.5f,1.4f);dot(c,17,17.5f,1.4f);break;
                case WIN:
                    paint.setStyle(Paint.Style.FILL);
                    for(int x=2;x<=14;x+=12)for(int y=2;y<=14;y+=12)box(c,x,y,8,8,1);
                    paint.setStyle(Paint.Style.STROKE);break;
                case COPY: box(c,8,7,13,15,2);line(c,15,3,3,3,3,16);break;
                case PASTE: case CLIPBOARD:
                    box(c,4,4,16,18,2);box(c,8,1,8,5,2);
                    if(kind==Icon.CLIPBOARD){line(c,8,11,16,11);line(c,8,16,14,16);}break;
                case SELECT: box(c,2,2,20,20,2);line(c,6,12,10,16,18,8);break;
                case TOUCH: line(c,8,13,8,3,10,1,12,3,12,11,18,9,21,12,20,19,17,23,9,23,3,16,4,13,8,16);break;
                case UNDO: case REDO:
                    if(kind==Icon.REDO){c.translate(24,0);c.scale(-1,1);}
                    line(c,4,9,13,9,18,11,20,16,18,21);line(c,8,4,3,9,8,14);break;
                case STATS: line(c,2,20,22,20);line(c,5,17,5,11);line(c,12,17,12,4);line(c,19,17,19,8);break;
                case DISCONNECT: line(c,9,2,9,8,15,8,15,2);line(c,5,8,19,8,19,13,15,18,12,18,12,23);line(c,2,2,22,22);break;
                case FILES: line(c,2,6,2,21,22,21,22,6,12,6,9,3,2,3,2,6);break;
                case DISPLAY: box(c,1,2,22,15,2);line(c,12,17,12,22);line(c,7,22,17,22);break;
                case PRIVACY: line(c,12,1,21,5,20,15,16,21,12,23,8,21,4,15,3,5,12,1);line(c,8,12,11,15,17,9);break;
                case TERMINAL: box(c,1,3,22,18,2);line(c,5,8,9,12,5,16);line(c,12,16,18,16);break;
                case WAVE:
                    for(int i=0;i<5;i++){
                        float height=5+(float)(.5+.5*Math.sin(SystemClock.uptimeMillis()/150.0+i*1.7))*15;
                        line(c,3+i*4.5f,12-height/2,3+i*4.5f,12+height/2);
                    }break;
            }
            c.restoreToCount(save);
        }
        @Override public void start(){if(kind!=Icon.WAVE||running)return;running=true;run();}
        @Override public void stop(){running=false;unscheduleSelf(this);}
        @Override public boolean isRunning(){return running;}
        @Override public void run(){if(!running)return;invalidateSelf();scheduleSelf(this,SystemClock.uptimeMillis()+64);}
        @Override public void setAlpha(int alpha){paint.setAlpha(alpha);invalidateSelf();}
        @Override public void setColorFilter(ColorFilter filter){paint.setColorFilter(filter);invalidateSelf();}
        @Override public int getOpacity(){return PixelFormat.TRANSLUCENT;}
    }
}
