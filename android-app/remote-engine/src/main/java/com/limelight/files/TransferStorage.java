package com.limelight.files;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.AtomicFile;
import com.limelight.Game;
import com.limelight.binding.PlatformBinding;
import com.limelight.nvstream.http.ComputerDetails;
import com.limelight.nvstream.http.NvHTTP;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.cert.*;
import java.util.*;

/** Private journals are excluded from backup and never contain private TLS keys. */
public final class TransferStorage {
    public static final class Job {
        public final TransferRunner.Task task;
        public JSONObject host;
        public String source="", tree="", output="", finalName="", error="";
        public volatile boolean cancelRequested;
        public Job(TransferRunner.Task task,JSONObject host){this.task=task;this.host=host;}
        Job(JSONObject json) throws JSONException {
            this(new TransferRunner.Task(json.getJSONObject("task")),json.getJSONObject("host"));
            source=json.optString("source");tree=json.optString("tree");output=json.optString("output");
            finalName=json.optString("finalName");error=json.optString("error");cancelRequested=json.optBoolean("cancelRequested");
        }
        public JSONObject json() throws JSONException {
            return new JSONObject().put("task",task.json()).put("host",host).put("source",source).put("tree",tree)
                    .put("output",output).put("finalName",finalName).put("error",error).put("cancelRequested",cancelRequested);
        }
        public boolean terminal(){return task.state.equals("complete")||task.state.equals("cancelled");}
    }
    private static TransferStorage singleton;
    public static synchronized TransferStorage get(Context context) throws IOException {
        if(singleton==null)singleton=new TransferStorage(context.getApplicationContext());return singleton;
    }
    private final File directory;
    private final LinkedHashMap<String,Job> jobs=new LinkedHashMap<>();
    TransferStorage(Context context) throws IOException {
        directory=new File(context.getNoBackupFilesDir(),"file-transfers");
        if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("FILES_DISK_FULL");
        File[] files=directory.listFiles((dir,name)->name.matches("[0-9a-f]{32}\\.json"));
        if(files==null)throw new IOException("FILES_IO");
        Arrays.sort(files,Comparator.comparingLong(File::lastModified));
        for(File file:files) {
            if(file.length()>64*1024)continue;
            try {
                Job job=new Job(new JSONObject(new String(new AtomicFile(file).readFully(),StandardCharsets.UTF_8)));
                if(!file.getName().equals(job.task.id+".json"))continue;
                // User resumes after process death; reopening a page never silently uploads.
                if(!job.terminal()){job.task.state="paused";job.error="FILES_INTERRUPTED";}
                jobs.put(job.task.id,job);
            }catch(JSONException|IOException ignored){ /* Leave corrupt journals untouched. */ }
        }
    }
    public synchronized List<Job> jobs(){return new ArrayList<>(jobs.values());}
    public synchronized Job get(String id){return jobs.get(id);}
    public synchronized void add(Job job) throws IOException {
        if(jobs.size()>=128)throw new IOException("FILES_QUEUE_FULL");
        save(job);jobs.put(job.task.id,job);
    }
    public synchronized void save(Job job) throws IOException {
        AtomicFile file=new AtomicFile(new File(directory,job.task.id+".json"));FileOutputStream stream=null;
        try {
            byte[] bytes=job.json().toString().getBytes(StandardCharsets.UTF_8);
            stream=file.startWrite();stream.write(bytes);file.finishWrite(stream);
        }catch(JSONException e){if(stream!=null)file.failWrite(stream);throw new IOException("FILES_INVALID_STATE",e);}
        catch(IOException e){if(stream!=null)file.failWrite(stream);throw e;}
    }
    public synchronized void forget(Job job) throws IOException {
        if(!job.terminal())throw new IOException("FILES_NOT_READY");
        File part=part(job);if(part.exists()&&!part.delete())throw new IOException("FILES_IO");
        new AtomicFile(new File(directory,job.task.id+".json")).delete();jobs.remove(job.task.id);
    }
    public File part(Job job){return new File(directory,job.task.id+".part");}
    public static JSONObject host(Intent intent) throws JSONException {
        byte[] cert=intent.getByteArrayExtra(Game.EXTRA_SERVER_CERT);
        if(cert==null||cert.length>16384)throw new JSONException("Unpaired host");
        return new JSONObject().put("address",intent.getStringExtra(Game.EXTRA_HOST)).put("port",intent.getIntExtra(Game.EXTRA_PORT,NvHTTP.DEFAULT_HTTP_PORT))
                .put("https",intent.getIntExtra(Game.EXTRA_HTTPS_PORT,0)).put("uniqueId",intent.getStringExtra(Game.EXTRA_UNIQUEID))
                .put("uuid",intent.getStringExtra(Game.EXTRA_PC_UUID)).put("name",intent.getStringExtra(Game.EXTRA_PC_NAME))
                .put("cert",Base64.getEncoder().encodeToString(cert));
    }
    public static Intent intent(Context context,JSONObject host) {
        return new Intent(context,FileTransferActivity.class).putExtra(Game.EXTRA_HOST,host.optString("address"))
                .putExtra(Game.EXTRA_PORT,host.optInt("port",NvHTTP.DEFAULT_HTTP_PORT)).putExtra(Game.EXTRA_HTTPS_PORT,host.optInt("https"))
                .putExtra(Game.EXTRA_UNIQUEID,host.optString("uniqueId")).putExtra(Game.EXTRA_PC_UUID,host.optString("uuid"))
                .putExtra(Game.EXTRA_PC_NAME,host.optString("name")).putExtra(Game.EXTRA_SERVER_CERT,Base64.getDecoder().decode(host.optString("cert")));
    }
    public static boolean sameHost(JSONObject a,JSONObject b){return a.optString("cert").equals(b.optString("cert"))&&a.optString("uuid").equals(b.optString("uuid"));}
    public static NvHTTP connection(Context context,JSONObject host) throws IOException {
        try {
            X509Certificate cert=(X509Certificate)CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(Base64.getDecoder().decode(host.getString("cert"))));
            return new NvHTTP(new ComputerDetails.AddressTuple(host.getString("address"),host.getInt("port")),host.optInt("https"),host.getString("uniqueId"),cert,PlatformBinding.getCryptoProvider(context));
        }catch(JSONException|CertificateException|IllegalArgumentException e){throw new IOException("FILES_UNPAIRED",e);}
    }
    public static String id(){return UUID.randomUUID().toString().replace("-","");}
}
