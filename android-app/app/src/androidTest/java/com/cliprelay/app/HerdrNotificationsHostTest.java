package com.cliprelay.app;

import android.app.*;
import android.content.*;
import android.graphics.Bitmap;
import android.os.SystemClock;
import android.service.notification.StatusBarNotification;
import android.view.*;
import android.widget.*;
import androidx.test.platform.app.InstrumentationRegistry;
import com.limelight.Game;
import com.limelight.computers.*;
import com.limelight.herdr.*;
import com.limelight.nvstream.http.ComputerDetails;
import java.lang.reflect.Field;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import org.json.*;
import org.junit.Test;
import static org.junit.Assert.*;
import static org.junit.Assume.*;

/** Opt-in real host check; only ever sends input to an explicitly isolated core. */
public class HerdrNotificationsHostTest {
    private final Instrumentation instrument=InstrumentationRegistry.getInstrumentation();
    private void ui(Runnable action){instrument.runOnMainSync(action);}
    private Object field(Object owner,String name){try{Field f=owner.getClass().getDeclaredField(name);f.setAccessible(true);return f.get(owner);}catch(Exception e){throw new AssertionError(e);}}
    private void await(String message,BooleanSupplier condition){long end=SystemClock.uptimeMillis()+90000;do{boolean[] done={false};ui(()->done[0]=condition.getAsBoolean());if(done[0])return;SystemClock.sleep(200);}while(SystemClock.uptimeMillis()<end);fail(message);}
    private String terminalText(HerdrActivity activity){return ((com.termux.terminal.TerminalEmulator)field(field(activity,"terminalView"),"emulator")).getScreen().getTranscriptText();}
    private void capture(Context context,String name)throws Exception{instrument.waitForIdleSync();SystemClock.sleep(300);Bitmap bitmap=instrument.getUiAutomation().takeScreenshot();assertNotNull(bitmap);try(var out=new java.io.FileOutputStream(new java.io.File(context.getExternalFilesDir(null),"herdr-"+name+".png"))){assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,out));}finally{bitmap.recycle();}}
    private StatusBarNotification notification(NotificationManager manager,String coreId){for(StatusBarNotification n:manager.getActiveNotifications())if(n.getTag()!=null&&n.getTag().startsWith(coreId+":"))return n;return null;}

    @Test public void terminalBackgroundCompletionAndNotificationDestination()throws Exception{
        var args=InstrumentationRegistry.getArguments();assumeTrue("true".equals(args.getString("herdrNotifications")));
        String core=args.getString("herdrCoreSession","");assertTrue(core.matches("cliprelay-check-[a-z0-9]{8,32}"));
        String terminal=args.getString("herdrTerminal","");assertTrue(terminal.matches("t[0-9]+"));
        String computerName=args.getString("computerName","");assertFalse(computerName.isEmpty());
        Context context=instrument.getTargetContext();ComputerDetails computer=null;var db=new ComputerDatabaseManager(context);
        try{for(ComputerDetails c:db.getAllComputers())if(c.name.equals(computerName)&&c.serverCert!=null){assertNull(computer);computer=c;}}finally{db.close();}
        assertNotNull("Paired computer",computer);var address=computer.localAddress!=null?computer.localAddress:computer.manualAddress;assertNotNull(address);
        Intent intent=new Intent(context,HerdrActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(Game.EXTRA_HOST,address.address).putExtra(Game.EXTRA_PORT,address.port).putExtra(Game.EXTRA_PC_UUID,computer.uuid)
            .putExtra(Game.EXTRA_PC_NAME,computer.name).putExtra(Game.EXTRA_UNIQUEID,new IdentityManager(context).getUniqueId())
            .putExtra(Game.EXTRA_SERVER_CERT,computer.serverCert.getEncoded()).putExtra("herdrCore",core).putExtra("herdrTerminal",terminal);
        NotificationManager manager=context.getSystemService(NotificationManager.class);assertTrue("System notification permission",manager.areNotificationsEnabled());
        HerdrMonitorStore store=HerdrMonitorStore.get(context);String uuid=computer.uuid;
        synchronized(store){var existing=store.find(uuid,core);if(existing!=null){existing.enabled=true;store.save();}}
        HerdrActivity activity=(HerdrActivity)instrument.startActivitySync(intent);
        HerdrActivity[] finalActivity={activity};
        try{
            await("Exact Agent did not open",()->{var watch=(HerdrProtocol.Watch)field(activity,"watch");return watch!=null&&watch.terminal.equals(terminal)&&watch.attached;});
            await("Terminal output unavailable",()->!terminalText(activity).trim().isEmpty());
            capture(context,"notification-terminal");
            await("Background monitor has no baseline",()->{synchronized(store){var t=store.find(uuid,core);if(t==null)return false;try{return t.ledger.json().getJSONObject("previous").has(terminal);}catch(Exception e){return false;}}});
            HerdrMonitorStore.Target target=store.find(uuid,core);String coreId;int before;
            synchronized(store){coreId=target.ledger.json().getString("coreId");before=target.ledger.events().size();}
            String marker="CLIPRELAY_PHONE_NOTIFY_"+UUID.randomUUID().toString().replace("-","");
            await("Composer unavailable",()->((Button)field(activity,"send")).isEnabled());
            ui(()->{((EditText)field(activity,"composer")).setText("Reply exactly "+marker+". Do not use tools or change files.");((Button)field(activity,"send")).performClick();});
            await("Message receipt missing",()->{var w=(HerdrProtocol.Watch)field(activity,"watch");return w!=null&&w.accepted>0&&w.pending==null;});
            ui(()->activity.moveTaskToBack(true));
            await("Activity did not enter background",()->!(Boolean)field(activity,"foreground"));
            await("No real completion notification in background",()->notification(manager,coreId)!=null);
            StatusBarNotification result=notification(manager,coreId);assertNotNull(result);assertEquals(HerdrMonitorService.CHANNEL,result.getNotification().getChannelId());
            assertFalse("Terminal content must not leak onto lock screen",result.getNotification().extras.toString().contains(marker));
            int count;synchronized(store){count=target.ledger.events().size();assertEquals(before+1,count);assertEquals(1,target.ledger.unread());}
            long posted=result.getPostTime();SystemClock.sleep(6500);
            assertEquals("A poll cannot repost a completion",posted,notification(manager,coreId).getPostTime());
            // Exercise the actual notification PendingIntent, including its routing extras.
            Instrumentation.ActivityMonitor monitor=instrument.addMonitor(HerdrActivity.class.getName(),null,false);
            result.getNotification().contentIntent.send();
            Activity opened=instrument.waitForMonitorWithTimeout(monitor,8000);instrument.removeMonitor(monitor);
            HerdrActivity destination=opened instanceof HerdrActivity?(HerdrActivity)opened:activity;
            finalActivity[0]=destination;
            await("Notification opened a different conversation",()->{var w=(HerdrProtocol.Watch)field(destination,"watch");return w!=null&&w.terminal.equals(terminal)&&core.equals(field(destination,"core"))&&w.attached;});
            await("Output not rendered in terminal",()->terminalText(destination).contains(marker));
            synchronized(store){assertEquals("Opening conversation marks its event read",0,target.ledger.unread());}
            assertNull("Read notification cleared",notification(manager,coreId));
            capture(context,"notification-opened");
            Intent stale=new Intent(intent).putExtra("herdrCoreId","retired-core").putExtra("herdrTerminal","t1");
            ui(()->instrument.callActivityOnNewIntent(destination,stale));
            await("Stale notification was not rejected",()->((TextView)field(destination,"notice")).getText().toString().contains("旧提醒"));
            ui(()->assertEquals("Old notification cannot open a reused terminal number",terminal,((HerdrProtocol.Watch)field(destination,"watch")).terminal));
            ui(()->instrument.callActivityOnNewIntent(destination,new Intent(intent).putExtra("herdrCoreId",coreId)));
            ui(()->{context.stopService(new Intent(context,HerdrMonitorService.class));});
            SystemClock.sleep(500);ui(()->HerdrMonitorService.start(destination));SystemClock.sleep(6500);
            synchronized(store){assertEquals("Service restart preserves deduplication",count,target.ledger.events().size());}
            assertNull(notification(manager,coreId));
            ui(()->((Button)field(destination,"inboxButton")).performClick());capture(context,"notification-inbox");
            instrument.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
        }finally{
            ui(()->{finalActivity[0].finish();if(finalActivity[0]!=activity)activity.finish();});
            synchronized(store){var t=store.find(uuid,core);if(t!=null){t.enabled=false;for(JSONObject e:t.ledger.events())manager.cancel(e.optString("id"),7822);store.save();}}
        }
    }
}
