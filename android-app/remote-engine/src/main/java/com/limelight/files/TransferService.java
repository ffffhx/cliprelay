package com.limelight.files;

import android.app.*;
import android.content.*;
import android.net.Uri;
import android.os.*;
import com.limelight.R;
import com.limelight.nvstream.http.NvHTTP;
import java.io.*;
import java.util.concurrent.*;

/** Runs only user-requested work, stops when paused/finished, and journals every acknowledged chunk. */
public final class TransferService extends Service {
    private static final String CHANNEL="cliprelay-files";
    private static final int NOTIFICATION=4218;
    private static volatile TransferService current;
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final Handler main=new Handler(Looper.getMainLooper());
    private TransferStorage store;
    private volatile TransferStorage.Job active;
    private volatile NvHTTP connection;
    private volatile int stopMode;
    private boolean busy;
    private volatile boolean destroyed;
    private int startId;
    private long lastNotification;
    private PowerManager.WakeLock wake;
    public static void start(Context context){context.startForegroundService(new Intent(context,TransferService.class));}
    public static void control(Context context,TransferStorage.Job job,boolean cancel) throws IOException {
        TransferStorage storage=TransferStorage.get(context);
        synchronized(storage){
            if(job.terminal())return;
            job.cancelRequested|=cancel;
            TransferService service=current;
            if(service!=null&&service.active==job){
                service.stopMode=cancel?2:1;job.task.state=cancel?"cancelling":"pausing";
                NvHTTP http=service.connection;if(http!=null)http.cancelFilesRequest();
            }else job.task.state=cancel?"cancelling":"paused";
            storage.save(job);
        }
        if(cancel)start(context);
    }
    @Override public void onCreate(){
        super.onCreate();current=this;
        NotificationManager manager=getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL,getString(R.string.files_title),NotificationManager.IMPORTANCE_LOW));
        wake=((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"ClipRelay:files");
        try{store=TransferStorage.get(this);}catch(IOException e){stopSelf();}
    }
    private Notification notification(TransferStorage.Job job){
        Intent target=job==null?getPackageManager().getLaunchIntentForPackage(getPackageName()):TransferStorage.intent(this,job.host);
        PendingIntent open=PendingIntent.getActivity(this,0,target,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        PendingIntent pause=PendingIntent.getService(this,1,new Intent(this,TransferService.class).setAction("pause"),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder=new Notification.Builder(this,CHANNEL).setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle(getString(R.string.files_title)).setContentText(job==null?getString(R.string.files_queued):job.task.name)
                .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).addAction(new Notification.Action.Builder(null,getString(R.string.files_pause_all),pause).build());
        if(job!=null)builder.setProgress(100,job.task.size>0?(int)(job.task.offset*100/job.task.size):0,job.task.size<0);
        return builder.build();
    }
    @Override public int onStartCommand(Intent intent,int flags,int id){
        startId=id;startForeground(NOTIFICATION,notification(active));
        if(store==null){stopSelf();return START_NOT_STICKY;}
        if(intent!=null&&"pause".equals(intent.getAction())){
            for(TransferStorage.Job job:store.jobs())if(!job.terminal())try{control(this,job,false);}catch(IOException ignored){}
        }
        pump();return START_NOT_STICKY;
    }
    private void pump(){
        if(busy||destroyed)return;
        TransferStorage.Job next=null;
        synchronized(store){for(TransferStorage.Job job:store.jobs())if(job.task.state.equals("queued")||job.task.state.equals("cancelling")){next=job;break;}}
        if(next==null){stopForeground(STOP_FOREGROUND_REMOVE);stopSelfResult(startId);return;}
        active=next;stopMode=next.cancelRequested?2:0;busy=true;
        worker.execute(()->{run(active);main.post(()->{busy=false;active=null;connection=null;pump();});});
    }
    private void check() throws IOException {if(stopMode!=0||destroyed||Thread.currentThread().isInterrupted())throw new InterruptedIOException("FILES_PAUSED");}
    private void run(TransferStorage.Job job){
        boolean cancelAttempted=false;
        try{
            wake.acquire(6*60*60*1000L);
            connection=TransferStorage.connection(this,job.host);
            TransferRunner runner=new TransferRunner(connection::filesRequest,new TransferRunner.Progress(){
                public boolean stopped(){return stopMode!=0||destroyed;}
                public void save(TransferRunner.Task task) throws IOException {
                    store.save(job);
                    if(SystemClock.elapsedRealtime()-lastNotification>1000){lastNotification=SystemClock.elapsedRealtime();getSystemService(NotificationManager.class).notify(NOTIFICATION,notification(job));}
                    if(!job.terminal())check();
                }
            });
            job.error="";
            if(job.cancelRequested){
                cancelAttempted=true;
                runner.cancel(job.task);TransferDestination.discardPartial(getContentResolver(),store,job);return;
            }
            if(job.task.direction.equals("upload"))runner.upload(job.task,()->{
                InputStream input=getContentResolver().openInputStream(Uri.parse(job.source));
                if(input==null)throw new IOException("FILES_SOURCE_CHANGED");return input;
            });
            else{
                runner.download(job.task,store.part(job));check();TransferDestination.publish(getContentResolver(),store,job,this::check);
            }
        }catch(Exception e){
            if(job.cancelRequested&&job.task.state.equals("cancelled")){
                job.task.state="paused";job.error="FILES_CANCEL_PENDING";
                try{store.save(job);}catch(IOException ignored){}
                return;
            }
            if(!job.terminal()){
                if(job.cancelRequested&&!cancelAttempted&&connection!=null&&!destroyed){
                    try{
                        new TransferRunner(connection::filesRequest,new TransferRunner.Progress(){
                            public boolean stopped(){return false;}
                            public void save(TransferRunner.Task task)throws IOException{store.save(job);}
                        }).cancel(job.task);
                        TransferDestination.discardPartial(getContentResolver(),store,job);return;
                    }catch(IOException ignored){if(job.task.state.equals("cancelled"))job.task.state="paused";}
                }
                job.task.state=job.cancelRequested?"cancelling":"paused";
                String code=e.getMessage();job.error=code!=null&&code.matches("(FILES_[A-Z_]{1,32}|UPDATE_HOST)")?code:"FILES_CONNECTION";
                // A cancel interrupted a request. One subsequent pass sends cancel;
                // an offline cancellation remains paused until explicitly retried.
                if(job.cancelRequested&&stopMode==2){job.task.state="paused";job.error="FILES_CANCEL_PENDING";}
                try{store.save(job);}catch(IOException ignored){ }
            }
        }finally{
            if(wake.isHeld())wake.release();
        }
    }
    @Override public void onTimeout(int id,int type){stopMode=1;NvHTTP http=connection;if(http!=null)http.cancelFilesRequest();stopSelf();}
    @Override public void onDestroy(){destroyed=true;stopMode=1;NvHTTP http=connection;if(http!=null)http.cancelFilesRequest();worker.shutdownNow();if(current==this)current=null;super.onDestroy();}
    @Override public IBinder onBind(Intent intent){return null;}
}
