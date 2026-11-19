package com.limelight.herdr;

import android.app.Activity;
import android.app.Dialog;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.*;

/** Shared surfaces for Herdr's secondary flows, sized for a phone and its keyboard. */
final class HerdrSheet extends Dialog {
    final LinearLayout content,footer;
    final TextView subtitle;
    final HerdrPalette colors;
    private final Activity activity;
    HerdrSheet(Activity activity,String title,String caption){
        super(activity);this.activity=activity;colors=new HerdrPalette(activity);requestWindowFeature(Window.FEATURE_NO_TITLE);
        LinearLayout root=column();root.setPadding(dp(20),dp(10),dp(20),dp(16));root.setBackground(shape(colors.surface,24));
        View handle=new View(activity);handle.setBackground(shape(colors.outline,3));LinearLayout.LayoutParams grip=new LinearLayout.LayoutParams(dp(32),dp(4));grip.gravity=Gravity.CENTER_HORIZONTAL;grip.bottomMargin=dp(12);root.addView(handle,grip);
        LinearLayout header=row();TextView heading=text(title,21,colors.ink);heading.setTypeface(null,Typeface.BOLD);header.addView(heading,new LinearLayout.LayoutParams(0,-2,1));
        Button close=button("×",false,()->dismiss());close.setContentDescription("关闭面板");close.setTextSize(24);close.setPadding(0,0,0,0);header.addView(close,new LinearLayout.LayoutParams(dp(40),dp(40)));root.addView(header);
        subtitle=text(caption,12,colors.muted);subtitle.setPadding(0,dp(5),0,dp(16));subtitle.setVisibility(caption.isEmpty()?View.GONE:View.VISIBLE);root.addView(subtitle);
        ScrollView scroll=new ScrollView(activity){@Override protected void onMeasure(int width,int height){int limit=Math.max(dp(100),activity.getResources().getDisplayMetrics().heightPixels-dp(250));if(MeasureSpec.getSize(height)>0)limit=Math.min(limit,Math.max(dp(80),MeasureSpec.getSize(height)-dp(76)));super.onMeasure(width,MeasureSpec.makeMeasureSpec(limit,MeasureSpec.AT_MOST));}};
        scroll.setVerticalScrollBarEnabled(false);scroll.setClipToPadding(false);content=column();content.setPadding(0,dp(4),0,dp(4));scroll.addView(content);root.addView(scroll,new LinearLayout.LayoutParams(-1,-2));
        footer=row();footer.setPadding(0,dp(12),0,0);footer.setVisibility(View.GONE);root.addView(footer,new LinearLayout.LayoutParams(-1,-2));setContentView(root);
        root.getViewTreeObserver().addOnGlobalLayoutListener(()->{View focus=getCurrentFocus();if(focus instanceof EditText){android.graphics.Rect visible=new android.graphics.Rect(0,0,focus.getWidth(),focus.getHeight()+dp(8));focus.requestRectangleOnScreen(visible,true);}});
        Window window=getWindow();if(window!=null){window.setBackgroundDrawableResource(android.R.color.transparent);window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);window.setDimAmount(.32f);window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);}
    }
    @Override public void show(){super.show();Window w=getWindow();if(w!=null){w.setGravity(Gravity.BOTTOM);w.setLayout(-1,-2);w.getDecorView().setPadding(dp(10),dp(10),dp(10),dp(10));}}
    int dp(int n){return (int)(n*activity.getResources().getDisplayMetrics().density+.5f);}
    LinearLayout column(){LinearLayout v=new LinearLayout(activity);v.setOrientation(LinearLayout.VERTICAL);return v;}
    LinearLayout row(){LinearLayout v=new LinearLayout(activity);v.setGravity(Gravity.CENTER_VERTICAL);v.setBaselineAligned(false);return v;}
    TextView text(String value,int size,int color){TextView v=new TextView(activity);v.setText(value);v.setTextSize(size);v.setTextColor(color);v.setIncludeFontPadding(false);v.setLineSpacing(dp(3),1);return v;}
    GradientDrawable shape(int color,int radius){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));return d;}
    Button button(String label,boolean primary,Runnable action){
        Button b=new Button(activity);b.setText(label);b.setAllCaps(false);b.setTextSize(15);b.setSingleLine();b.setEllipsize(TextUtils.TruncateAt.END);b.setMinWidth(0);b.setMinimumWidth(0);b.setMinHeight(dp(48));b.setMinimumHeight(dp(48));b.setPadding(dp(16),0,dp(16),0);b.setIncludeFontPadding(false);b.setStateListAnimator(null);b.setBackgroundTintList(null);
        b.setBackground(new RippleDrawable(ColorStateList.valueOf(0x183f5ed7),shape(primary?colors.primary:colors.field,14),null));
        b.setTextColor(new ColorStateList(new int[][]{new int[]{-android.R.attr.state_enabled},new int[]{}},new int[]{primary?0xffcad2f2:colors.muted,primary?colors.onPrimary:colors.ink}));b.setOnClickListener(v->action.run());return b;
    }
    Button action(String title,boolean primary,boolean danger,Runnable action){
        footer.setVisibility(View.VISIBLE);Button b=button(title,primary,action);if(danger){b.setBackground(new RippleDrawable(ColorStateList.valueOf(0x20ffffff),shape(colors.danger,14),null));b.setTextColor(0xffffffff);}
        LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(0,dp(48),1);if(footer.getChildCount()>0)p.setMarginStart(dp(10));footer.addView(b,p);return b;
    }
    void gap(int height){View v=new View(activity);content.addView(v,new LinearLayout.LayoutParams(1,dp(height)));}
    void label(String value){TextView v=text(value,12,colors.muted);v.setPadding(0,dp(12),0,dp(8));content.addView(v);}
    LinearLayout choice(String title,String detail,String mark,boolean selected,boolean enabled,Runnable action){
        LinearLayout card=row();card.setPadding(dp(14),dp(13),dp(14),dp(13));card.setMinimumHeight(dp(68));card.setBackground(new RippleDrawable(ColorStateList.valueOf(0x183f5ed7),shape(selected?colors.selection:colors.field,16),null));
        if(mark.equals(":codex")||mark.equals(":claude")){ImageView icon=new ImageView(activity);icon.setImageResource(mark.equals(":codex")?com.limelight.R.drawable.herdr_codex:com.limelight.R.drawable.herdr_claude);icon.setScaleType(ImageView.ScaleType.FIT_CENTER);icon.setContentDescription(title+" 图标");card.addView(icon,new LinearLayout.LayoutParams(dp(32),dp(36)));}
        else if(mark.equals("▱")){ImageView icon=new ImageView(activity);icon.setImageDrawable(new android.graphics.drawable.Drawable(){
            @Override public void draw(android.graphics.Canvas c){android.graphics.Rect b=getBounds();int save=c.save();c.translate(b.left,b.top);c.scale(b.width()/24f,b.height()/24f);android.graphics.Paint paint=new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);paint.setColor(colors.primary);paint.setStyle(android.graphics.Paint.Style.STROKE);paint.setStrokeWidth(1.7f);paint.setStrokeJoin(android.graphics.Paint.Join.ROUND);android.graphics.Path p=new android.graphics.Path();p.moveTo(3,6);p.lineTo(9,6);p.lineTo(11,8);p.lineTo(21,8);p.lineTo(21,19);p.lineTo(3,19);p.close();c.drawPath(p,paint);c.restoreToCount(save);}
            @Override public void setAlpha(int alpha){}@Override public void setColorFilter(android.graphics.ColorFilter filter){}@Override public int getOpacity(){return android.graphics.PixelFormat.TRANSLUCENT;}
        });icon.setScaleType(ImageView.ScaleType.FIT_CENTER);icon.setPadding(dp(2),dp(4),dp(2),dp(4));card.addView(icon,new LinearLayout.LayoutParams(dp(32),dp(36)));}
        else if(!mark.isEmpty()){TextView icon=text(mark,17,colors.primary);icon.setGravity(Gravity.CENTER);icon.setTypeface(null,Typeface.BOLD);card.addView(icon,new LinearLayout.LayoutParams(dp(32),dp(36)));}
        LinearLayout words=column();if(!mark.isEmpty())words.setPadding(dp(10),0,dp(8),0);TextView name=text(title,15,enabled?colors.ink:colors.muted);name.setTypeface(null,Typeface.BOLD);name.setMaxLines(2);name.setEllipsize(TextUtils.TruncateAt.END);words.addView(name);
        if(!detail.isEmpty()){TextView sub=text(detail,12,colors.muted);sub.setPadding(0,dp(5),0,0);sub.setMaxLines(mark.equals("▱")?1:3);sub.setEllipsize(mark.equals("▱")?TextUtils.TruncateAt.MIDDLE:TextUtils.TruncateAt.END);words.addView(sub);}card.addView(words,new LinearLayout.LayoutParams(0,-2,1));
        TextView end=text(selected?"✓":"›",19,selected?colors.primary:colors.muted);card.addView(end,new LinearLayout.LayoutParams(dp(22),-2));
        card.setFocusable(enabled);card.setEnabled(enabled);card.setContentDescription(title+"，"+detail);if(enabled)card.setOnClickListener(v->action.run());
        LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.bottomMargin=dp(8);content.addView(card,p);return card;
    }
    EditText search(String hint){EditText e=new EditText(activity);e.setSingleLine();e.setTextSize(15);e.setTextColor(colors.ink);e.setHintTextColor(colors.muted);e.setHint(hint);e.setContentDescription(hint);e.setBackground(shape(colors.field,14));e.setPadding(dp(14),0,dp(14),0);e.setIncludeFontPadding(false);content.addView(e,new LinearLayout.LayoutParams(-1,dp(48)));gap(12);return e;}
    void state(String title,String detail,boolean loading){
        LinearLayout block=column();block.setPadding(dp(14),dp(22),dp(14),dp(22));block.setGravity(Gravity.CENTER_HORIZONTAL);block.setBackground(shape(colors.field,16));
        if(loading){ProgressBar progress=new ProgressBar(activity);progress.setIndeterminateTintList(ColorStateList.valueOf(colors.primary));block.addView(progress,new LinearLayout.LayoutParams(dp(24),dp(24)));}
        TextView heading=text(title,15,colors.ink);heading.setTypeface(null,Typeface.BOLD);heading.setGravity(Gravity.CENTER);heading.setPadding(0,dp(12),0,dp(6));block.addView(heading);
        TextView sub=text(detail,13,colors.muted);sub.setGravity(Gravity.CENTER);block.addView(sub);content.addView(block,new LinearLayout.LayoutParams(-1,-2));
    }
}
