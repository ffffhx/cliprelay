package com.limelight.ui;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import com.limelight.R;
import com.limelight.binding.PlatformBinding;
import com.limelight.nvstream.http.ComputerDetails;
import com.limelight.nvstream.http.NvHTTP;
import com.limelight.nvstream.http.PairingManager;
import com.limelight.nvstream.wol.WakeSelection;
import com.limelight.nvstream.wol.WakeState;
import org.json.JSONObject;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Foreground-only setup and wake; a send receipt is never displayed as a successful wake. */
public final class RemoteWake implements AutoCloseable {
    public interface Peers {
        List<ComputerDetails> current();
        String uniqueId();
        void localWake(ComputerDetails computer);
    }
    private interface Done<T> { void accept(T result); }
    private final Activity activity;
    private final Peers peers;
    private final Handler main=new Handler(Looper.getMainLooper());
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private volatile boolean closed;
    private volatile int token;
    private volatile NvHTTP pending;
    private AlertDialog dialog;
    private long deadline;
    private String uniqueId;
    public RemoteWake(Activity activity,Peers peers) {this.activity=activity;this.peers=peers;}
    private boolean usable(){return !closed && !activity.isFinishing() && !activity.isDestroyed();}
    private ComputerDetails find(String id) {
        for(ComputerDetails item:peers.current())if(id.equals(item.uuid))return new ComputerDetails(item);
        return null;
    }
    private boolean online(ComputerDetails computer) {
        return computer!=null && computer.state==ComputerDetails.State.ONLINE && computer.activeAddress!=null &&
                computer.serverCert!=null && computer.pairState==PairingManager.PairState.PAIRED;
    }
    private WakeState status(ComputerDetails computer,int request) throws Exception {
        return new WakeState(call(computer,WakeState.statusRequest(),request));
    }
    private JSONObject call(ComputerDetails computer,JSONObject body,int request) throws Exception {
        if(closed || request!=token || !online(computer))throw new IOException("WAKE_UNAVAILABLE");
        NvHTTP http=new NvHTTP(computer.activeAddress,computer.httpsPort,uniqueId,computer.serverCert,PlatformBinding.getCryptoProvider(activity));
        pending=http;
        try {
            if(closed || request!=token)throw new IOException("WAKE_CANCELLED");
            return http.wakeRequest(body);
        } finally {pending=null;http.cancelWakeRequests();}
    }
    private <T> void run(Callable<T> task,Done<T> done,Runnable failure) {
        int request=token;
        worker.execute(()->{
            try {T result=task.call();main.post(()->{if(usable() && token==request)done.accept(result);});}
            catch(Exception error){main.post(()->{if(usable() && token==request)failure.run();});}
        });
    }
    public void configure(ComputerDetails computer) {
        cancel();uniqueId=peers.uniqueId();
        ComputerDetails current=find(computer.uuid);
        if(!usable() || uniqueId==null || !online(current)){message(R.string.wake_need_online);return;}
        working(R.string.wake_reading);int request=token;
        run(()->status(current,request),state->chooseAdapter(current,state),()->message(R.string.wake_unavailable));
    }
    private void chooseAdapter(ComputerDetails target,WakeState state) {
        dismiss();
        if(state.adapters.isEmpty()){message(R.string.wake_no_adapter);return;}
        String[] labels=new String[state.adapters.size()];
        for(int i=0;i<labels.length;i++) {
            WakeState.Adapter adapter=state.adapters.get(i);
            labels[i]=adapter.name+" — "+activity.getString(configurationLabel(adapter.configuration))+
                    (adapter.connected?"":" · "+activity.getString(R.string.wake_disconnected));
        }
        dialog=new AlertDialog.Builder(activity).setTitle(R.string.wake_adapter).setItems(labels,(d,index)->{
            WakeState.Adapter adapter=state.adapters.get(index);
            if(!adapter.connected || adapter.networks.isEmpty()){message(R.string.wake_need_lan);return;}
            if(adapter.configuration.equals("disabled") || adapter.configuration.equals("unsupported")){message(R.string.wake_hardware_help);return;}
            if(adapter.networks.size()==1)chooseHelper(target,adapter,adapter.networks.get(0));
            else {dismiss();dialog=new AlertDialog.Builder(activity).setTitle(R.string.wake_network)
                    .setItems(adapter.networks.toArray(new String[0]),(n,index2)->chooseHelper(target,adapter,adapter.networks.get(index2)))
                    .setNegativeButton(android.R.string.cancel,null).show();}
        }).setNegativeButton(android.R.string.cancel,null).setNeutralButton(R.string.wake_clear,(d,w)->{
            activity.getSharedPreferences("remote_wake",Context.MODE_PRIVATE).edit().remove(target.uuid).apply();
        }).show();
    }
    private static int configurationLabel(String state) {
        switch(state){case "configured":return R.string.wake_configured;case "disabled":return R.string.wake_disabled;
            case "unsupported":return R.string.wake_unsupported;default:return R.string.wake_unknown;}
    }
    private void chooseHelper(ComputerDetails target,WakeState.Adapter adapter,String network) {
        List<ComputerDetails> helpers=new ArrayList<>();
        for(ComputerDetails candidate:peers.current())if(!candidate.uuid.equals(target.uuid) && online(candidate))helpers.add(new ComputerDetails(candidate));
        dismiss();if(helpers.isEmpty()){message(R.string.wake_no_helper);return;}
        String[] labels=new String[helpers.size()];for(int i=0;i<labels.length;i++)labels[i]=helpers.get(i).name;
        dialog=new AlertDialog.Builder(activity).setTitle(R.string.wake_helper).setItems(labels,(d,index)->{
            ComputerDetails helper=helpers.get(index);working(R.string.wake_reading);int request=token;
            run(()->{
                if(!status(helper,request).hasNetwork(network))throw new IOException("WAKE_NOT_ON_LAN");
                return WakeSelection.create(target.uuid,target.serverCert,adapter,network,helper.uuid,helper.serverCert,System.currentTimeMillis());
            },selection->{
                ComputerDetails now=find(target.uuid),assistant=find(helper.uuid);
                if(now==null || assistant==null || !selection.matches(now.uuid,now.serverCert,System.currentTimeMillis()) ||
                        !selection.matchesHelper(assistant.uuid,assistant.serverCert)){message(R.string.wake_changed);return;}
                try {
                    activity.getSharedPreferences("remote_wake",Context.MODE_PRIVATE).edit().putString(target.uuid,selection.json().toString()).apply();
                    message(R.string.wake_saved);
                }catch(Exception error){message(R.string.wake_unavailable);}
            },()->message(R.string.wake_helper_failed));
        }).setNegativeButton(android.R.string.cancel,null).show();
    }
    public void show(ComputerDetails computer) {
        cancel();uniqueId=peers.uniqueId();
        ComputerDetails target=find(computer.uuid);
        if(!usable() || target==null)return;
        if(target.state==ComputerDetails.State.ONLINE){message(R.string.wol_pc_online);return;}
        WakeSelection saved=null;
        try {
            String raw=activity.getSharedPreferences("remote_wake",Context.MODE_PRIVATE).getString(target.uuid,null);
            if(raw!=null && raw.length()<=4096) {
                WakeSelection parsed=new WakeSelection(new JSONObject(raw));
                if(parsed.matches(target.uuid,target.serverCert,System.currentTimeMillis()))saved=parsed;
            }
        }catch(Exception ignored){}
        final WakeSelection selection=saved;
        ComputerDetails helper=saved==null?null:find(saved.helper);
        boolean ready=uniqueId!=null && selection!=null && online(helper) && selection.matchesHelper(helper.uuid,helper.serverCert);
        String summary=ready?activity.getString(R.string.wake_confirm,target.name,helper.name,selection.network):activity.getString(R.string.wake_no_saved_helper);
        AlertDialog.Builder builder=new AlertDialog.Builder(activity).setTitle(R.string.wake_title).setMessage(summary)
                .setNegativeButton(android.R.string.cancel,null)
                .setNeutralButton(R.string.wake_local,(d,w)->{dismiss();dialog=new AlertDialog.Builder(activity).setTitle(R.string.wake_local)
                    .setMessage(R.string.wake_local_help).setPositiveButton(R.string.wake_send,(c,j)->peers.localWake(target))
                    .setNegativeButton(android.R.string.cancel,null).show();});
        if(ready)builder.setPositiveButton(R.string.wake_send,(d,w)->send(selection));
        dialog=builder.show();
    }
    private void send(WakeSelection selection) {
        ComputerDetails target=find(selection.target),helper=find(selection.helper);
        if(target==null || !selection.matches(target.uuid,target.serverCert,System.currentTimeMillis()) || !online(helper) ||
                !selection.matchesHelper(helper.uuid,helper.serverCert)){message(R.string.wake_changed);return;}
        working(R.string.wake_sending);int request=token;
        String id=UUID.randomUUID().toString().replace("-","");
        run(()->WakeState.sentCount(call(helper,WakeState.sendRequest(id,selection.mac,selection.network),request)),count->{
            deadline=SystemClock.elapsedRealtime()+60000;working(R.string.wake_waiting);
            main.postDelayed(()->{if(usable() && token==request){cancel();message(R.string.wake_timeout);}},60000);
            verify(selection);
        },()->message(R.string.wake_send_uncertain));
    }
    private void verify(WakeSelection selection) {
        if(!usable() || SystemClock.elapsedRealtime()>=deadline)return;
        ComputerDetails target=find(selection.target);int request=token;
        if(target==null || !selection.matches(target.uuid,target.serverCert,System.currentTimeMillis())){cancel();message(R.string.wake_changed);return;}
        Runnable retry=()->main.postDelayed(()->{if(usable() && token==request)verify(selection);},2000);
        if(!online(target)){retry.run();return;}
        run(()->status(target,request),state->{
            if(state.hasTarget(selection.adapter,selection.mac)){cancel();message(R.string.wake_online);}
            else {cancel();message(R.string.wake_changed);}
        },retry);
    }
    private void working(int text){dismiss();dialog=new AlertDialog.Builder(activity).setTitle(R.string.wake_title).setMessage(text)
            .setCancelable(false).setNegativeButton(android.R.string.cancel,(d,w)->cancel()).show();}
    private void message(int text){if(!usable())return;dismiss();dialog=new AlertDialog.Builder(activity).setTitle(R.string.wake_title)
            .setMessage(text).setPositiveButton(android.R.string.ok,null).show();}
    private void dismiss(){if(dialog!=null){dialog.dismiss();dialog=null;}}
    private void cancel(){token++;main.removeCallbacksAndMessages(null);NvHTTP http=pending;if(http!=null)http.cancelWakeRequests();dismiss();}
    public static void forget(Context context,String uuid){context.getSharedPreferences("remote_wake",Context.MODE_PRIVATE).edit().remove(uuid).apply();}
    @Override public void close(){closed=true;cancel();worker.shutdownNow();}
}
