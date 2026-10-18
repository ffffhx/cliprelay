package com.limelight.ui;

import android.app.*;
import android.content.SharedPreferences;
import com.limelight.R;
import com.limelight.nvstream.http.NvHTTP;
import java.util.function.BooleanSupplier;
import java.util.function.Function;

/** Keeps the existing Doubao workflow and exposes independent public Android recognizers. */
public final class VoiceInputController {
    private final Activity activity;
    private final RemoteVoiceInput desktop;
    private final PhoneSpeechInput phone;
    private final SharedPreferences preferences;
    private AlertDialog options;
    private boolean closed;
    public VoiceInputController(Activity activity,NvHTTP http,Runnable beforeStart,RemoteVoiceInput.Listener listener,
                                BooleanSupplier ready,Function<String,Boolean> send){
        this.activity=activity;desktop=new RemoteVoiceInput(activity,http,beforeStart,listener);
        phone=new PhoneSpeechInput(activity,ready,send,beforeStart,listener);
        preferences=activity.getSharedPreferences("remote_voice",0);
    }
    private String mode(){String value;try{value=preferences.getString("provider","desktop");}catch(ClassCastException e){return "invalid";}
        return "local".equals(value) || "system".equals(value) || "desktop".equals(value)?value:"invalid";}
    public boolean isActive(){return desktop.isActive() || phone.active() || options!=null;}
    public void toggle(){
        if(closed || options!=null)return;
        if(desktop.isActive()){desktop.end(false);return;}
        if(phone.active()){phone.stop();return;}
        String mode=mode();if(mode.equals("invalid"))showOptions();else if(mode.equals("desktop"))desktop.start();else phone.start(mode.equals("local"));
    }
    public void showOptions(){
        if(closed || activity.isFinishing())return;pause();
        String[] modes={"local","system","desktop"};int selected=java.util.Arrays.asList(modes).indexOf(mode());
        android.widget.TextView hint=new android.widget.TextView(activity);hint.setText(R.string.speech_provider_hint);hint.setPadding(24,12,24,12);
        options=new AlertDialog.Builder(activity).setTitle(R.string.speech_provider).setView(hint)
                .setSingleChoiceItems(new String[]{activity.getString(R.string.speech_local),activity.getString(R.string.speech_system),activity.getString(R.string.speech_desktop)},selected,(d,i)->{
                    if(i<2 && !PhoneSpeechInput.available(activity,i==0)){android.widget.Toast.makeText(activity,R.string.speech_unavailable,android.widget.Toast.LENGTH_LONG).show();return;}
                    if(!preferences.edit().putString("provider",modes[i]).commit()){android.widget.Toast.makeText(activity,R.string.shortcuts_save_failed,android.widget.Toast.LENGTH_LONG).show();return;}
                    d.dismiss();
                }).setNegativeButton(android.R.string.cancel,null).create();
        AlertDialog shown=options;shown.setOnDismissListener(d->{if(options==shown)options=null;});shown.show();
    }
    public void permissionResult(int request,boolean granted,boolean ready){
        if(request==PhoneSpeechInput.PERMISSION)phone.permissionResult(granted,ready);
        if(request==RemoteVoiceInput.PERMISSION)desktop.permissionResult(granted,ready);
    }
    public void end(boolean abort){desktop.end(abort);phone.cancel();}
    public void pause(){desktop.pause();phone.cancel();AlertDialog dialog=options;options=null;if(dialog!=null)dialog.dismiss();}
    public void windowFocusChanged(boolean focused){
        if(!focused)desktop.end(true);
        if(options==null)phone.windowFocusChanged(focused);
    }
    public void close(){closed=true;pause();desktop.close();phone.close();}
}
