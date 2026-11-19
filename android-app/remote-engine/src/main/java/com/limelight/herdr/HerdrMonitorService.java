package com.limelight.herdr;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
import com.limelight.files.TransferStorage;
import com.limelight.computers.ComputerDatabaseManager;
import com.limelight.computers.StreamRouteRecovery;
import com.limelight.nvstream.http.*;
import org.json.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;

/** Observes catalog facts in the background; owns no terminal and sends no input. */
public final class HerdrMonitorService extends Service {
    public static final String CHANNEL="herdr-agent-events",CHANGED="com.cliprelay.HERDR_CHANGED";
    private static final String CONNECTION="herdr-monitor";
    private static final int ONGOING=7821;
    private static volatile String visible="";
    private final ScheduledExecutorService worker=Executors.newSingleThreadScheduledExecutor();
    private volatile boolean destroyed;
    private volatile NvHTTP transport;
    private HerdrMonitorStore store;
    private PowerManager.WakeLock wake;
    public static void visible(String uuid,String core,String terminal){visible=uuid.isEmpty()?"":uuid+":"+core+":"+terminal;}
    public static Intent destination(Context context,JSONObject host,String core,String terminal){
        return TransferStorage.intent(context,host).setClass(context,HerdrActivity.class).putExtra("herdrCore",core).putExtra("herdrTerminal",terminal)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }
    public static void start(Context context){context.startForegroundService(new Intent(context,HerdrMonitorService.class));}
    @Override public void onCreate(){super.onCreate();
        NotificationManager manager=getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CONNECTION,"Agent 后台连接",NotificationManager.IMPORTANCE_LOW));
        manager.createNotificationChannel(new NotificationChannel(CHANNEL,"Agent 完成与待处理",NotificationManager.IMPORTANCE_DEFAULT));
        wake=((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"ClipRelay:herdr-notifications");
        try{store=HerdrMonitorStore.get(this);}catch(IOException e){stopSelf();}
    }
    private Notification ongoing(){
        Intent launch=getPackageManager().getLaunchIntentForPackage(getPackageName());
        if(store!=null)for(HerdrMonitorStore.Target t:store.targets())if(t.enabled){launch=destination(this,t.host,t.core,"");break;}
        PendingIntent open=PendingIntent.getActivity(this,ONGOING,launch,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop=PendingIntent.getService(this,ONGOING,new Intent(this,HerdrMonitorService.class).setAction("stop"),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this,CONNECTION).setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle("Agent 后台通知已开启")
            .setContentText("完成或需要你处理时提醒 · 点此查看会话").setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
            .addAction(new Notification.Action.Builder(null,"暂停提醒",stop).build()).build();
    }
    private boolean started;
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        if(Build.VERSION.SDK_INT>=29)startForeground(ONGOING,ongoing(),ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);else startForeground(ONGOING,ongoing());
        if(store==null){stopSelf();return START_NOT_STICKY;}
        if(intent!=null&&"stop".equals(intent.getAction())){synchronized(store){for(HerdrMonitorStore.Target t:store.targets())t.enabled=false;try{store.save();}catch(IOException ignored){}}stopSelf();changed();return START_NOT_STICKY;}
        if(!started){started=true;wake.acquire();worker.scheduleWithFixedDelay(this::poll,0,5,TimeUnit.SECONDS);}
        return START_STICKY;
    }
    private void changed(){sendBroadcast(new Intent(CHANGED).setPackage(getPackageName()));}
    private void poll(){
        if(destroyed||store==null)return;boolean any=false;
        for(HerdrMonitorStore.Target target:store.targets()){
            if(!target.enabled)continue;any=true;
            try{
                JSONObject host=new JSONObject(target.host.toString());ComputerDatabaseManager db=new ComputerDatabaseManager(this);ComputerDetails computer;
                try{computer=db.getComputerByUUID(host.getString("uuid"));}finally{db.close();}
                if(computer==null||computer.serverCert==null||!Base64.getEncoder().encodeToString(computer.serverCert.getEncoded()).equals(host.getString("cert")))throw new IOException("HERDR_UNPAIRED");
                ComputerDetails route=StreamRouteRecovery.select(this,host.getString("uuid"),host.getString("uniqueId"));
                if(route==null||route.activeAddress==null)throw new IOException("HERDR_UNAVAILABLE");
                host.put("address",route.activeAddress.address).put("port",route.activeAddress.port).put("https",route.httpsPort);
                if(destroyed)return;NvHTTP http=TransferStorage.connection(this,host);transport=http;
                JSONObject request=new JSONObject().put("op","list").put("coreSession",target.core);
                HerdrProtocol.Reply reply=new HerdrProtocol.Reply(request,http.herdrRequest(request));
                List<JSONObject> events;
                synchronized(store){
                    if(!target.enabled||destroyed)continue;
                    events=target.ledger.observe(reply.result.optString("coreId"),reply.terminals(),System.currentTimeMillis());target.error="";
                    for(JSONObject event:events)if(visible.equals(target.key()+":"+event.getString("terminal")))event.put("read",true);
                    // Save before notification: reconnects and process restarts cannot replay old pings.
                    store.save();
                }
                for(JSONObject event:events)if(!event.optBoolean("read"))notify(target,event);
                changed();
            }catch(Exception e){synchronized(store){target.error="HERDR_UNPAIRED".equals(e.getMessage())?"配对已撤销，提醒已暂停":"电脑暂时离线，正在重新连接";
                if("HERDR_UNPAIRED".equals(e.getMessage())){target.enabled=false;for(JSONObject event:target.ledger.events())getSystemService(NotificationManager.class).cancel(event.optString("id"),7822);}
                try{store.save();}catch(IOException ignored){} }changed();
            }finally{NvHTTP http=transport;transport=null;if(http!=null)http.cancelHerdrRequests();}
        }
        if(!any){stopForeground(STOP_FOREGROUND_REMOVE);stopSelf();}
    }
    private void notify(HerdrMonitorStore.Target target,JSONObject event){
        String id=event.optString("id");Intent intent=destination(this,target.host,target.core,event.optString("terminal")).putExtra("herdrCoreId",event.optString("coreId",id.split(":")[0]));
        intent.setData(android.net.Uri.parse("cliprelay://herdr/"+android.net.Uri.encode(target.key())+"/"+android.net.Uri.encode(event.optString("terminal"))));
        PendingIntent open=PendingIntent.getActivity(this,0,intent,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        Notification notification=new Notification.Builder(this,CHANNEL).setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(event.optString("project")+" · "+HerdrEventLedger.label(event.optString("kind")))
            .setContentText(event.optString("agent")+" · "+event.optString("title")).setContentIntent(open).setAutoCancel(true)
            .setCategory(Notification.CATEGORY_MESSAGE).setVisibility(Notification.VISIBILITY_PRIVATE).setOnlyAlertOnce(true).build();
        getSystemService(NotificationManager.class).notify(id,7822,notification);
    }
    @Override public void onDestroy(){destroyed=true;NvHTTP http=transport;if(http!=null)http.cancelHerdrRequests();worker.shutdownNow();if(wake!=null&&wake.isHeld())wake.release();super.onDestroy();}
    @Override public IBinder onBind(Intent intent){return null;}
}
