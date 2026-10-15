package com.limelight.ui;

import android.app.Activity;
import android.content.*;
import android.os.SystemClock;
import android.widget.FrameLayout;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.limelight.R;
import org.junit.*;
import org.junit.runner.RunWith;
import java.util.*;
import static org.junit.Assert.*;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.*;
import static androidx.test.espresso.matcher.RootMatchers.isDialog;
import static androidx.test.espresso.matcher.ViewMatchers.*;

/** Isolated controls and recording sink only; never starts recognition or contacts a stream. */
@RunWith(AndroidJUnit4.class)
public class InputToolsUiTest {
    private final android.app.Instrumentation instrument=InstrumentationRegistry.getInstrumentation();
    private Activity activity;
    private CustomShortcutPanel panel;
    private VoiceInputController voice;
    private final List<String> events=new ArrayList<>();
    private final Map<String,Map<String,?>> saved=new HashMap<>();
    private boolean ready=true;
    private SharedPreferences prefs(String name){return instrument.getTargetContext().getSharedPreferences(name,0);}
    private void ui(Runnable task){instrument.runOnMainSync(task);instrument.waitForIdleSync();}
    @Before public void setup(){
        for(String name:new String[]{"desktop_shortcuts","remote_voice"}){saved.put(name,new HashMap<>(prefs(name).getAll()));prefs(name).edit().clear().commit();}
        activity=instrument.startActivitySync(new Intent().setClassName(instrument.getTargetContext().getPackageName(),"com.limelight.PcView").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        instrument.waitForIdleSync();SystemClock.sleep(1200);
        ui(()->{
            activity.setContentView(new FrameLayout(activity));
            DesktopInput input=new DesktopInput(new DesktopInput.Sink(){
                public void send(int key,boolean down,int modifiers){events.add(key+":"+down+":"+modifiers);}
                public void text(String text){events.add("text:"+text);}
                public void rightClick(){}
                public void scroll(byte count){}
            });panel=new CustomShortcutPanel(activity,input,()->ready,()->{});
            voice=new VoiceInputController(activity,null,()->{},state->{},()->ready,text->{events.add(text);return true;});
        });
    }
    @After public void cleanup(){
        if(activity!=null)ui(()->{if(panel!=null)panel.close();if(voice!=null)voice.close();activity.finish();});
        for(Map.Entry<String,Map<String,?>> group:saved.entrySet()){
            SharedPreferences.Editor edit=prefs(group.getKey()).edit().clear();
            for(Map.Entry<String,?> item:group.getValue().entrySet()){
                Object v=item.getValue();String k=item.getKey();if(v instanceof String)edit.putString(k,(String)v);else if(v instanceof Boolean)edit.putBoolean(k,(Boolean)v);else if(v instanceof Integer)edit.putInt(k,(Integer)v);else if(v instanceof Long)edit.putLong(k,(Long)v);else if(v instanceof Float)edit.putFloat(k,(Float)v);
            }edit.commit();
        }
    }
    @Test public void savedChordSendsOnceAndReleasesEveryKey() throws Exception {
        CustomShortcut value=new CustomShortcut("0123456789abcdef0123456789abcdef","Palette",3,'P');
        prefs("desktop_shortcuts").edit().putString("chords",CustomShortcut.encode(Collections.singletonList(value))).commit();
        ui(()->panel.show());onView(withText("Palette\nCtrl + Shift + P")).inRoot(isDialog()).perform(click());
        assertEquals(Arrays.asList("16:true:1","17:true:3","80:true:3","80:false:3","17:false:1","16:false:0"),events);
        ui(()->ready=false);onView(withText("Palette\nCtrl + Shift + P")).inRoot(isDialog()).perform(click());assertEquals(6,events.size());
    }
    @Test public void editorPersistsAReusableShortcutWithoutSendingKeys() throws Exception {
        ui(()->panel.show());onView(withText(R.string.shortcuts_add)).inRoot(isDialog()).perform(click());
        onView(withHint(R.string.shortcuts_name)).inRoot(isDialog()).perform(replaceText("Saved"),closeSoftKeyboard());
        onView(withText(R.string.shortcuts_save)).inRoot(isDialog()).perform(click());
        List<CustomShortcut> values=CustomShortcut.decode(prefs("desktop_shortcuts").getString("chords",""));
        assertEquals(1,values.size());assertEquals("Saved",values.get(0).name);assertTrue(events.isEmpty());
    }
    @Test public void malformedStorageIsNotSilentlyOverwritten(){
        prefs("desktop_shortcuts").edit().putString("chords","damaged").commit();ui(()->panel.show());
        onView(withText(R.string.shortcuts_invalid)).inRoot(isDialog()).check(androidx.test.espresso.assertion.ViewAssertions.matches(isDisplayed()));
        assertEquals("damaged",prefs("desktop_shortcuts").getString("chords",""));assertTrue(events.isEmpty());
    }
    @Test public void publicRecognizerChoicesAreVisibleWithoutOpeningMicrophone(){
        ui(()->voice.showOptions());
        for(int text:new int[]{R.string.speech_local,R.string.speech_system,R.string.speech_desktop})onView(withText(text)).inRoot(isDialog()).check(androidx.test.espresso.assertion.ViewAssertions.matches(isDisplayed()));
        assertTrue(events.isEmpty());onView(withText(R.string.speech_desktop)).inRoot(isDialog()).perform(click());
        assertEquals("desktop",prefs("remote_voice").getString("provider",""));assertFalse(voice.isActive());assertTrue(events.isEmpty());
    }
}
