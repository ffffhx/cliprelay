package com.limelight.files;

import android.app.*;
import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.os.*;
import android.provider.OpenableColumns;
import android.view.*;
import android.widget.*;
import com.limelight.R;
import com.limelight.nvstream.http.NvHTTP;
import org.json.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;

/** Browse a paired computer and manage durable bidirectional transfer batches. */
public final class FileTransferActivity extends Activity {
    private static final int UPLOAD=91,DOWNLOAD=92;
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final Handler main=new Handler(Looper.getMainLooper());
    private TransferStorage store;
    private JSONObject host;
    private NvHTTP http;
    private LinearLayout entries,queue;
    private TextView location,message;
    private Button upload,download,parent,more;
    private String root="",path="",next="";
    private final LinkedHashSet<String> selected=new LinkedHashSet<>();
    private ArrayList<String> pendingDownloads;
    private String pickerRoot,pickerPath;
    private int generation;
    private boolean loading;
    private String queueSignature;
    private final Map<String,TextView> queueLabels=new HashMap<>();
    private final Map<String,ProgressBar> queueProgress=new HashMap<>();
    private final Runnable refreshQueue=new Runnable(){public void run(){renderQueue();main.postDelayed(this,1000);}};
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
    private TextView text(String value,int size){TextView view=new TextView(this);view.setText(value);view.setTextColor(0xffedf3ff);view.setTextSize(size);view.setPadding(dp(4),dp(8),dp(4),dp(8));return view;}
    private Button button(LinearLayout row,int title,Runnable click){Button b=new Button(this);b.setText(title);b.setTextSize(13);b.setAllCaps(false);row.addView(b,new LinearLayout.LayoutParams(0,-2,1));b.setOnClickListener(v->click.run());return b;}
    @Override public void onCreate(Bundle saved){
        super.onCreate(saved);
        try{host=TransferStorage.host(getIntent());store=TransferStorage.get(this);http=TransferStorage.connection(this,host);}
        catch(Exception e){Toast.makeText(this,R.string.files_unpaired,Toast.LENGTH_LONG).show();finish();return;}
        LinearLayout page=new LinearLayout(this);page.setOrientation(LinearLayout.VERTICAL);page.setPadding(dp(12),dp(10),dp(12),dp(10));page.setBackgroundColor(0xff142033);
        page.addView(text(getString(R.string.files_title)+" · "+host.optString("name"),21));
        location=text("",14);page.addView(location);
        LinearLayout navigation=new LinearLayout(this);button(navigation,R.string.files_roots,this::roots);parent=button(navigation,R.string.files_parent,()->{int slash=path.lastIndexOf('/');path=slash<0?"":path.substring(0,slash);list(false);});
        button(navigation,R.string.files_new_folder,this::mkdir);page.addView(navigation);
        LinearLayout actions=new LinearLayout(this);upload=button(actions,R.string.files_upload,this::pickUpload);download=button(actions,R.string.files_download,this::pickDownload);page.addView(actions);
        message=text(getString(R.string.files_loading),13);page.addView(message);
        ScrollView browser=new ScrollView(this);entries=new LinearLayout(this);entries.setOrientation(LinearLayout.VERTICAL);browser.addView(entries);page.addView(browser,new LinearLayout.LayoutParams(-1,0,1));
        LinearLayout paging=new LinearLayout(this);more=button(paging,R.string.files_more,()->list(true));page.addView(paging);
        page.addView(text(getString(R.string.files_queue),17));
        ScrollView transfers=new ScrollView(this);queue=new LinearLayout(this);queue.setOrientation(LinearLayout.VERTICAL);transfers.addView(queue);page.addView(transfers,new LinearLayout.LayoutParams(-1,0,1));
        LinearLayout footer=new LinearLayout(this);button(footer,R.string.files_pause_all,()->{for(TransferStorage.Job job:store.jobs())if(TransferStorage.sameHost(host,job.host)&&!job.terminal())control(job,false);});button(footer,R.string.files_back,this::finish);page.addView(footer);setContentView(page);
        if(saved!=null){root=saved.getString("root","");path=saved.getString("path","");pickerRoot=saved.getString("pickerRoot");pickerPath=saved.getString("pickerPath");pendingDownloads=saved.getStringArrayList("pendingDownloads");}
        if(root.isEmpty())roots();else list(false);
    }
    private void busy(boolean value){loading=value;upload.setEnabled(!value&&!root.isEmpty());download.setEnabled(!value&&!selected.isEmpty());parent.setEnabled(!value&&!path.isEmpty());more.setEnabled(!value&&!next.isEmpty());}
    private void request(JSONObject request,java.util.function.Consumer<JSONObject> success){
        busy(true);message.setText(R.string.files_loading);final int token=++generation;
        worker.execute(()->{try{JSONObject result=http.filesRequest(request);runOnUiThread(()->{if(isDestroyed()||token!=generation)return;busy(false);message.setText("");success.accept(result);});}
            catch(Exception error){runOnUiThread(()->{if(isDestroyed()||token!=generation)return;busy(false);message.setText(errorText(error.getMessage()));});}});
    }
    private JSONObject request(String operation){try{return new JSONObject().put("op",operation).put("root",root).put("path",path);}catch(JSONException e){throw new IllegalStateException(e);}}
    private String rootName(String value){switch(value){case "home":return getString(R.string.files_home);case "desktop":return getString(R.string.files_desktop);case "documents":return getString(R.string.files_documents);case "downloads":return getString(R.string.files_downloads);default:return value;}}
    private void roots(){
        root="";path="";next="";selected.clear();location.setText(R.string.files_choose_root);
        request(request("roots"),result->{entries.removeAllViews();JSONArray roots=result.optJSONArray("roots");if(roots!=null)for(int n=0;n<roots.length();n++){JSONObject item=roots.optJSONObject(n);if(item==null)continue;String id=item.optString("id");Button b=new Button(this);b.setText(rootName(id));entries.addView(b);b.setOnClickListener(v->{root=id;path="";list(false);});}busy(false);});
    }
    private void list(boolean append){
        if(root.isEmpty()){roots();return;}if(!append){selected.clear();entries.removeAllViews();next="";}
        location.setText(rootName(root)+(path.isEmpty()?"":" / "+path));
        JSONObject request=request("list");try{request.put("after",append?next:"");}catch(JSONException ignored){}
        request(request,result->{next=result.optString("next");JSONArray files=result.optJSONArray("entries");if(files!=null)for(int n=0;n<files.length();n++){
            JSONObject file=files.optJSONObject(n);if(file==null)continue;String name=file.optString("name");boolean blocked=file.optBoolean("blocked");
            if(file.optBoolean("directory")){Button b=new Button(this);b.setAllCaps(false);b.setText("▸ "+name);b.setEnabled(!blocked);entries.addView(b);b.setOnClickListener(v->{path=path.isEmpty()?name:path+"/"+name;list(false);});}
            else{CheckBox b=new CheckBox(this);b.setText(name+"  ·  "+size(file.optLong("size")));b.setTextColor(0xffedf3ff);b.setEnabled(!blocked);entries.addView(b);b.setOnCheckedChangeListener((v,checked)->{if(checked)selected.add(name);else selected.remove(name);busy(loading);});}
        }busy(false);});
    }
    private void mkdir(){
        if(loading||root.isEmpty())return;EditText name=new EditText(this);name.setSingleLine(true);
        new AlertDialog.Builder(this).setTitle(R.string.files_new_folder).setView(name).setNegativeButton(android.R.string.cancel,null)
                .setPositiveButton(android.R.string.ok,(d,w)->{JSONObject query=request("mkdir");try{query.put("name",name.getText().toString());}catch(JSONException ignored){}request(query,result->list(false));}).show();
    }
    private void pickUpload(){
        if(loading||root.isEmpty())return;pickerRoot=root;pickerPath=path;
        try{startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION),UPLOAD);}
        catch(ActivityNotFoundException e){message.setText(R.string.files_picker_missing);}
    }
    private void pickDownload(){
        if(loading||selected.isEmpty())return;pendingDownloads=new ArrayList<>(selected);pickerRoot=root;pickerPath=path;
        try{startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION),DOWNLOAD);}
        catch(ActivityNotFoundException e){message.setText(R.string.files_picker_missing);}
    }
    @Override protected void onActivityResult(int request,int result,Intent data){
        super.onActivityResult(request,result,data);if(result!=RESULT_OK||data==null)return;
        if(request!=UPLOAD&&request!=DOWNLOAD)return;
        ArrayList<Uri> uris=new ArrayList<>();if(data.getClipData()!=null){for(int i=0;i<data.getClipData().getItemCount();i++)uris.add(data.getClipData().getItemAt(i).getUri());}else if(data.getData()!=null)uris.add(data.getData());
        if(uris.isEmpty())return;final String targetRoot=pickerRoot,targetPath=pickerPath;final ArrayList<String> names=pendingDownloads;
        busy(true);worker.execute(()->{
            String failure=null;int added=0;
            try{
                for(Uri uri:uris){
                    int permissions=Intent.FLAG_GRANT_READ_URI_PERMISSION|(request==DOWNLOAD?Intent.FLAG_GRANT_WRITE_URI_PERMISSION:0);
                    getContentResolver().takePersistableUriPermission(uri,permissions);
                    if(request==UPLOAD){
                        String name=null;try(Cursor cursor=getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)){if(cursor!=null&&cursor.moveToFirst())name=cursor.getString(0);}
                        if(name==null||name.isBlank())throw new IOException("FILES_SOURCE_CHANGED");
                        TransferStorage.Job job=new TransferStorage.Job(new TransferRunner.Task(TransferStorage.id(),"upload",targetRoot,targetPath,name),host);job.source=uri.toString();store.add(job);added++;
                    }else if(names!=null)for(String name:names){TransferStorage.Job job=new TransferStorage.Job(new TransferRunner.Task(TransferStorage.id(),"download",targetRoot,targetPath,name),host);job.tree=uri.toString();store.add(job);added++;}
                }
            }catch(Exception e){failure=errorText(e.getMessage());}
            final String error=failure;final int count=added;runOnUiThread(()->{if(isDestroyed())return;busy(false);message.setText(error==null?getString(R.string.files_added,count):error);renderQueue();if(count>0)startQueue();});
        });
    }
    private void startQueue(){try{TransferService.start(this);}catch(RuntimeException e){
        for(TransferStorage.Job job:store.jobs())if(job.task.state.equals("queued")){job.task.state="paused";try{store.save(job);}catch(IOException ignored){}}
        message.setText(R.string.files_start_failed);renderQueue();
    }}
    private void control(TransferStorage.Job job,boolean cancel){try{TransferService.control(this,job,cancel);}catch(Exception e){message.setText(errorText(e.getMessage()));}renderQueue();}
    private void resume(TransferStorage.Job job){
        try{synchronized(store){job.host=host;job.error="";job.task.state=job.cancelRequested?"cancelling":"queued";store.save(job);}startQueue();}catch(IOException e){message.setText(errorText(e.getMessage()));}renderQueue();
    }
    private static String size(long bytes){if(bytes<0)return "—";String[] unit={"B","KB","MB","GB","TB"};double number=bytes;int i=0;while(number>=1024&&i<unit.length-1){number/=1024;i++;}return String.format(Locale.getDefault(),i==0?"%.0f %s":"%.1f %s",number,unit[i]);}
    private String state(String value){switch(value){case "queued":return getString(R.string.files_queued);case "hashing":case "verifying":return getString(R.string.files_verifying);case "receiving":return getString(R.string.files_receiving);case "sending":return getString(R.string.files_sending);case "saving":case "ready-to-save":return getString(R.string.files_saving);case "complete":return getString(R.string.files_complete);case "cancelled":return getString(R.string.files_cancelled);case "cancelling":return getString(R.string.files_cancelling);case "pausing":return getString(R.string.files_pausing);default:return getString(R.string.files_paused);}}
    private void renderQueue(){
        if(queue==null)return;List<TransferStorage.Job> all=store.jobs();Collections.reverse(all);
        StringBuilder signature=new StringBuilder();for(TransferStorage.Job job:all)if(TransferStorage.sameHost(host,job.host))signature.append(job.task.id).append(job.task.state).append(job.error).append(job.cancelRequested);
        if(signature.toString().equals(queueSignature)){for(TransferStorage.Job job:all)updateProgress(job);return;}
        queueSignature=signature.toString();queue.removeAllViews();queueLabels.clear();queueProgress.clear();
        for(TransferStorage.Job job:all){if(!TransferStorage.sameHost(host,job.host))continue;TransferRunner.Task task=job.task;
            TextView label=text("",14);queueLabels.put(task.id,label);queue.addView(label);
            ProgressBar progress=new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal);queueProgress.put(task.id,progress);queue.addView(progress);updateProgress(job);
            if(!job.error.isEmpty())queue.addView(text(errorText(job.error),12));
            LinearLayout actions=new LinearLayout(this);
            if(job.terminal())button(actions,R.string.files_clear,()->{try{store.forget(job);}catch(IOException e){message.setText(errorText(e.getMessage()));}renderQueue();});
            else{
                if(task.state.equals("paused")||task.state.equals("queued"))button(actions,job.cancelRequested?R.string.files_retry_cancel:R.string.files_resume,()->resume(job));
                else button(actions,R.string.files_pause,()->control(job,false));
                button(actions,R.string.files_cancel,()->control(job,true));
            }
            queue.addView(actions);
        }
        if(queueLabels.isEmpty())queue.addView(text(getString(R.string.files_empty),14));
    }
    private void updateProgress(TransferStorage.Job job){
        TransferRunner.Task task=job.task;TextView label=queueLabels.get(task.id);if(label==null)return;
        long count=task.state.equals("hashing")||task.state.equals("verifying")||task.state.equals("saving")?task.verified:task.offset;
        String name=task.name;
        if(task.state.equals("complete")){String completedName=task.direction.equals("upload")?task.finalName:job.finalName;if(!completedName.isEmpty())name=completedName;}
        label.setText((task.direction.equals("upload")?"↑ ":"↓ ")+name+"\n"+state(task.state)+" · "+size(count)+" / "+size(task.size));
        ProgressBar progress=queueProgress.get(task.id);progress.setIndeterminate(task.size<0);progress.setMax(100);progress.setProgress(task.size>0?(int)Math.min(100,count*100/task.size):job.terminal()?100:0);
    }
    private String errorText(String code){
        if(code==null)return getString(R.string.files_connection);
        switch(code){case "UPDATE_HOST":return getString(R.string.files_update_host);case "FILES_UNPAIRED":return getString(R.string.files_unpaired);
            case "FILES_DISK_FULL":return getString(R.string.files_disk_full);case "FILES_HASH_MISMATCH":case "FILES_SOURCE_CHANGED":case "FILES_CHUNK_CONFLICT":return getString(R.string.files_changed);
            case "FILES_LINK_NOT_ALLOWED":return getString(R.string.files_link);case "FILES_BAD_PATH":case "FILES_BAD_REQUEST":return getString(R.string.files_bad_path);
            case "FILES_QUEUE_FULL":return getString(R.string.files_queue_full);case "FILES_CANCEL_PENDING":return getString(R.string.files_cancel_pending);
            case "FILES_INTERRUPTED":case "FILES_PAUSED":return getString(R.string.files_interrupted);
            case "FILES_RENAME_UNSUPPORTED":case "FILES_DESTINATION":case "FILES_DESTINATION_CHANGED":return getString(R.string.files_destination_error);
            case "FILES_ACCESS_DENIED":return getString(R.string.files_access_denied);default:return getString(R.string.files_connection);}
    }
    @Override protected void onResume(){super.onResume();main.post(refreshQueue);}
    @Override protected void onPause(){main.removeCallbacks(refreshQueue);super.onPause();}
    @Override protected void onSaveInstanceState(Bundle out){super.onSaveInstanceState(out);out.putString("root",root);out.putString("path",path);out.putString("pickerRoot",pickerRoot);out.putString("pickerPath",pickerPath);out.putStringArrayList("pendingDownloads",pendingDownloads);}
    @Override protected void onDestroy(){generation++;if(http!=null)http.cancelFilesRequest();worker.shutdownNow();main.removeCallbacks(refreshQueue);super.onDestroy();}
}
