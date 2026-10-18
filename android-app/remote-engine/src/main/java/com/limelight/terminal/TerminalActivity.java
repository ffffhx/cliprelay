package com.limelight.terminal;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.text.InputType;
import android.os.*;
import android.view.*;
import android.view.inputmethod.EditorInfo;
import android.widget.*;
import com.limelight.R;
import com.limelight.files.TransferStorage;
import com.limelight.computers.ComputerDatabaseManager;
import com.limelight.computers.StreamRouteRecovery;
import com.limelight.nvstream.http.ComputerDetails;
import com.limelight.nvstream.http.NvHTTP;
import com.termux.view.RemoteTerminalView;
import org.json.*;
import java.io.IOException;
import java.util.*;
import java.util.concurrent.*;

/** Foreground-only terminal client. Shell lifetime is owned by the host, not this Activity. */
public final class TerminalActivity extends Activity implements RemoteTerminalView.Listener {
    private final Handler main=new Handler(Looper.getMainLooper());
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private JSONObject host, action;
    private TerminalProtocol.Reply inventory;
    private TerminalSessionState session;
    private RemoteTerminalView screen;
    private TextView status, notice,selectionHint;
    private Button sessionsButton,newButton,closeButton,retryButton,selectButton,copyButton,pasteButton,mouseButton;
    private volatile boolean foreground;
    private volatile int epoch;
    private boolean busy,needList=true,connected,resolveRoute,halted,updating;
    private int desiredColumns=80,desiredRows=24,failures;
    private long replayUntil;
    private final TerminalInputSchedule inputSchedule=new TerminalInputSchedule();
    private volatile NvHTTP transport;
    private Future<?> task;
    private AlertDialog dialog;
    private final Runnable tick=this::pump;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        try{host=TransferStorage.host(getIntent());}catch(JSONException e){finish();return;}
        LinearLayout page=new LinearLayout(this);page.setOrientation(LinearLayout.VERTICAL);page.setBackgroundColor(0xff11151d);
        int pad=dp(8);page.setPadding(pad,pad,pad,pad);
        status=label(getString(R.string.terminal_title)+" · "+host.optString("name"),16);page.addView(status);
        notice=label(getString(R.string.terminal_lifetime),12);page.addView(notice);
        LinearLayout buttons=row(page);
        sessionsButton=button(buttons,R.string.terminal_sessions,()->showSessions());
        newButton=button(buttons,R.string.terminal_new,()->showNew());
        closeButton=button(buttons,R.string.terminal_close,()->closeSession());
        retryButton=button(buttons,R.string.terminal_retry,()->{halted=false;needList=true;failures=0;resolveRoute=true;update();schedule(0);});
        selectionHint=label(getString(R.string.terminal_selection_hint),12);selectionHint.setVisibility(View.GONE);page.addView(selectionHint);
        screen=new RemoteTerminalView(this,this);page.addView(screen,new LinearLayout.LayoutParams(-1,0,1));
        HorizontalScrollView keys=new HorizontalScrollView(this);LinearLayout keyRow=new LinearLayout(this);keys.addView(keyRow);page.addView(keys);
        selectButton=button(keyRow,R.string.terminal_select,()->{screen.selecting(!screen.selecting());update();schedule(0);});
        copyButton=button(keyRow,R.string.terminal_copy,()->copySelection());
        pasteButton=button(keyRow,R.string.terminal_paste,()->showPaste());
        mouseButton=button(keyRow,R.string.terminal_mouse,()->{screen.mouseEnabled(!screen.mouseEnabled());update();});
        mouseButton.setTooltipText(getString(R.string.terminal_mouse_requires_tracking));
        button(keyRow,R.string.terminal_keyboard,()->screen.keyboard());
        button(keyRow,"Esc",()->screen.key(KeyEvent.KEYCODE_ESCAPE));button(keyRow,"Tab",()->screen.key(KeyEvent.KEYCODE_TAB));
        button(keyRow,"Ctrl+C",()->screen.send("\u0003"));button(keyRow,"Ctrl+D",()->screen.send("\u0004"));
        button(keyRow,"Ctrl+Z",()->screen.send("\u001a"));button(keyRow,"↑",()->screen.key(KeyEvent.KEYCODE_DPAD_UP));
        button(keyRow,"↓",()->screen.key(KeyEvent.KEYCODE_DPAD_DOWN));button(keyRow,"←",()->screen.key(KeyEvent.KEYCODE_DPAD_LEFT));
        button(keyRow,"→",()->screen.key(KeyEvent.KEYCODE_DPAD_RIGHT));button(keyRow,"Home",()->screen.key(KeyEvent.KEYCODE_MOVE_HOME));
        button(keyRow,"End",()->screen.key(KeyEvent.KEYCODE_MOVE_END));button(keyRow,"Del",()->screen.key(KeyEvent.KEYCODE_FORWARD_DEL));
        button(keyRow,"Enter",()->screen.send("\r"));
        setContentView(page);update();
        // Apply system bars and keyboard insets on edge-to-edge Android versions.
        page.setOnApplyWindowInsetsListener((v,insets)->{
            if(Build.VERSION.SDK_INT>=30){android.graphics.Insets bars=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.ime());v.setPadding(pad+bars.left,pad+bars.top,pad+bars.right,pad+bars.bottom);}
            else v.setPadding(pad+insets.getSystemWindowInsetLeft(),pad+insets.getSystemWindowInsetTop(),pad+insets.getSystemWindowInsetRight(),pad+insets.getSystemWindowInsetBottom());
            return insets;
        });
    }
    private int dp(int value){return (int)(value*getResources().getDisplayMetrics().density+.5f);}
    private TextView label(String text,int size){TextView view=new TextView(this);view.setText(text);view.setTextColor(0xffeeeeee);view.setTextSize(size);view.setPadding(0,dp(4),0,dp(4));return view;}
    private LinearLayout row(LinearLayout page){LinearLayout row=new LinearLayout(this);page.addView(row);return row;}
    private Button button(LinearLayout parent,int text,Runnable action){return button(parent,getString(text),action);}
    private Button button(LinearLayout parent,String text,Runnable action){Button b=new Button(this);b.setText(text);b.setTextSize(12);b.setMinWidth(0);b.setMinimumWidth(0);b.setPadding(dp(8),0,dp(8),0);b.setOnClickListener(v->action.run());parent.addView(b,new LinearLayout.LayoutParams(-2,dp(48)));return b;}
    @Override protected void onStart(){super.onStart();foreground=true;needList=true;halted=false;connected=false;epoch++;schedule(0);}
    @Override protected void onPause(){if(session!=null)session.mouse.stop();if(screen!=null)screen.mouseEnabled(false);super.onPause();}
    @Override protected void onStop(){
        foreground=false;connected=false;epoch++;main.removeCallbacks(tick);if(dialog!=null){dialog.dismiss();dialog=null;}
        NvHTTP http=transport;transport=null;if(http!=null)http.cancelTerminalRequests();
        if(task!=null)task.cancel(true);busy=false;
        if(session!=null){session.mouse.stop();if(session.discardUnsent())notice.setText(R.string.terminal_discarded);}
        if(screen!=null){screen.accepting(false);screen.selecting(false);screen.inputBlocked(false);}super.onStop();
    }
    @Override protected void onDestroy(){worker.shutdownNow();super.onDestroy();}
    private void schedule(long delay){main.removeCallbacks(tick);if(foreground && !halted)main.postDelayed(tick,delay);}
    private boolean canInput(){return foreground && connected && !halted && !needList && action==null && session!=null && session.snapshot.running();}
    private boolean canMouseInput(){return canInput() && hasWindowFocus() && inventory!=null && inventory.mouseProtocol==1
            && session.snapshot.mouse!=null && session.snapshot.mouse.available()
            && screen.displayReady(Math.max(replayUntil,session.snapshot.mouse.offset),desiredColumns,desiredRows)
            && session.snapshot.columns==desiredColumns && session.snapshot.rows==desiredRows;}
    @Override public boolean input(byte[] bytes){
        if(!canInput() || !session.enqueue(bytes)){Toast.makeText(this,R.string.terminal_input_wait,Toast.LENGTH_SHORT).show();return false;}
        schedule(0);return true;
    }
    @Override public boolean mouseEvent(TerminalMouseState.Event event){
        if(!canMouseInput() || dialog!=null || !screen.mouseEnabled() || screen.selecting())return false;
        try{
            TerminalProtocol.Session s=session.snapshot;
            TerminalProtocol.require(s.mouse.format==1016 || event.column<=s.columns && event.row<=s.rows);
            TerminalProtocol.require(s.mouse.format!=0 || event.column<=223 && event.row<=223);
            session.mouse.enqueue(event);schedule(0);return true;
        }catch(JSONException error){session.mouse.stop();notice.setText(R.string.terminal_mouse_stopped);update();schedule(0);return false;}
    }
    @Override public boolean mouseHeartbeat(long revision){
        if(!canMouseInput() || dialog!=null || screen.selecting() || !screen.mouseEnabled())return false;
        try{session.mouse.heartbeat(revision);schedule(0);return true;}catch(JSONException error){return false;}
    }
    @Override public void mouseCancelled(){if(session!=null){session.mouse.stop();schedule(0);}update();}
    @Override public void displayed(){update();}
    @Override public void size(int columns,int rows){if(session!=null)session.mouse.stop();desiredColumns=columns;desiredRows=rows;update();schedule(0);}
    @Override public void selectionChanged(){update();}
    @Override public void mouseChanged(){update();}
    @Override public void mouseUnavailable(){toast(R.string.terminal_mouse_position_unavailable);}
    private void update(){
        if(screen==null || updating)return;updating=true;
        try {
        screen.accepting(canInput());
        boolean modal=dialog!=null && dialog.isShowing(), selecting=screen.selecting();
        screen.inputBlocked(modal);
        screen.configureMouse(inventory!=null && inventory.mouseProtocol==1 && session!=null?session.snapshot.mouse:null,
                session==null?0:session.mouse.revision(),!modal && !selecting && canMouseInput());
        boolean controls=foreground && !modal && !selecting && connected && !busy && action==null;
        sessionsButton.setEnabled(controls && (session==null || !session.hasInput()));
        newButton.setEnabled(controls && !needList && inventory!=null && (session==null || !session.hasInput()));
        closeButton.setEnabled(controls && session!=null && session.snapshot.running());
        retryButton.setEnabled(foreground && !modal && !selecting && !busy);
        // View construction calls selectionChanged before these buttons are assigned.
        if(selectButton!=null){
            selectButton.setText(selecting?R.string.terminal_resume:R.string.terminal_select);
            selectButton.setEnabled(foreground && !modal && session!=null && connected && !halted && !needList && action==null);
            copyButton.setEnabled(foreground && !modal && selecting && !busy && screen.hasSelection());
            pasteButton.setEnabled(controls && canInput() && !session.hasInput() && transport!=null);
            if(mouseButton!=null){
                mouseButton.setText(screen.mouseEnabled()?R.string.terminal_mouse_stop:R.string.terminal_mouse);
                mouseButton.setEnabled(foreground && !modal && !selecting && (screen.mouseEnabled() || (canMouseInput() && screen.mouseAvailable())));
            }
            boolean oldMouse=inventory!=null && inventory.mouseProtocol==0 && screen.legacyMouseRequested();
            selectionHint.setVisibility(selecting || screen.mouseEnabled() || oldMouse?View.VISIBLE:View.GONE);
            selectionHint.setText(selecting?(busy?R.string.terminal_selection_wait:R.string.terminal_selection_hint):oldMouse?R.string.terminal_mouse_update:R.string.terminal_mouse_hint);
        }
        if(connected){String detail=session==null?getString(R.string.terminal_choose):session.snapshot.shell+" · "+session.id.substring(0,6)+" · "+getString(session.snapshot.running()?R.string.terminal_running:R.string.terminal_finished);
            if(session!=null && !session.snapshot.running())detail+=" ("+session.snapshot.exitCode+")";
            status.setText(getString(R.string.terminal_title)+" · "+detail);}
        } finally {updating=false;}
    }
    private void modal(){
        AlertDialog owned=dialog;
        owned.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        owned.setOnDismissListener(d->{if(dialog==owned){dialog=null;update();schedule(0);}});update();
    }
    private void toast(int message){Toast.makeText(this,message,Toast.LENGTH_SHORT).show();}
    private void copySelection(){
        if(!foreground || busy || dialog!=null || !screen.selecting() || !screen.hasSelection())return;
        String text=screen.selectedText();if(text.isEmpty())return;
        if(text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length>262144){toast(R.string.terminal_copy_limit);return;}
        try {
            ClipData clip=ClipData.newPlainText(getString(R.string.terminal_title),text);
            PersistableBundle extras=new PersistableBundle();extras.putBoolean("android.content.extra.IS_SENSITIVE",true);clip.getDescription().setExtras(extras);
            ((ClipboardManager)getSystemService(Context.CLIPBOARD_SERVICE)).setPrimaryClip(clip);toast(R.string.terminal_copied);
        }catch(RuntimeException e){toast(R.string.terminal_clipboard_unavailable);}
    }
    private void showPaste(){
        if(dialog!=null || busy || !canInput() || session.hasInput() || screen.selecting() || transport==null)return;
        final String initial;
        try {
            ClipData clip=((ClipboardManager)getSystemService(Context.CLIPBOARD_SERVICE)).getPrimaryClip();
            // Do not coerce URIs or read providers. Only an explicit click reads a plain text item.
            CharSequence text=clip!=null && clip.getItemCount()>0?clip.getItemAt(0).getText():null;
            if(text==null){toast(R.string.terminal_clipboard_empty);return;}
            initial=TerminalClipboard.prepare(text);
        }catch(IllegalArgumentException e){toast(R.string.terminal_paste_invalid);return;}
        catch(RuntimeException e){toast(R.string.terminal_clipboard_unavailable);return;}
        final TerminalSessionState owner=session;final NvHTTP route=transport;final int generation=epoch;
        LinearLayout content=new LinearLayout(this);content.setOrientation(LinearLayout.VERTICAL);content.setPadding(dp(20),dp(8),dp(20),0);
        TextView hint=new TextView(this);hint.setText(R.string.terminal_paste_hint);hint.setTextSize(12);content.addView(hint);
        EditText preview=new EditText(this);preview.setTextSize(14);
        preview.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_MULTI_LINE|InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD|InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        preview.setImeOptions(EditorInfo.IME_FLAG_NO_EXTRACT_UI|EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING);
        preview.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        preview.setMinLines(2);preview.setMaxLines(8);preview.setText(initial);content.addView(preview);
        final AlertDialog owned=new AlertDialog.Builder(this).setTitle(R.string.terminal_paste_title).setView(content)
                .setPositiveButton(R.string.terminal_paste,null).setNegativeButton(android.R.string.cancel,null).create();
        dialog=owned;owned.show();modal();
        final boolean[] submitted={false};
        owned.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->{
            if(submitted[0])return;
            if(dialog!=owned || !owned.isShowing() || epoch!=generation || session!=owner || transport!=route || !canInput() || screen.selecting()) {
                toast(R.string.terminal_paste_stale);owned.dismiss();return;
            }
            try {
                String raw=preview.getText().toString(),prepared=TerminalClipboard.prepare(raw);
                if(!prepared.equals(raw)){preview.setText(prepared);preview.setError(getString(R.string.terminal_paste_cleaned));return;}
                if(prepared.isEmpty()){preview.setError(getString(R.string.terminal_clipboard_empty));return;}
                if(screen.pasteReviewed(prepared)){submitted[0]=true;owned.dismiss();}
            }catch(IllegalArgumentException e){preview.setError(getString(R.string.terminal_paste_invalid));}
        });
    }
    private void showSessions(){
        if(inventory==null)return;
        String[] labels=new String[inventory.sessions.size()];
        for(int i=0;i<labels.length;i++){TerminalProtocol.Session s=inventory.sessions.get(i);labels[i]=s.shell+" · "+s.id.substring(0,6)+" · "+getString(s.running()?R.string.terminal_running:R.string.terminal_finished);}
        dialog=new AlertDialog.Builder(this).setTitle(R.string.terminal_sessions).setItems(labels,(d,i)->attach(inventory.sessions.get(i),false))
                .setNeutralButton(R.string.terminal_refresh,(d,w)->{needList=true;schedule(0);}).setNegativeButton(android.R.string.cancel,null).show();
        modal();
    }
    private void showNew(){
        if(inventory==null || needList)return;
        final TerminalProtocol.Reply offered=inventory;String[] labels=new String[offered.shells.size()];
        for(int i=0;i<labels.length;i++)labels[i]=TerminalProtocol.shellLabel(offered.shells.get(i));
        dialog=new AlertDialog.Builder(this).setTitle(R.string.terminal_new).setItems(labels,(d,i)->{
            try{TerminalProtocol.require(!needList && inventory!=null && offered.instance.equals(inventory.instance) && offered.nextOpen==inventory.nextOpen && offered.shells.equals(inventory.shells));
                action=TerminalProtocol.request("open",offered.instance,UUID.randomUUID().toString().replace("-",""))
                    .put("shell",offered.shells.get(i)).put("columns",desiredColumns).put("rows",desiredRows).put("sequence",offered.nextOpen);update();schedule(0);}
            catch(JSONException e){failure(e);}
        }).setNegativeButton(android.R.string.cancel,null).show();
        modal();
    }
    private void closeSession(){
        dialog=new AlertDialog.Builder(this).setTitle(R.string.terminal_close).setMessage(R.string.terminal_close_confirm)
                .setPositiveButton(R.string.terminal_close,(d,w)->{
                    if(session==null)return;
                    try{session.discardUnsent();action=TerminalProtocol.request("close",session.instance,session.id);update();schedule(0);}catch(JSONException e){failure(e);}
                }).setNegativeButton(android.R.string.cancel,null).show();
        modal();
    }
    private void attach(TerminalProtocol.Session value,boolean fresh){
        if(session!=null)session.mouse.stop();
        session=new TerminalSessionState(inventory.instance,value);replayUntil=fresh?0:value.end;
        screen.reset(value.columns,value.rows);notice.setText(R.string.terminal_lifetime);update();schedule(0);
    }
    private void pump(){
        if(!foreground || busy || halted)return;
        if(dialog!=null && dialog.isShowing() && !(canInput() && session.mouse.cancelling()))return;
        try {
            JSONObject next;
            if(needList || inventory==null)next=TerminalProtocol.list();
            else if(action!=null)next=new JSONObject(action.toString());
            else if(session==null){update();return;}
            else {
                long now=SystemClock.elapsedRealtime();
                next=session.mouse.cancelling()?session.mouse.command(session.instance,session.id):null;
                if(next==null && dialog!=null){update();return;}
                if(next==null && !screen.selecting() && session.mouse.busy() && inputSchedule.preferMouse())next=session.mouse.command(session.instance,session.id);
                if(next==null && session.hasInput() && inputSchedule.preferKey(now))next=session.write();
                if(next==null && !screen.selecting() && session.mouse.busy() && inputSchedule.readDue(now))next=session.read();
                if(next==null && session.hasInput() && inputSchedule.keyDue(now))next=session.write();
                if(next==null && screen.selecting()){update();return;}
                if(next==null && inventory.mouseProtocol==1)next=session.mouse.command(session.instance,session.id);
                if(next==null && session.hasInput())next=session.write();
                if(next==null && session.snapshot.running() && session.offset>=replayUntil && (session.snapshot.columns!=desiredColumns || session.snapshot.rows!=desiredRows))
                    next=TerminalProtocol.request("resize",session.instance,session.id).put("columns",desiredColumns).put("rows",desiredRows);
                if(next==null && (session.snapshot.running() || session.offset<session.snapshot.end))next=session.read();
                if(next==null){update();return;}
            }
            final JSONObject request=next;
            busy=true;update();int generation=epoch;boolean recover=resolveRoute;resolveRoute=false;
            task=worker.submit(()->{
                try {
                    NvHTTP http=connection(generation,recover);
                    TerminalProtocol.Reply reply=new TerminalProtocol.Reply(request,http.terminalRequest(request));
                    main.post(()->{if(foreground && epoch==generation){busy=false;success(request,reply);}});
                }catch(Exception e){main.post(()->{if(foreground && epoch==generation){busy=false;failure(e);}});}
            });
        }catch(JSONException e){failure(e);}
    }
    private NvHTTP connection(int generation,boolean recover) throws Exception {
        if(Thread.currentThread().isInterrupted())throw new InterruptedException();
        JSONObject destination=new JSONObject(host.toString());
        // Re-read identity before every foreground operation; a deleted/re-paired PC cannot inherit old work.
        ComputerDatabaseManager database=new ComputerDatabaseManager(getApplicationContext());
        ComputerDetails computer;
        try {computer=database.getComputerByUUID(host.getString("uuid"));}finally{database.close();}
        if(computer==null || computer.serverCert==null || !Base64.getEncoder().encodeToString(computer.serverCert.getEncoded()).equals(host.getString("cert")))throw new IOException("TERMINAL_UNPAIRED");
        if(recover) {
            ComputerDetails route=StreamRouteRecovery.select(getApplicationContext(),host.getString("uuid"),host.getString("uniqueId"));
            if(route==null || route.activeAddress==null)throw new IOException("TERMINAL_UNAVAILABLE");
            destination.put("address",route.activeAddress.address).put("port",route.activeAddress.port).put("https",route.httpsPort);
        }
        NvHTTP http=transport;
        if(http==null || recover){if(http!=null)http.cancelTerminalRequests();http=TransferStorage.connection(getApplicationContext(),destination);transport=http;}
        // Atomic cancellation in NvHTTP also covers onStop racing with call registration.
        if(!foreground || epoch!=generation || Thread.currentThread().isInterrupted()){http.cancelTerminalRequests();if(transport==http)transport=null;throw new InterruptedException();}
        return http;
    }
    private void success(JSONObject request,TerminalProtocol.Reply reply){
        if(failures>0)notice.setText(R.string.terminal_lifetime);connected=true;failures=0;
        try {
            if(!request.getString("op").equals("list") && inventory!=null && inventory.mouseProtocol==1)TerminalProtocol.require(reply.session.mouse!=null);
            switch(request.getString("op")) {
                case "list":
                    boolean restarted=inventory!=null && !inventory.instance.equals(reply.instance);
                    if(inventory!=null && inventory.mouseProtocol!=reply.mouseProtocol && session!=null){session.mouse.stop();screen.mouseEnabled(false);}
                    inventory=reply;needList=false;
                    if(restarted){session=null;action=null;screen.reset(desiredColumns,desiredRows);notice.setText(R.string.terminal_restarted);}
                    if(session!=null){TerminalProtocol.Session found=reply.find(session.id);if(found==null){session=null;screen.selecting(false);notice.setText(R.string.terminal_missing);}else session.refresh(reply.instance,found);}
                    break;
                case "open":action=null;attach(reply.session,true);needList=true;break;
                case "write":session.acknowledge(reply);break;
                case "mouse":session.mouse.acknowledge(reply);session.refresh(reply.instance,reply.session);break;
                case "close":action=null;session=new TerminalSessionState(reply.instance,reply.session);session.offset=reply.session.end;needList=true;notice.setText(R.string.terminal_closed);break;
                case "resize":session.refresh(reply.instance,reply.session);screen.resize(reply.session.columns,reply.session.rows);break;
                case "read":
                    session.consume(reply);
                    if(reply.gap){session.mouse.stop();screen.reset(reply.session.columns,reply.session.rows);notice.setText(R.string.terminal_gap);replayUntil=reply.session.end;}
                    TerminalReplay.append(reply.data,reply.offset,replayUntil,screen::append);screen.outputApplied(reply.next);break;
            }
            inputSchedule.completed(request.getString("op"),SystemClock.elapsedRealtime());
            update();schedule(session!=null && session.mouse.busy()?16:request.optString("op").equals("read") && reply.data.length==0 && !session.hasInput()?300:0);
        }catch(JSONException e){failure(e);}
    }
    private void failure(Exception error){
        if(session!=null)session.mouse.stop();
        connected=false;needList=true;screen.accepting(false);screen.selecting(false);
        NvHTTP http=transport;transport=null;if(http!=null)http.cancelTerminalRequests();
        String code=error.getMessage()==null?"":error.getMessage();
        if(error instanceof JSONException || code.matches("TERMINAL_(STALE|NOT_FOUND|CLOSED|OFFSET|SEQUENCE|ID_CONFLICT|INPUT_CONFLICT|MOUSE_SEQUENCE|MOUSE_CONFLICT|INVALID_RESPONSE|BAD_REQUEST)")) {
            session=null;action=null;notice.setText(R.string.terminal_uncertain);halted=true;
        } else if(code.equals("TERMINAL_UNPAIRED") || code.equals("TERMINAL_UNSUPPORTED") || code.equals("TERMINAL_USER_REQUIRED")) {
            halted=true;notice.setText(code.equals("TERMINAL_UNPAIRED")?R.string.terminal_unpaired:code.equals("TERMINAL_UNSUPPORTED")?R.string.terminal_unsupported:R.string.terminal_user_required);
        } else if(code.equals("TERMINAL_CAPACITY")) {action=null;notice.setText(R.string.terminal_capacity);}
        else if(code.equals("TERMINAL_MOUSE_MODE") || code.equals("TERMINAL_MOUSE_GESTURE")){notice.setText(R.string.terminal_mouse_stopped);}
        else {notice.setText(R.string.terminal_reconnecting);resolveRoute=!code.equals("TERMINAL_BUSY");}
        status.setText(R.string.terminal_disconnected);update();failures++;schedule(Math.min(10000,1000L*failures));
    }
}
