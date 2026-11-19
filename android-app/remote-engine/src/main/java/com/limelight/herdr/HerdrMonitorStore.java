package com.limelight.herdr;

import android.content.Context;
import android.util.AtomicFile;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** App-private, no-backup subscriptions and unread receipts; never stores chat bodies. */
public final class HerdrMonitorStore {
    public static final class Target {
        public JSONObject host;
        public final String core;
        public boolean enabled=true;
        public String error="";
        public final HerdrEventLedger ledger;
        Target(JSONObject host,String core,HerdrEventLedger ledger){this.host=host;this.core=core;this.ledger=ledger;}
        public String key(){return host.optString("uuid")+":"+core;}
    }
    private static HerdrMonitorStore singleton;
    public static synchronized HerdrMonitorStore get(Context context) throws IOException {
        if(singleton==null)singleton=new HerdrMonitorStore(context.getApplicationContext());return singleton;
    }
    private final AtomicFile file;
    private final LinkedHashMap<String,Target> targets=new LinkedHashMap<>();
    private HerdrMonitorStore(Context context)throws IOException{
        file=new AtomicFile(new File(context.getNoBackupFilesDir(),"herdr-notifications.json"));
        if(file.getBaseFile().exists())try{
            byte[] bytes=file.readFully();if(bytes.length>1024*1024)throw new IOException("通知记录过大");
            JSONArray saved=new JSONArray(new String(bytes,StandardCharsets.UTF_8));
            for(int i=0;i<Math.min(saved.length(),8);i++){
                JSONObject row=saved.getJSONObject(i);Target t=new Target(row.getJSONObject("host"),row.getString("core"),new HerdrEventLedger(row.getJSONObject("ledger")));
                t.enabled=row.optBoolean("enabled");t.error=row.optString("error");targets.put(t.key(),t);
            }
        }catch(JSONException e){throw new IOException("通知记录无法读取",e);}
    }
    public synchronized List<Target> targets(){return new ArrayList<>(targets.values());}
    public synchronized Target find(String uuid,String core){return targets.get(uuid+":"+core);}
    public synchronized Target register(JSONObject host,String core)throws IOException,JSONException{
        String key=host.getString("uuid")+":"+core;Target t=targets.get(key);
        if(t==null){if(targets.size()>=8)throw new IOException("最多订阅 8 个电脑工作区");t=new Target(new JSONObject(host.toString()),core,new HerdrEventLedger());targets.put(key,t);}
        else if(!t.host.optString("cert").equals(host.optString("cert"))){t=new Target(new JSONObject(host.toString()),core,new HerdrEventLedger());targets.put(key,t);}
        else t.host=new JSONObject(host.toString());save();return t;
    }
    public synchronized void save()throws IOException{
        FileOutputStream output=null;
        try{JSONArray values=new JSONArray();for(Target t:targets.values())values.put(new JSONObject().put("host",t.host).put("core",t.core).put("enabled",t.enabled).put("error",t.error).put("ledger",t.ledger.json()));
            output=file.startWrite();output.write(values.toString().getBytes(StandardCharsets.UTF_8));file.finishWrite(output);
        }catch(Exception e){if(output!=null)file.failWrite(output);throw new IOException("无法保存通知状态",e);}
    }
}
