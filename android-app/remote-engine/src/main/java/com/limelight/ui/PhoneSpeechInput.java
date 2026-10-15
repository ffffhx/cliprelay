package com.limelight.ui;

import android.Manifest;
import android.app.*;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.*;
import android.speech.*;
import android.view.*;
import android.widget.*;
import com.limelight.R;
import java.util.*;
import java.util.function.BooleanSupplier;
import java.util.function.Function;

/** Android's public recognition service. A final result is reviewed before a single text send. */
public final class PhoneSpeechInput {
    public static final int PERMISSION=8032;
    private final Activity activity;
    private final BooleanSupplier connected;
    private final Function<String,Boolean> send;
    private final Runnable beforeStart;
    private final RemoteVoiceInput.Listener listener;
    private final Handler main=new Handler(Looper.getMainLooper());
    private final DictationState state=new DictationState();
    private SpeechRecognizer recognizer;
    private LinearLayout overlay;
    private TextView status;
    private AlertDialog review;
    private boolean permissionPending,onDevice,closed;
    public PhoneSpeechInput(Activity activity,BooleanSupplier connected,Function<String,Boolean> send,Runnable beforeStart,RemoteVoiceInput.Listener listener){
        this.activity=activity;this.connected=connected;this.send=send;this.beforeStart=beforeStart;this.listener=listener;
    }
    public boolean active(){return permissionPending || state.active();}
    private boolean usable(){return !closed && !activity.isFinishing() && !activity.isDestroyed() && connected.getAsBoolean();}
    public static boolean available(Activity activity,boolean local){
        try{return local?Build.VERSION.SDK_INT>=31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(activity):SpeechRecognizer.isRecognitionAvailable(activity);}
        catch(RuntimeException e){return false;}
    }
    public void start(boolean local){
        if(!usable() || active() || !activity.hasWindowFocus())return;onDevice=local;
        if(!available(activity,local)){message(R.string.speech_unavailable);return;}
        if(activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED){
            permissionPending=true;listener.changed(RemoteVoiceInput.State.STARTING);
            activity.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},PERMISSION);return;
        }
        begin();
    }
    public void permissionResult(boolean granted,boolean ready){
        boolean requested=permissionPending;permissionPending=false;if(!requested || closed)return;
        listener.changed(RemoteVoiceInput.State.IDLE);
        if(granted && ready && usable() && activity.hasWindowFocus())begin();else if(!granted)message(R.string.voice_permission);
    }
    private void begin(){
        if(!usable() || !activity.hasWindowFocus() || activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED)return;
        beforeStart.run();long token=state.begin(SystemClock.elapsedRealtime());
        try {
            recognizer=onDevice && Build.VERSION.SDK_INT>=31?SpeechRecognizer.createOnDeviceSpeechRecognizer(activity):SpeechRecognizer.createSpeechRecognizer(activity);
            recognizer.setRecognitionListener(new RecognitionListener(){
                public void onReadyForSpeech(Bundle params){if(state.ready(token)){listener.changed(RemoteVoiceInput.State.LISTENING);status.setText(R.string.speech_listening);}}
                public void onBeginningOfSpeech(){}
                public void onRmsChanged(float rms){}
                public void onBufferReceived(byte[] buffer){} // Never retain or log raw audio.
                public void onEndOfSpeech(){if(state.stop(token,SystemClock.elapsedRealtime())){listener.changed(RemoteVoiceInput.State.STOPPING);if(status!=null)status.setText(R.string.speech_processing);}}
                public void onError(int error){if(state.current(token) && state.phase()!=DictationState.Phase.REVIEW)fail(error==SpeechRecognizer.ERROR_NO_MATCH || error==SpeechRecognizer.ERROR_SPEECH_TIMEOUT?R.string.speech_no_match:error==SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS?R.string.voice_permission:error==SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || error==SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE?R.string.speech_language_unavailable:R.string.speech_failed);}
                public void onResults(Bundle results){
                    if(!state.current(token) || !usable() || state.phase()==DictationState.Phase.REVIEW)return;
                    String text;
                    try{
                        ArrayList<String> candidates=results==null?null:results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                        text=candidates==null || candidates.isEmpty()?null:state.result(token,candidates.get(0),SystemClock.elapsedRealtime());
                    }catch(RuntimeException error){fail(R.string.speech_failed);return;}
                    if(text==null){if(state.phase()!=DictationState.Phase.REVIEW)fail(R.string.speech_no_match);return;}
                    destroyRecognizer();removeOverlay();main.removeCallbacks(watchdog);listener.changed(RemoteVoiceInput.State.IDLE);showReview(token,text);
                }
                public void onPartialResults(Bundle result){} // Revisions never reach the remote text path.
                public void onEvent(int event,Bundle params){}
            });
            showOverlay();listener.changed(RemoteVoiceInput.State.STARTING);
            Intent intent=new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE,Locale.getDefault().toLanguageTag()).putExtra(RecognizerIntent.EXTRA_MAX_RESULTS,1)
                    .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS,false);
            recognizer.startListening(intent);main.postDelayed(watchdog,250);
        }catch(RuntimeException e){fail(R.string.speech_failed);}
    }
    public void stop(){
        if(permissionPending){cancel();return;}
        if(state.phase()==DictationState.Phase.REVIEW || state.phase()==DictationState.Phase.STOPPING)return;
        if(state.stop(state.token(),SystemClock.elapsedRealtime())){
            listener.changed(RemoteVoiceInput.State.STOPPING);if(status!=null)status.setText(R.string.speech_processing);
            try{if(recognizer!=null)recognizer.stopListening();}catch(RuntimeException e){fail(R.string.speech_failed);}
        }
    }
    private final Runnable watchdog=new Runnable(){public void run(){
        if(!state.active() || state.phase()==DictationState.Phase.REVIEW)return;
        if(!usable()){cancel();return;}
        if(state.expired(state.token(),SystemClock.elapsedRealtime())){fail(R.string.speech_timeout);return;}
        main.postDelayed(this,250);
    }};
    private void showOverlay(){
        FrameLayout root=activity.findViewById(android.R.id.content);
        overlay=new LinearLayout(activity);overlay.setOrientation(LinearLayout.VERTICAL);overlay.setBackgroundColor(0xee172033);overlay.setPadding(16,16,16,16);
        status=new TextView(activity);status.setTextColor(0xffeeeeee);status.setText(R.string.speech_starting);overlay.addView(status);
        LinearLayout buttons=new LinearLayout(activity);overlay.addView(buttons);
        Button stop=new Button(activity);stop.setText(R.string.speech_stop);stop.setOnClickListener(v->stop());buttons.addView(stop);
        Button cancel=new Button(activity);cancel.setText(android.R.string.cancel);cancel.setOnClickListener(v->cancel());buttons.addView(cancel);
        FrameLayout.LayoutParams params=new FrameLayout.LayoutParams(-2,-2,Gravity.TOP|Gravity.CENTER_HORIZONTAL);
        params.topMargin=(int)(40*activity.getResources().getDisplayMetrics().density);root.addView(overlay,params);
    }
    private void removeOverlay(){if(overlay!=null){ViewGroup parent=(ViewGroup)overlay.getParent();if(parent!=null)parent.removeView(overlay);overlay=null;status=null;}}
    private void showReview(long token,String text){
        if(!usable()){cancel();return;}
        EditText edit=new EditText(activity);edit.setText(text);edit.setSingleLine(true);edit.setSelectAllOnFocus(false);
        edit.setInputType(android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        edit.setImeOptions(android.view.inputmethod.EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING|android.view.inputmethod.EditorInfo.IME_ACTION_DONE);
        edit.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        edit.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(8192)});
        AlertDialog dialog=new AlertDialog.Builder(activity).setTitle(R.string.speech_review).setMessage(R.string.speech_review_hint).setView(edit)
                .setPositiveButton(R.string.speech_type,null).setNegativeButton(android.R.string.cancel,(d,w)->cancel()).create();
        review=dialog;dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        dialog.setOnCancelListener(d->cancel());dialog.setOnDismissListener(d->{if(review==dialog){review=null;state.cancel();}});
        dialog.setOnShowListener(d->{
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->{
                String value=state.confirm(token,edit.getText().toString(),usable() && dialog.getWindow().getDecorView().hasWindowFocus());
                if(value==null){if(!usable())cancel();else edit.setError(activity.getString(R.string.speech_invalid_text));return;}
                // Consume confirmation before invoking the transport. No automatic retry after any result.
                boolean sent=false;try{sent=Boolean.TRUE.equals(send.apply(value));}catch(RuntimeException ignored){}
                cancel();if(!sent)message(R.string.speech_not_sent);
            });
            dialog.getWindow().getDecorView().getViewTreeObserver().addOnWindowFocusChangeListener(focused->{
                if(!focused && review==dialog)cancel();
            });
        });dialog.show();
    }
    public void windowFocusChanged(boolean focused){
        // The review window owns focus; its own listener handles overlays/lock screen.
        // Permission prompts are handled by their result and Activity pause cancellation.
        if(!focused && review==null && !permissionPending)cancel();
    }
    public void cancel(){
        boolean wasActive=active();
        permissionPending=false;state.cancel();main.removeCallbacks(watchdog);destroyRecognizer();removeOverlay();
        AlertDialog dialog=review;review=null;if(dialog!=null)dialog.dismiss();
        if(!closed && wasActive)listener.changed(RemoteVoiceInput.State.IDLE);
    }
    private void destroyRecognizer(){SpeechRecognizer active=recognizer;recognizer=null;if(active!=null){try{active.cancel();}catch(RuntimeException ignored){}try{active.destroy();}catch(RuntimeException ignored){}}}
    private void fail(int text){cancel();if(!closed && !activity.isFinishing())message(text);}
    private void message(int text){Toast.makeText(activity,text,Toast.LENGTH_LONG).show();}
    public void close(){cancel();closed=true;main.removeCallbacksAndMessages(null);}
}
