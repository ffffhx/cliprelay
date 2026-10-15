package com.limelight.terminal;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.os.*;
import android.view.*;
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
    private TextView status, notice;
    private Button sessionsButton,newButton,closeButton;
    private volatile boolean foreground;
    private volatile int epoch;
    private boolean busy,needList=true,connected,resolveRoute,halted;
    private int desiredColumns=80,desiredRows=24,failures;
    private long replayUntil;
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
        button(buttons,R.string.terminal_retry,()->{halted=false;needList=true;failures=0;resolveRoute=true;schedule(0);});
        screen=new RemoteTerminalView(this,this);page.addView(screen,new LinearLayout.LayoutParams(-1,0,1));
        HorizontalScrollView keys=new HorizontalScrollView(this);LinearLayout keyRow=new LinearLayout(this);keys.addView(keyRow);page.addView(keys);
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
    @Override protected void onStop(){
        foreground=false;connected=false;epoch++;main.removeCallbacks(tick);if(dialog!=null){dialog.dismiss();dialog=null;}
        NvHTTP http=transport;transport=null;if(http!=null)http.cancelTerminalRequests();
        if(task!=null)task.cancel(true);busy=false;
        if(session!=null && session.discardUnsent())notice.setText(R.string.terminal_discarded);
        if(screen!=null)screen.accepting(false);super.onStop();
    }
    @Override protected void onDestroy(){worker.shutdownNow();super.onDestroy();}
    private void schedule(long delay){main.removeCallbacks(tick);if(foreground && !halted)main.postDelayed(tick,delay);}
    private boolean canInput(){return foreground && connected && !halted && !needList && action==null && session!=null && session.snapshot.running();}
    @Override public boolean input(byte[] bytes){
        if(!canInput() || !session.enqueue(bytes)){Toast.makeText(this,R.string.terminal_input_wait,Toast.LENGTH_SHORT).show();return false;}
        schedule(0);return true;
    }
    @Override public void size(int columns,int rows){desiredColumns=columns;desiredRows=rows;schedule(0);}
    private void update(){
        if(screen==null)return;screen.accepting(canInput());
        sessionsButton.setEnabled(connected && !busy && action==null && (session==null || !session.hasInput()));
        newButton.setEnabled(connected && !busy && action==null && inventory!=null && (session==null || !session.hasInput()));
        closeButton.setEnabled(connected && !busy && action==null && session!=null && session.snapshot.running());
        if(connected){String detail=session==null?getString(R.string.terminal_choose):session.snapshot.shell+" · "+session.id.substring(0,6)+" · "+getString(session.snapshot.running()?R.string.terminal_running:R.string.terminal_finished);
            if(session!=null && !session.snapshot.running())detail+=" ("+session.snapshot.exitCode+")";
            status.setText(getString(R.string.terminal_title)+" · "+detail);}
    }
    private void modal(){dialog.setOnDismissListener(d->{dialog=null;schedule(0);});}
    private void showSessions(){
        if(inventory==null)return;
        String[] labels=new String[inventory.sessions.size()];
        for(int i=0;i<labels.length;i++){TerminalProtocol.Session s=inventory.sessions.get(i);labels[i]=s.shell+" · "+s.id.substring(0,6)+" · "+getString(s.running()?R.string.terminal_running:R.string.terminal_finished);}
        dialog=new AlertDialog.Builder(this).setTitle(R.string.terminal_sessions).setItems(labels,(d,i)->attach(inventory.sessions.get(i),false))
                .setNeutralButton(R.string.terminal_refresh,(d,w)->{needList=true;schedule(0);}).setNegativeButton(android.R.string.cancel,null).show();
        modal();
    }
    private void showNew(){
        if(inventory==null)return;
        dialog=new AlertDialog.Builder(this).setTitle(R.string.terminal_new).setItems(new String[]{"PowerShell","CMD"},(d,i)->{
            try{action=TerminalProtocol.request("open",inventory.instance,UUID.randomUUID().toString().replace("-",""))
                    .put("shell",i==0?"powershell":"cmd").put("columns",desiredColumns).put("rows",desiredRows).put("sequence",inventory.nextOpen);update();schedule(0);}
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
        session=new TerminalSessionState(inventory.instance,value);replayUntil=fresh?0:value.end;
        screen.reset(value.columns,value.rows);notice.setText(R.string.terminal_lifetime);update();schedule(0);
    }
    private void pump(){
        if(!foreground || busy || halted || (dialog!=null && dialog.isShowing()))return;
        try {
            final JSONObject request;
            if(needList || inventory==null)request=TerminalProtocol.list();
            else if(action!=null)request=new JSONObject(action.toString());
            else if(session==null){update();return;}
            else if(session.hasInput())request=session.write();
            else if(session.snapshot.running() && session.offset>=replayUntil && (session.snapshot.columns!=desiredColumns || session.snapshot.rows!=desiredRows))
                request=TerminalProtocol.request("resize",session.instance,session.id).put("columns",desiredColumns).put("rows",desiredRows);
            else if(session.snapshot.running() || session.offset<session.snapshot.end)request=session.read();
            else {update();return;}
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
            switch(request.getString("op")) {
                case "list":
                    boolean restarted=inventory!=null && !inventory.instance.equals(reply.instance);
                    inventory=reply;needList=false;
                    if(restarted){session=null;action=null;screen.reset(desiredColumns,desiredRows);notice.setText(R.string.terminal_restarted);}
                    if(session!=null){TerminalProtocol.Session found=reply.find(session.id);if(found==null){session=null;notice.setText(R.string.terminal_missing);}else session.refresh(reply.instance,found);}
                    break;
                case "open":action=null;attach(reply.session,true);needList=true;break;
                case "write":session.acknowledge(reply);break;
                case "close":action=null;session=new TerminalSessionState(reply.instance,reply.session);session.offset=reply.session.end;needList=true;notice.setText(R.string.terminal_closed);break;
                case "resize":session.refresh(reply.instance,reply.session);screen.resize(reply.session.columns,reply.session.rows);break;
                case "read":
                    session.consume(reply);
                    if(reply.gap){screen.reset(reply.session.columns,reply.session.rows);notice.setText(R.string.terminal_gap);replayUntil=reply.session.end;}
                    TerminalReplay.append(reply.data,reply.offset,replayUntil,screen::append);break;
            }
            update();schedule(request.optString("op").equals("read") && reply.data.length==0 && !session.hasInput()?300:0);
        }catch(JSONException e){failure(e);}
    }
    private void failure(Exception error){
        connected=false;needList=true;screen.accepting(false);
        NvHTTP http=transport;transport=null;if(http!=null)http.cancelTerminalRequests();
        String code=error.getMessage()==null?"":error.getMessage();
        if(error instanceof JSONException || code.matches("TERMINAL_(STALE|NOT_FOUND|CLOSED|OFFSET|SEQUENCE|ID_CONFLICT|INPUT_CONFLICT|INVALID_RESPONSE|BAD_REQUEST)")) {
            session=null;action=null;notice.setText(R.string.terminal_uncertain);halted=true;
        } else if(code.equals("TERMINAL_UNPAIRED") || code.equals("TERMINAL_UNSUPPORTED") || code.equals("TERMINAL_USER_REQUIRED")) {
            halted=true;notice.setText(code.equals("TERMINAL_UNPAIRED")?R.string.terminal_unpaired:code.equals("TERMINAL_UNSUPPORTED")?R.string.terminal_unsupported:R.string.terminal_user_required);
        } else if(code.equals("TERMINAL_CAPACITY")) {action=null;notice.setText(R.string.terminal_capacity);}
        else {notice.setText(R.string.terminal_reconnecting);resolveRoute=!code.equals("TERMINAL_BUSY");}
        status.setText(R.string.terminal_disconnected);update();failures++;schedule(Math.min(10000,1000L*failures));
    }
}
