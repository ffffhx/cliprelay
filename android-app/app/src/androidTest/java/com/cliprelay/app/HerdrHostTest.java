package com.cliprelay.app;

import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import com.limelight.Game;
import com.limelight.binding.PlatformBinding;
import com.limelight.computers.ComputerDatabaseManager;
import com.limelight.computers.IdentityManager;
import com.limelight.herdr.HerdrActivity;
import com.limelight.herdr.HerdrProtocol;
import com.limelight.herdr.HerdrTerminalView;
import com.limelight.nvstream.http.ComputerDetails;
import com.limelight.nvstream.http.NvHTTP;
import com.termux.terminal.TerminalEmulator;
import org.junit.Test;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import static org.junit.Assert.*;
import static org.junit.Assume.*;

/** Opt-in: sends only to a separately created, explicitly named verification terminal. */
public class HerdrHostTest {
    private final android.app.Instrumentation instrument = InstrumentationRegistry.getInstrumentation();
    private void ui(Runnable action) { instrument.runOnMainSync(action); }
    private Object field(Object object, String name) {
        try { Field field=object.getClass().getDeclaredField(name);field.setAccessible(true);return field.get(object); }
        catch(Exception error) { throw new AssertionError(error); }
    }
    private void await(String label, BooleanSupplier condition) {
        await(label,30000,condition);
    }
    private void await(String label,long timeout,BooleanSupplier condition) {
        long deadline=SystemClock.uptimeMillis()+timeout;
        do { boolean[] ready={false};ui(()->ready[0]=condition.getAsBoolean());if(ready[0])return;SystemClock.sleep(150); }
        while(SystemClock.uptimeMillis()<deadline);
        fail(label);
    }
    private TextView find(View root, String text) {
        if(root instanceof TextView) {
            String rendered=((TextView)root).getText().toString();
            if(rendered.equals(text)||rendered.equals(text+"  ›"))return (TextView)root;
        }
        if(root instanceof ViewGroup)for(int i=0;i<((ViewGroup)root).getChildCount();i++){
            TextView found=find(((ViewGroup)root).getChildAt(i),text);if(found!=null)return found;
        }
        return null;
    }
    private void capture(HerdrActivity activity,String name) {
        capture(activity,activity.getWindow().getDecorView(),name);
    }
    private void clickWindowText(String text) {
        long until=SystemClock.uptimeMillis()+10000;
        do {
            var root=instrument.getUiAutomation().getRootInActiveWindow();
            if(root!=null)for(var node:root.findAccessibilityNodeInfosByText(text))if(text.contentEquals(node.getText()==null?"":node.getText())){
                while(node!=null&&!node.isClickable())node=node.getParent();
                if(node!=null&&node.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK)){instrument.waitForIdleSync();SystemClock.sleep(250);return;}
            }
            SystemClock.sleep(100);
        }while(SystemClock.uptimeMillis()<until);
        fail("Missing window action: "+text);
    }
    private HerdrProtocol.Reply closeTestRequest(NvHTTP http,org.json.JSONObject request) throws Exception {
        // The activity and notification monitor share the host's serialized RPC gate.
        // BUSY means not dispatched; never replay a request with an unknown result.
        for(int attempt=0;;attempt++){
            var raw=http.herdrRequest(request);
            if(!raw.optString("code").equals("HERDR_BUSY")||attempt>=40)return new HerdrProtocol.Reply(request,raw);
            SystemClock.sleep(150);
        }
    }
    @Test public void closeSessionFromLongPressAndDetailMenu() throws Exception {
        var args=InstrumentationRegistry.getArguments();String name=args.getString("herdrCloseTerminalName","");
        assumeTrue(!name.isEmpty());assertTrue("Only disposable session",name.matches("cliprelay-mobile-check-[a-z0-9]{8,32}"));
        var context=instrument.getTargetContext();
        var home=instrument.startActivitySync(new Intent(context,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        var db=new ComputerDatabaseManager(context);ComputerDetails computer=null;
        try{for(var c:db.getAllComputers())if(c.name.equals(args.getString("computerName"))&&c.serverCert!=null){assertNull(computer);computer=c;}}finally{db.close();}
        assertNotNull(computer);var address=computer.localAddress!=null?computer.localAddress:computer.manualAddress;
        String uid=new IdentityManager(context).getUniqueId();
        var http=new NvHTTP(address,0,uid,computer.serverCert,PlatformBinding.getCryptoProvider(context));http.getServerInfo(true);
        Intent intent=new Intent(context,HerdrActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(Game.EXTRA_HOST,address.address).putExtra(Game.EXTRA_PORT,address.port).putExtra(Game.EXTRA_UNIQUEID,uid)
            .putExtra(Game.EXTRA_PC_UUID,computer.uuid).putExtra(Game.EXTRA_PC_NAME,computer.name).putExtra(Game.EXTRA_SERVER_CERT,computer.serverCert.getEncoded());
        try(ActivityScenario<HerdrActivity> scenario=ActivityScenario.launch(intent)){
            HerdrActivity[] active={null};scenario.onActivity(a->active[0]=a);HerdrActivity activity=active[0];
            await("Fixture card",()->find((View)field(activity,"list"),name)!=null);
            var catalog=closeTestRequest(http,new org.json.JSONObject().put("op","list"));
            HerdrProtocol.Terminal fixture=catalog.terminals().stream().filter(t->t.label().equals(name)).findFirst().orElseThrow();
            var closing=HerdrProtocol.close(catalog.instance,"default",catalog.result.getString("coreId"),fixture);
            ui(()->((View)find((View)field(activity,"list"),name).getParent()).performClick());
            await("Observer attached",()->field(activity,"watch")!=null&&((HerdrProtocol.Watch)field(activity,"watch")).attached);
            ui(()->((Button)field(activity,"more")).performClick());clickWindowText("删除会话");
            capture(activity,"close-confirm");clickWindowText("取消");
            assertTrue("Cancel preserves terminal",closeTestRequest(http,new org.json.JSONObject().put("op","list")).terminals().stream().anyMatch(t->t.address.equals(fixture.address)));
            ui(()->((Button)field(activity,"back")).performClick());
            await("Return to list",()->field(activity,"watch")==null&&field(activity,"detach")==null&&!((Boolean)field(activity,"needList")));
            ui(()->((EditText)field(activity,"search")).setText(name));
            instrument.waitForIdleSync();
            ui(()->assertTrue(((View)find((View)field(activity,"list"),name).getParent()).performLongClick()));
            capture(activity,"close-menu");clickWindowText("删除会话");clickWindowText("删除会话");
            await("Removed from phone list",()->field(activity,"pendingClose")==null&&!((Boolean)field(activity,"needList"))&&find((View)field(activity,"list"),name)==null);
            var after=closeTestRequest(http,new org.json.JSONObject().put("op","list"));
            assertFalse("Removed from computer",after.terminals().stream().anyMatch(t->t.address.equals(fixture.address)));
            for(var t:catalog.terminals())if(!t.address.equals(fixture.address))assertTrue("Other session retained: "+t.address,after.terminals().stream().anyMatch(v->v.address.equals(t.address)));
            assertEquals("Projects retained",catalog.projects().size(),after.projects().size());
            assertTrue("Repeated receipt is safe",closeTestRequest(http,closing).result.getBoolean("closed"));
            capture(activity,"close-list");
        }finally{ui(home::finish);}
    }
    private void capture(HerdrActivity activity,View root,String name) {
        if(!"true".equals(InstrumentationRegistry.getArguments().getString("herdrScreenshots")))return;
        if("true".equals(InstrumentationRegistry.getArguments().getString("herdrDeviceScreenshots"))){
            // Capture the actual window policy, including IME, without changing window flags.
            Bitmap bitmap=null;
            try{
                instrument.waitForIdleSync();SystemClock.sleep(300);bitmap=instrument.getUiAutomation().takeScreenshot();assertNotNull("Device screenshot",bitmap);
                try(var output=new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null),"herdr-"+name+".png"))){assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,output));}
            }catch(Exception error){throw new AssertionError(error);}
            finally{if(bitmap!=null)bitmap.recycle();}
            return;
        }
        ui(()->{
            Bitmap bitmap=Bitmap.createBitmap(root.getWidth(),root.getHeight(),Bitmap.Config.ARGB_8888);
            try {
                root.draw(new Canvas(bitmap));
                java.io.File file=new java.io.File(activity.getExternalFilesDir(null),"herdr-"+name+".png");
                try(var output=new java.io.FileOutputStream(file)){assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,output));}
            } catch(Exception error){throw new AssertionError(error);} finally {bitmap.recycle();}
        });
    }
    @Test public void existingSessionInputAndBackgroundReconnect() throws Exception {
        var args=InstrumentationRegistry.getArguments();
        assumeTrue("true".equals(args.getString("herdrHost")));
        String name=args.getString("herdrTerminalName", "");
        assertTrue("Explicit verification terminal required",name.matches("cliprelay-mobile-check-[a-z0-9]{8,32}"));
        String computerName=args.getString("computerName", "");
        assertFalse(computerName.isEmpty());
        var context=instrument.getTargetContext();
        var home=instrument.startActivitySync(new Intent(context,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        var db=new ComputerDatabaseManager(context);
        ComputerDetails computer=null;
        try {for(ComputerDetails candidate:db.getAllComputers())if(candidate.name.equals(computerName)&&candidate.serverCert!=null){assertNull("Ambiguous host",computer);computer=candidate;}}
        finally {db.close();}
        assertNotNull("Paired host required",computer);
        var address=computer.localAddress!=null?computer.localAddress:computer.manualAddress;
        assertNotNull("This check uses the already paired LAN host",address);
        String uid=new IdentityManager(context).getUniqueId();
        var http=new NvHTTP(address,0,uid,computer.serverCert,PlatformBinding.getCryptoProvider(context));
        http.getServerInfo(true);
        Intent intent=new Intent(context,HerdrActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(Game.EXTRA_HOST,address.address).putExtra(Game.EXTRA_PORT,address.port)
            .putExtra(Game.EXTRA_UNIQUEID,uid).putExtra(Game.EXTRA_PC_UUID,computer.uuid)
            .putExtra(Game.EXTRA_PC_NAME,computer.name).putExtra(Game.EXTRA_SERVER_CERT,computer.serverCert.getEncoded());
        try(ActivityScenario<HerdrActivity> scenario=ActivityScenario.launch(intent)) {
            HerdrActivity[] active={null};scenario.onActivity(activity->active[0]=activity);
            HerdrActivity activity=active[0];
            String core=args.getString("herdrCoreSession","default");
            if(!core.equals("default")){
                assertTrue("Isolated verification core required",core.matches("cliprelay-check-[a-z0-9]{8,32}"));
                ui(()->{try{Field f=HerdrActivity.class.getDeclaredField("core");f.setAccessible(true);f.set(activity,core);}catch(Exception error){throw new AssertionError(error);}((Button)field(activity,"refresh")).performClick();});
            }
            await("Verification session absent",()->find((View)field(activity,"list"),name)!=null);
            capture(activity,"sessions");
            // Exercise the real catalog's creation sheet without starting another Agent.
            await("New Agent unavailable",()->((Button)field(activity,"newAgent")).isEnabled());
            ui(()->((Button)field(activity,"newAgent")).performClick());
            await("Creation sheet not laid out",()->field(activity,"createDialog")!=null&&((View)field(activity,"sheet")).getHeight()>0);
            ui(()->{
                View sheet=(View)field(activity,"sheet");
                assertNotNull(find(sheet,"Agent"));
                assertTrue("Installed Agent should be selectable",((Button)field(activity,"createButton")).isEnabled());
            });
            capture(activity,((android.app.Dialog)field(activity,"createDialog")).getWindow().getDecorView(),"create");
            ui(()->((android.app.Dialog)field(activity,"createDialog")).dismiss());
            // Optional screenshots of the Agent sessions explicitly created for this check.
            for(String agent:new String[]{"codex","claude"}) {
                String title=args.getString("herdrCapture"+agent,"");
                if(title.isEmpty())continue;
                assertTrue(title.matches("cliprelay-mobile-check-[a-z0-9]{8,32}"));
                await("Created Agent absent",()->find((View)field(activity,"list"),title)!=null);
                ui(()->((View)find((View)field(activity,"list"),title).getParent()).performClick());
                await("Agent renderer empty",()->{
                    HerdrTerminalView view=(HerdrTerminalView)field(activity,"terminalView");
                    String output=((TerminalEmulator)field(view,"emulator")).getScreen().getTranscriptText();
                    return output.contains(agent.equals("codex")?"OpenAI Codex":"Claude Code");
                });
                capture(activity,agent);
                ui(()->((Button)field(activity,"back")).performClick());
                await("Catalog not ready",()->((Button)field(activity,"newAgent")).isEnabled());
            }
            // The regular list card opens the existing core terminal.
            ui(()->((View)find((View)field(activity,"list"),name).getParent()).performClick());
            await("Observer did not attach",()->{var w=(HerdrProtocol.Watch)field(activity,"watch");return w!=null&&w.attached;});
            HerdrTerminalView terminal=(HerdrTerminalView)field(activity,"terminalView");
            await("Terminal layout not ready",()->terminal.getHeight()>0);
            ui(()->{
                View page=(View)field(activity,"page");
                assertTrue("Terminal must occupy at least 75% of usable height",terminal.getHeight()>=(page.getHeight()-page.getPaddingTop()-page.getPaddingBottom())*.75);
                float zoom=(Float)field(terminal,"zoom");
                terminal.changeTextScale(1.1f);
                assertTrue("Font increase",(Float)field(terminal,"zoom")>zoom);
                terminal.changeTextScale(1/1.1f);terminal.latest();
            });
            String marker="CLIPRELAY_PHONE_"+UUID.randomUUID().toString().replace("-", "");
            String longMessage="中文与 English 混合长消息：内容应该在手机宽度内自动换行，能够完整阅读，不需要左右拖动。 ".repeat(5)+"END_OF_WRAPPED_MESSAGE";
            ui(()->{((EditText)field(activity,"composer")).setText("echo "+marker+" "+longMessage);((Button)field(activity,"send")).performClick();});
            await("Input not acknowledged",()->{var w=(HerdrProtocol.Watch)field(activity,"watch");return w.accepted==1&&w.pending==null;});
            await("Original core output did not reach renderer",()->((TerminalEmulator)field(terminal,"emulator")).getScreen().getTranscriptText().contains(marker));
            ui(()->assertEquals("Confirmed draft cleared","",((EditText)field(activity,"composer")).getText().toString()));
            await("Long output missing",()->((TerminalEmulator)field(terminal,"emulator")).getScreen().getTranscriptText().contains("END_OF_WRAPPED_MESSAGE"));
            capture(activity,"terminal");
            ui(()->{
                EditText composer=(EditText)field(activity,"composer");composer.setText("测试输入：中文、English 和数字 123，文字必须清晰可读。");composer.requestFocus();
                ((android.view.inputmethod.InputMethodManager)activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE)).showSoftInput(composer,android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);
            });
            if(android.os.Build.VERSION.SDK_INT>=30){
                await("Keyboard did not open",()->activity.getWindow().getDecorView().getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime()));
                await("Keyboard layout did not resize",()->terminal.getHeight()<activity.getWindow().getDecorView().getHeight()*.65);
                SystemClock.sleep(500); // Let the system IME animation and focus scrolling finish.
                ui(()->{
                    View page=(View)field(activity,"page");int available=page.getHeight()-page.getPaddingTop()-page.getPaddingBottom();
                    assertTrue("Terminal must retain at least half the area above keyboard",terminal.getHeight()>=available*.5);
                    EditText composer=(EditText)field(activity,"composer");assertTrue("Input text cannot be white in light theme",composer.getCurrentTextColor()!=android.graphics.Color.WHITE);
                    int[] titlePosition=new int[2];((View)field(activity,"heading")).getLocationOnScreen(titlePosition);assertTrue("Header remains visible with keyboard",titlePosition[1]>=0);
                    int[] composerPosition=new int[2],sendPosition=new int[2];composer.getLocationOnScreen(composerPosition);View send=(View)field(activity,"send");send.getLocationOnScreen(sendPosition);
                    assertTrue("Send aligns to the bottom of multiline input",Math.abs(composerPosition[1]+composer.getHeight()-sendPosition[1]-send.getHeight())<=2);
                });
                capture(activity,"keyboard");
            }
            ui(()->{
                EditText composer=(EditText)field(activity,"composer");composer.setText("");
                ((android.view.inputmethod.InputMethodManager)activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(composer.getWindowToken(),0);
                composer.clearFocus();
            });
            scenario.moveToState(Lifecycle.State.CREATED);
            SystemClock.sleep(1200);
            scenario.moveToState(Lifecycle.State.RESUMED);
            await("Reconnect not ready",()->((Button)field(activity,"send")).isEnabled());
            ui(()->{var w=(HerdrProtocol.Watch)field(activity,"watch");assertEquals("No input replay on foreground",1,w.accepted);find((View)field(activity,"keyRow"),"↓").performClick();find((View)field(activity,"keyRow"),"Enter").performClick();});
            await("Rapid Down and Enter must both be acknowledged",()->{var w=(HerdrProtocol.Watch)field(activity,"watch");return w.accepted==3&&w.pending==null;});
            // Detaching the phone must leave the core terminal available in the list.
            ui(()->((Button)field(activity,"back")).performClick());
            await("Terminal lost after detaching",()->field(activity,"watch")==null&&find((View)field(activity,"list"),name)!=null);
        } finally {ui(home::finish);}
    }
    @Test public void wideTerminalWrapsAndLatestNeverScrollsIntoUnusedRows() {
        ui(()->{
            HerdrTerminalView view=new HerdrTerminalView(instrument.getTargetContext());
            view.layout(0,0,800,240);view.reset(80,100);
            byte[] data="\u001b[100;1Hlast row".getBytes(StandardCharsets.UTF_8);view.append(data);
            Bitmap bitmap=Bitmap.createBitmap(800,240,Bitmap.Config.ARGB_8888);
            try {
                for(int i=0;i<10;i++){
                    long now=SystemClock.uptimeMillis();
                    MotionEvent down=MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,200,200,0);
                    MotionEvent move=MotionEvent.obtain(now,now+20,MotionEvent.ACTION_MOVE,200,0,0);
                    view.onTouchEvent(down);view.onTouchEvent(move);down.recycle();move.recycle();
                    view.draw(new Canvas(bitmap));
                }
                view.resize(160,24);view.draw(new Canvas(bitmap));
                view.reset(80,100);view.append("prompt> ".getBytes(StandardCharsets.UTF_8));view.latest();
                assertEquals("Latest must not jump past output into unused rows",0f,(Float)field(view,"offsetY"),.01f);
                view.append("\u001b[100;1Hbottom> ".getBytes(StandardCharsets.UTF_8));view.latest();
                assertTrue("Fullscreen cursor remains reachable",(Float)field(view,"offsetY")>0);
                view.draw(new Canvas(bitmap));
                view.reset(200,120);
                String message="long/path/without/spaces/".repeat(10)+" 中文与 emoji 🐕 e\u0301，最后一段不可丢失";
                view.append(("\u001b[97;107m"+message+"\u001b[0m\r\nready> ").getBytes(StandardCharsets.UTF_8));
                view.draw(new Canvas(bitmap));
                android.text.StaticLayout wrapped=(android.text.StaticLayout)field(view,"layout");
                assertTrue("Text wraps into multiple mobile lines",wrapped.getLineCount()>4);
                assertTrue(wrapped.getText().toString().contains(message));
                assertFalse("No horizontal scroll",view.canScrollHorizontally(1));
                for(int i=0;i<wrapped.getLineCount();i++)assertTrue("Every line fits the phone",wrapped.getLineMax(i)<=wrapped.getWidth()+1);
                android.text.Spanned styled=(android.text.Spanned)wrapped.getText();
                for(android.text.style.ForegroundColorSpan span:styled.getSpans(0,message.length(),android.text.style.ForegroundColorSpan.class))assertNotEquals("White-on-white must be corrected",android.graphics.Color.WHITE,span.getForegroundColor());
                view.reset(80,24);view.append("\u001b[38;2;119;119;119m\u001b[48;2;119;119;119mcontrast".getBytes(StandardCharsets.UTF_8));view.draw(new Canvas(bitmap));
                styled=(android.text.Spanned)((android.text.StaticLayout)field(view,"layout")).getText();
                int color=styled.getSpans(0,8,android.text.style.ForegroundColorSpan.class)[0].getForegroundColor();
                double a=android.graphics.Color.luminance(color),b=android.graphics.Color.luminance(0xff777777);
                assertTrue("Remote foreground/background contrast is at least 4.5:1",(Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5);
                view.resize(80,24);view.layout(0,0,500,240);view.draw(new Canvas(bitmap));
                view.reset(80,24);view.append(("history line\r\n".repeat(100)).getBytes(StandardCharsets.UTF_8));view.draw(new Canvas(bitmap));view.latest();
                float latest=(Float)field(view,"offsetY");assertTrue(latest>0);
                swipe(view,30,180);view.draw(new Canvas(bitmap));
                assertTrue("Finger down reveals older lines",(Float)field(view,"offsetY")<latest);
                float older=(Float)field(view,"offsetY");
                view.append("new output\r\n".getBytes(StandardCharsets.UTF_8));view.draw(new Canvas(bitmap));
                assertEquals("New output must not steal the scroll position",older,(Float)field(view,"offsetY"),1f);
                swipe(view,180,30);view.draw(new Canvas(bitmap));assertTrue("Finger up returns toward newer lines",(Float)field(view,"offsetY")>older);
                view.setAgent("codex");view.reset(80,24);view.append("\u001b[?1049h\u001b[2;1H› Ask Codex to do anything".getBytes(StandardCharsets.UTF_8));view.draw(new Canvas(bitmap));
                assertFalse("Empty desktop composer is replaced by native input",((android.text.StaticLayout)field(view,"layout")).getText().toString().contains("Ask Codex"));
                Object samePage=field(view,"layout");swipe(view,10,220);
                assertSame("Dragging an old fullscreen session cannot replace its page",samePage,field(view,"layout"));
                view.append("\u001b[2;1H\u001b[2K› My desktop draft".getBytes(StandardCharsets.UTF_8));view.draw(new Canvas(bitmap));
                assertTrue("Real desktop draft remains visible",((android.text.StaticLayout)field(view,"layout")).getText().toString().contains("My desktop draft"));
                view.reset(200,120);view.append(("\u001b[?1049h>_ OpenAI Codex\r\n\r\n\r\n"+"                 ⣀⣤⣤⣿⣿⣤\r\n".repeat(4)+"\r\n".repeat(70)+"› Ask Codex to do anything").getBytes(StandardCharsets.UTF_8));view.draw(new Canvas(bitmap));
                android.text.StaticLayout welcome=(android.text.StaticLayout)field(view,"layout");
                assertFalse("Startup ornament must not fill the mobile screen",welcome.getText().toString().contains("⣿"));
                assertTrue("Startup spacing is compact",welcome.getLineCount()<12);
                view.reset(200,120);view.append((">_ OpenAI Codex\r\n• chart\r\n"+"⣀⣤⣤⣿⣿⣤\r\n".repeat(4)).getBytes(StandardCharsets.UTF_8));view.draw(new Canvas(bitmap));
                assertTrue("Conversation charts are not welcome decoration",((android.text.StaticLayout)field(view,"layout")).getText().toString().contains("⣿"));
            } finally {bitmap.recycle();}
        });
    }
    @Test public void terminalRenderTiming() throws Exception {
        var context=instrument.getTargetContext();
        // Opt-in trace for the device's intermittent ActivityScenario focus timeout.
        java.util.concurrent.atomic.AtomicBoolean tracing=new java.util.concurrent.atomic.AtomicBoolean("true".equals(InstrumentationRegistry.getArguments().getString("herdrTraceFocus")));
        if(tracing.get()){
            java.io.File trace=new java.io.File(context.getExternalFilesDir(null),"herdr-focus-trace.txt");
            new Thread(()->{try(var out=new java.io.PrintWriter(trace)){
                while(tracing.get()){
                    out.println("time="+System.currentTimeMillis());for(StackTraceElement frame:android.os.Looper.getMainLooper().getThread().getStackTrace())out.println(frame);out.flush();SystemClock.sleep(500);
                }
            }catch(Exception ignored){}},"Herdr focus diagnostic").start();
        }
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(new Intent(context,MainActivity.class))){
            HerdrTerminalView[] terminal={null};
            scenario.onActivity(a->{terminal[0]=new HerdrTerminalView(a);a.setContentView(terminal[0]);});
            HerdrTerminalView view=terminal[0];await("Terminal not laid out",()->view.getWidth()>0);
            StringBuilder transcript=new StringBuilder();
            for(int n=0;n<320;n++)transcript.append("\u001b[36mROW_").append(n).append("\u001b[0m 中文回复 English output ").append("text ".repeat(22)).append("\r\n");
            ui(()->{if("true".equals(InstrumentationRegistry.getArguments().getString("herdrCodexRendering")))view.setAgent("codex");view.reset(200,120);view.append(transcript.toString().getBytes(StandardCharsets.UTF_8));});
            await("Initial frame missing",()->field(view,"layout")!=null);
            double[] samples=new double[16];
            Bitmap bitmap=Bitmap.createBitmap(view.getWidth(),view.getHeight(),Bitmap.Config.ARGB_8888);
            try{
                for(int i=0;i<samples.length;i++){
                    final int sample=i;
                    ui(()->{long begin=System.nanoTime();view.append(("\u001b[120;1Hstatus "+sample).getBytes(StandardCharsets.UTF_8));view.draw(new Canvas(bitmap));samples[sample]=(System.nanoTime()-begin)/1000000d;});
                    SystemClock.sleep(100);
                }
                java.util.Arrays.sort(samples);org.json.JSONObject result=new org.json.JSONObject().put("medianMainMs",samples[8]).put("p95MainMs",samples[15]);
                android.os.Bundle status=new android.os.Bundle();status.putString("renderTiming",result.toString());instrument.sendStatus(0,status);
                if("true".equals(InstrumentationRegistry.getArguments().getString("herdrRenderBudget")))assertTrue("UI updates must stay below 50 ms with long history",samples[15]<50);
                ui(()->{view.reset(80,24);view.append("NEW_SESSION_ONLY".getBytes(StandardCharsets.UTF_8));});
                await("Stale render replaced the new session",()->field(view,"layout")!=null&&((android.text.StaticLayout)field(view,"layout")).getText().toString().contains("NEW_SESSION_ONLY"));
                ui(()->assertFalse(((android.text.StaticLayout)field(view,"layout")).getText().toString().contains("ROW_")));
            }finally{bitmap.recycle();}
        }finally{tracing.set(false);}
    }
    @Test public void terminalUpdatesDoNotMoveActiveGesture() throws Exception {
        var context=instrument.getTargetContext();
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(new Intent(context,MainActivity.class))){
            HerdrTerminalView[] active={null};scenario.onActivity(a->{active[0]=new HerdrTerminalView(a);a.setContentView(active[0]);});
            HerdrTerminalView view=active[0];await("Terminal not sized",()->view.getHeight()>0);
            StringBuilder rows=new StringBuilder();for(int n=0;n<120;n++)rows.append("STABLE_ROW_").append(n).append(" stable reading content\r\n");
            ui(()->{if("true".equals(InstrumentationRegistry.getArguments().getString("herdrCodexRendering")))view.setAgent("codex");view.reset(80,180);view.append(rows.toString().getBytes(StandardCharsets.UTF_8));});
            await("Initial frame missing",()->field(view,"layout")!=null);
            int[] location=new int[2],size=new int[2];ui(()->{view.getLocationOnScreen(location);size[0]=view.getWidth();size[1]=view.getHeight();});
            long downTime=SystemClock.uptimeMillis();float x=location[0]+size[0]*.5f,y=location[1]+size[1]*.25f;
            MotionEvent down=MotionEvent.obtain(downTime,downTime,MotionEvent.ACTION_DOWN,x,y,0);instrument.sendPointerSync(down);down.recycle();
            MotionEvent move=MotionEvent.obtain(downTime,SystemClock.uptimeMillis()+30,MotionEvent.ACTION_MOVE,x,y+size[1]*.3f,0);instrument.sendPointerSync(move);move.recycle();
            Object[] held={null};float[] position={0},anchorY={0};String[] anchor={""};
            ui(()->{held[0]=field(view,"layout");position[0]=(Float)field(view,"offsetY");
                var layout=(android.text.StaticLayout)held[0];int line=layout.getLineForVertical((int)position[0]);
                anchor[0]=layout.getText().subSequence(layout.getLineStart(line),layout.getLineEnd(line)).toString();anchorY[0]=layout.getLineTop(line)-position[0];
                view.append(("\u001b[H\u001b[2J"+"NEW_PREFIX\r\n".repeat(6)+rows).getBytes(StandardCharsets.UTF_8));});
            try{
                SystemClock.sleep(300);
                ui(()->{assertSame("Incoming output must not swap layout beneath a held finger",held[0],field(view,"layout"));assertEquals("Incoming output moved the drag position",position[0],(Float)field(view,"offsetY"),.1f);});
            }finally{
                MotionEvent up=MotionEvent.obtain(downTime,SystemClock.uptimeMillis(),MotionEvent.ACTION_UP,x,y+size[1]*.3f,0);instrument.sendPointerSync(up);up.recycle();
            }
            await("Deferred output must appear after gesture",()->field(view,"layout")!=held[0]&&((android.text.StaticLayout)field(view,"layout")).getText().toString().contains("NEW_PREFIX"));
            ui(()->{var layout=(android.text.StaticLayout)field(view,"layout");int at=layout.getText().toString().indexOf(anchor[0]);assertTrue(at>=0);
                assertEquals("Publishing deferred output must keep the same reading line on screen",anchorY[0],layout.getLineTop(layout.getLineForOffset(at))-(Float)field(view,"offsetY"),1f);});
            // Continuous output must also leave the same scroll bounds during inertia.
            ui(()->{held[0]=field(view,"layout");android.widget.OverScroller fling=(android.widget.OverScroller)field(view,"scroller");fling.fling(0,1000,0,3000,0,0,0,20000);view.append("\u001b[1;1HFLING_UPDATE".getBytes(StandardCharsets.UTF_8));});
            SystemClock.sleep(120);
            ui(()->{assertFalse(((android.widget.OverScroller)field(view,"scroller")).isFinished());assertSame("Output must not replace a layout during inertia",held[0],field(view,"layout"));((android.widget.OverScroller)field(view,"scroller")).forceFinished(true);view.invalidate();});
            await("Deferred fling output missing",()->field(view,"layout")!=held[0]);
        }
    }
    @Test public void codexHistoryScrollsByPixelsWithoutReplacingContent(){
        ui(()->{
            HerdrTerminalView view=new HerdrTerminalView(instrument.getTargetContext());view.layout(0,0,800,1000);view.setAgent("codex");
            StringBuilder rows=new StringBuilder();for(int n=0;n<180;n++)rows.append("CONTINUOUS_ROW_").append(n).append("\r\n");
            view.append(rows.toString().getBytes(StandardCharsets.UTF_8));view.latest();
            Object layout=field(view,"layout");String content=((android.text.StaticLayout)layout).getText().toString();
            assertTrue("Inline scrollback must retain the first and last rows",content.contains("CONTINUOUS_ROW_0")&&content.contains("CONTINUOUS_ROW_179"));
            float before=(Float)field(view,"offsetY");
            try{
                var scroll=HerdrTerminalView.class.getDeclaredMethod("scrollByTouch",float.class);scroll.setAccessible(true);
                for(int n=0;n<40;n++){
                    scroll.invoke(view,-13.5f);
                    assertEquals("Every finger delta must move continuously, without page snapping",before-13.5f*(n+1),(Float)field(view,"offsetY"),.1f);
                    assertSame("Scrolling must retain the same content layout",layout,field(view,"layout"));
                }
                scroll.invoke(view,-100000f);assertEquals(0f,(Float)field(view,"offsetY"),.1f);
                swipe(view,10,2500);assertSame("Dragging past the beginning must not replace the history",layout,field(view,"layout"));
            }catch(Exception error){throw new AssertionError(error);}
        });
    }
    @Test public void codexMobileColorsFooterAndParagraphs(){
        ui(()->{
            HerdrTerminalView view=new HerdrTerminalView(instrument.getTargetContext());view.layout(0,0,1080,1600);view.setAgent("codex");view.reset(95,30);
            String message="• "+"连续中文".repeat(10)+"表示在普\r\n  通终端里显示界面。\r\n\r\n"+
                "  \u001b[38;2;166;227;161mGREEN_CODE\u001b[0m \u001b[38;2;137;180;250mBLUE_LINK\u001b[0m \u001b[1;38;2;243;139;168mPINK_EMPHASIS\u001b[0m\r\n\r\n"+
                "  Worked for 37s • 13:03\r\n\r\n› Ask Codex to do anything\r\n\r\n  GPT-6-Astra xhigh · ~\\work\\folder · Test\u001b[8;3H";
            // The active composer is row 8 (one-based) in this fixture.
            view.append(message.getBytes(StandardCharsets.UTF_8));view.latest();
            var layout=(android.text.StaticLayout)field(view,"layout");android.text.Spanned text=(android.text.Spanned)layout.getText();
            assertEquals("GPT-6-Astra xhigh",view.getModelLabel());assertFalse(text.toString().contains("~\\work\\folder"));
            assertFalse(text.toString().contains("Ask Codex"));assertTrue(text.toString().contains("表示在普通终端里显示界面。"));
            int[] original={0xffa6e3a1,0xff89b4fa,0xfff38ba8};String[] words={"GREEN_CODE","BLUE_LINK","PINK_EMPHASIS"};
            for(int n=0;n<words.length;n++){
                int start=text.toString().indexOf(words[n]);var spans=text.getSpans(start,start+1,android.text.style.ForegroundColorSpan.class);assertTrue(spans.length>0);int fg=spans[spans.length-1].getForegroundColor();
                assertTrue("Colored text must remain readable on white",(1.05)/(android.graphics.Color.luminance(fg)+.05)>=4.5);
                float[] sourceHue=new float[3],actualHue=new float[3];android.graphics.Color.colorToHSV(original[n],sourceHue);android.graphics.Color.colorToHSV(fg,actualHue);
                assertEquals("Readable colors must retain their hue",sourceHue[0],actualHue[0],3f);assertTrue(actualHue[1]>.15f);
            }
            int emphasis=text.toString().indexOf("PINK_EMPHASIS");assertTrue(text.getSpans(emphasis,emphasis+1,android.text.style.StyleSpan.class).length>0);
            for(int n=0;n<layout.getLineCount();n++)assertTrue("Reflowed lines must fit the phone",layout.getLineMax(n)<=layout.getWidth()+1);
            view.reset(80,24);assertEquals("A new session must not inherit the last model", "",view.getModelLabel());
        });
    }
    @Test public void reconnectNoticeClearsAfterConfirmedRead() throws Exception {
        var args=InstrumentationRegistry.getArguments();String terminal=args.getString("herdrObserveTerminal","");assumeFalse(terminal.isEmpty());
        var context=instrument.getTargetContext();var db=new ComputerDatabaseManager(context);ComputerDetails computer=null;
        try{for(var candidate:db.getAllComputers())if(candidate.name.equals(args.getString("computerName"))&&candidate.serverCert!=null){assertNull(computer);computer=candidate;}}finally{db.close();}
        assertNotNull(computer);var address=computer.localAddress!=null?computer.localAddress:computer.manualAddress;String uid=new IdentityManager(context).getUniqueId();
        Intent intent=new Intent(context,HerdrActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(Game.EXTRA_HOST,address.address).putExtra(Game.EXTRA_PORT,address.port).putExtra(Game.EXTRA_UNIQUEID,uid)
            .putExtra(Game.EXTRA_PC_UUID,computer.uuid).putExtra(Game.EXTRA_PC_NAME,computer.name).putExtra(Game.EXTRA_SERVER_CERT,computer.serverCert.getEncoded());
        try(ActivityScenario<HerdrActivity> scenario=ActivityScenario.launch(intent)){
            HerdrActivity[] active={null};scenario.onActivity(a->active[0]=a);HerdrActivity activity=active[0];
            await("Catalog unavailable",()->(Boolean)field(activity,"connected")&&!(Boolean)field(activity,"needList"));
            ui(()->{try{
                HerdrProtocol.Terminal selected=null;for(Object t:(java.util.List<?>)field(activity,"terminals"))if(((HerdrProtocol.Terminal)t).address.equals(terminal))selected=(HerdrProtocol.Terminal)t;
                assertNotNull("Explicit read-only terminal not found",selected);
                var method=HerdrActivity.class.getDeclaredMethod("open",HerdrProtocol.Terminal.class);method.setAccessible(true);method.invoke(activity,selected);
            }catch(Exception e){throw new AssertionError(e);}});
            await("Observer not attached",()->field(activity,"watch")!=null&&((HerdrProtocol.Watch)field(activity,"watch")).attached);
            // Exercise recovery against the real paired host, without sending input,
            // changing terminal size, stopping its program or disconnecting the LAN.
            ui(()->{try{var method=HerdrActivity.class.getDeclaredMethod("failure",Exception.class);method.setAccessible(true);method.invoke(activity,new java.io.IOException("SIMULATED_TRANSIENT_READ_FAILURE"));}catch(Exception e){throw new AssertionError(e);}});
            await("Connection did not recover",()->(Boolean)field(activity,"connected")&&!(Boolean)field(activity,"readBeforeRetry"));
            ui(()->{assertFalse("Recovered session must clear the stale reconnect banner",((TextView)field(activity,"notice")).getText().toString().contains("正在重连"));assertEquals("Observation must not send anything",0,((HerdrProtocol.Watch)field(activity,"watch")).accepted);});
            HerdrTerminalView terminalView=(HerdrTerminalView)field(activity,"terminalView");
            ui(()->assertEquals("Selected session opens directly in the terminal",View.VISIBLE,terminalView.getVisibility()));
            if("true".equals(args.getString("herdrExpectInline")))await("Resumed Codex must expose continuous local history",()->{
                TerminalEmulator screen=(TerminalEmulator)field(terminalView,"emulator");
                return !screen.isAlternateBufferActive()&&screen.getScreen().getActiveTranscriptRows()>0&&terminalView.canScrollVertically(-1);
            });
            boolean mobile="true".equals(args.getString("herdrExpectMobileLayout"));int[] modelPosition=new int[2];
            if(mobile){
                await("Live Codex model must appear in the fixed footer",()->!terminalView.getModelLabel().isEmpty()&&((TextView)field(activity,"modelStatus")).getVisibility()==View.VISIBLE);
                ui(()->{
                    TextView footer=(TextView)field(activity,"modelStatus");footer.getLocationOnScreen(modelPosition);
                    int[] inputPosition=new int[2];((EditText)field(activity,"composer")).getLocationOnScreen(inputPosition);
                    assertTrue("Model belongs below the message input",modelPosition[1]>=inputPosition[1]+((EditText)field(activity,"composer")).getHeight());
                    String rendered=((android.text.StaticLayout)field(terminalView,"layout")).getText().toString();
                    assertFalse("Desktop status path must not remain in terminal content",rendered.contains(terminalView.getModelLabel()+" · "));
                });
                capture(activity,"mobile-type-latest");
            }
            for(int n=0;n<4;n++)swipePhone(terminalView,true,n==0);
            for(int n=0;n<4;n++)swipePhone(terminalView,false,false);
            SystemClock.sleep(600);
            ui(()->assertEquals("Scrolling either edge must never send Page Up/Down to the real terminal",0,((HerdrProtocol.Watch)field(activity,"watch")).accepted));
            if(mobile){
                ui(()->{int[] after=new int[2];((TextView)field(activity,"modelStatus")).getLocationOnScreen(after);assertArrayEquals("Model footer must stay fixed while history scrolls",modelPosition,after);terminalView.performClick();});
                if(android.os.Build.VERSION.SDK_INT>=30)await("Keyboard missing",()->activity.getWindow().getDecorView().getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime()));
                ui(()->{
                    TextView footer=(TextView)field(activity,"modelStatus");int[] where=new int[2];footer.getLocationOnScreen(where);
                    var decor=activity.getWindow().getDecorView();int keyboard=android.os.Build.VERSION.SDK_INT>=30?decor.getRootWindowInsets().getInsets(android.view.WindowInsets.Type.ime()).bottom:0;
                    assertTrue("Keyboard must not cover model footer",where[1]+footer.getHeight()<=decor.getHeight()-keyboard);
                });
                capture(activity,"mobile-type-keyboard");
                ui(()->((android.view.inputmethod.InputMethodManager)activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(((EditText)field(activity,"composer")).getWindowToken(),0));
            }
            capture(activity,"recovered-garden");
        }
    }
    @Test public void cursorRepaintsDoNotShakeNativeComposerReadingPosition(){
        ui(()->{
            HerdrTerminalView view=new HerdrTerminalView(instrument.getTargetContext());view.setAgent("codex");view.reset(80,24);view.layout(0,0,500,200);
            Bitmap bitmap=Bitmap.createBitmap(500,200,Bitmap.Config.ARGB_8888);
            try{
                StringBuilder content=new StringBuilder();for(int i=1;i<=20;i++)content.append("Line ").append(i).append(" stable visible content\r\n");
                view.append(content.toString().getBytes(StandardCharsets.UTF_8));view.draw(new Canvas(bitmap));float position=(Float)field(view,"offsetY");assertTrue(position>0);
                for(int row:new int[]{1,20,4,19}){view.append(("\u001b["+row+";1H").getBytes(StandardCharsets.UTF_8));view.draw(new Canvas(bitmap));assertEquals("Cursor-only redraw must not scroll the phone",position,(Float)field(view,"offsetY"),1f);}
            }finally{bitmap.recycle();}
        });
    }
    /** Real phone + explicitly named disposable native console on a paired cloud host. */
    @Test public void cloudInputQueueAndMultipleImages() throws Exception {
        var args=InstrumentationRegistry.getArguments();String hostName=args.getString("herdrCloudHost","");assumeFalse(hostName.isEmpty());
        String name=args.getString("herdrTerminalName","");assertTrue(name.matches("cliprelay-mobile-check-[a-z0-9]{8,32}"));
        var context=instrument.getTargetContext();org.json.JSONObject host=null;
        for(var target:com.limelight.herdr.HerdrMonitorStore.get(context).targets())if(target.host.optString("name").replaceFirst("^ClipRelay - ","").equals(hostName)){assertNull(host);host=new org.json.JSONObject(target.host.toString());}
        assertNotNull("Open this paired host once before the test",host);
        var home=instrument.startActivitySync(new Intent(context,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        Intent intent=com.limelight.files.TransferStorage.intent(context,host).setClass(context,HerdrActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try(ActivityScenario<HerdrActivity> scenario=ActivityScenario.launch(intent)){
            HerdrActivity[] activityRef={null};scenario.onActivity(a->activityRef[0]=a);HerdrActivity activity=activityRef[0];
            await("Cloud fixture absent",60000,()->find((View)field(activity,"list"),name)!=null);
            ui(()->((View)find((View)field(activity,"list"),name).getParent()).performClick());
            await("Cloud observer not ready",60000,()->((Button)field(activity,"send")).isEnabled());
            HerdrTerminalView terminal=(HerdrTerminalView)field(activity,"terminalView");
            long start=SystemClock.uptimeMillis();
            ui(()->{find((View)field(activity,"keyRow"),"↓").performClick();find((View)field(activity,"keyRow"),"Enter").performClick();});
            await("Rapid selection and confirmation lost a key",()->{var w=(HerdrProtocol.Watch)field(activity,"watch");return w.accepted==2&&w.pending==null;});
            long keysMs=SystemClock.uptimeMillis()-start;
            await("Native cloud console did not confirm selection",()->((TerminalEmulator)field(terminal,"emulator")).getScreen().getTranscriptText().contains("CONFIRMED=2"));
            ui(()->{terminal.performClick();((EditText)field(activity,"composer")).setText("PHONE_QA_TEXT");});
            if(android.os.Build.VERSION.SDK_INT>=30)await("Keyboard missing",()->activity.getWindow().getDecorView().getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime()));
            SystemClock.sleep(400);
            int[] inputY={0};ui(()->{int[] xy=new int[2];((EditText)field(activity,"composer")).getLocationOnScreen(xy);inputY[0]=xy[1];});
            for(int i=0;i<8;i++){final int n=i;ui(()->((EditText)field(activity,"composer")).setText("PHONE_QA_TEXT"+n));SystemClock.sleep(80);ui(()->{int[] xy=new int[2];((EditText)field(activity,"composer")).getLocationOnScreen(xy);assertEquals("Typing moved the composer",inputY[0],xy[1]);});}
            ui(()->((EditText)field(activity,"composer")).setText("PHONE_QA_TEXT"));
            start=SystemClock.uptimeMillis();ui(()->((Button)field(activity,"send")).performClick());
            await("Text not acknowledged",()->{var w=(HerdrProtocol.Watch)field(activity,"watch");return w.accepted==3&&w.pending==null;});long textMs=SystemClock.uptimeMillis()-start;
            await("Text was not actually submitted",()->((TerminalEmulator)field(terminal,"emulator")).getScreen().getTranscriptText().contains("TEXT=PHONE_QA_TEXT;IMAGES=0"));
            java.io.File directory=new java.io.File(context.getCacheDir(),"clipboard_images");directory.mkdirs();
            for(int i=0;i<2;i++){
                java.io.File file=new java.io.File(directory,"herdr-multi-"+i+".png");Bitmap image=Bitmap.createBitmap(320,200,Bitmap.Config.ARGB_8888);image.eraseColor(i==0?android.graphics.Color.RED:android.graphics.Color.BLUE);
                try(var out=new java.io.FileOutputStream(file)){image.compress(Bitmap.CompressFormat.PNG,100,out);}finally{image.recycle();}
                var uri=androidx.core.content.FileProvider.getUriForFile(context,context.getPackageName()+".fileprovider",file);final int count=i+1;
                ui(()->{try{Field f=HerdrActivity.class.getDeclaredField("pickerTerminal");f.setAccessible(true);f.set(activity,((HerdrProtocol.Watch)field(activity,"watch")).id);var method=HerdrActivity.class.getDeclaredMethod("onActivityResult",int.class,int.class,Intent.class);method.setAccessible(true);method.invoke(activity,71,android.app.Activity.RESULT_OK,new Intent().setData(uri));}catch(Exception error){throw new AssertionError(error);}});
                await("Repeated selection must append image "+count,()->((com.limelight.herdr.HerdrAttachments<?>)field(activity,"images")).size()==count&&!((Boolean)field(activity,"imageBusy")));
            }
            capture(activity,"multi-image-draft");
            ui(()->{((EditText)field(activity,"composer")).setText("PHONE_QA_TWO_IMAGES");((Button)field(activity,"send")).performClick();});
            await("Two images and text did not complete",60000,()->{var w=(HerdrProtocol.Watch)field(activity,"watch");return w.accepted==6&&w.pending==null&&((com.limelight.herdr.HerdrAttachments<?>)field(activity,"images")).size()==0;});
            await("Cloud received fewer than two image pastes",()->((TerminalEmulator)field(terminal,"emulator")).getScreen().getTranscriptText().contains("TEXT=PHONE_QA_TWO_IMAGES;IMAGES=2"));
            capture(activity,"multi-image-result");
            var status=new android.os.Bundle();status.putString("stream","\nHERDR_CLOUD_LATENCY keys_ms="+keysMs+" text_ms="+textMs+"\n");instrument.sendStatus(0,status);
            for(int i=0;i<2;i++)new java.io.File(directory,"herdr-multi-"+i+".png").delete();
        }finally{ui(home::finish);}
    }
    private void swipe(View view,float from,float to){
        long now=SystemClock.uptimeMillis();
        MotionEvent down=MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,200,from,0);view.dispatchTouchEvent(down);down.recycle();
        for(int i=1;i<=12;i++){MotionEvent move=MotionEvent.obtain(now,now+i*35,MotionEvent.ACTION_MOVE,200,from+(to-from)*i/12,0);view.dispatchTouchEvent(move);move.recycle();}
        MotionEvent up=MotionEvent.obtain(now,now+500,MotionEvent.ACTION_UP,200,to,0);view.dispatchTouchEvent(up);up.recycle();
    }
    private void swipePhone(View view,boolean older,boolean hold){
        int[] location=new int[2];int[] size=new int[2];ui(()->{view.getLocationOnScreen(location);size[0]=view.getWidth();size[1]=view.getHeight();});
        float x=location[0]+size[0]*.5f,from=location[1]+size[1]*(older?.18f:.82f),to=location[1]+size[1]*(older?.82f:.18f);
        long downTime=SystemClock.uptimeMillis();
        MotionEvent down=MotionEvent.obtain(downTime,downTime,MotionEvent.ACTION_DOWN,x,from,0);instrument.sendPointerSync(down);down.recycle();
        if(hold)SystemClock.sleep(650);
        for(int i=1;i<=12;i++){SystemClock.sleep(25);MotionEvent move=MotionEvent.obtain(downTime,SystemClock.uptimeMillis(),MotionEvent.ACTION_MOVE,x,from+(to-from)*i/12,0);instrument.sendPointerSync(move);move.recycle();}
        MotionEvent up=MotionEvent.obtain(downTime,SystemClock.uptimeMillis(),MotionEvent.ACTION_UP,x,to,0);instrument.sendPointerSync(up);up.recycle();
        instrument.waitForIdleSync();
    }
    @Test public void codexImageTapAndHistory() throws Exception {
        var args=InstrumentationRegistry.getArguments();String name=args.getString("herdrImageCodex","");assumeFalse(name.isEmpty());
        assertTrue(name.matches("cliprelay-mobile-check-[a-z0-9]{8,32}"));
        var context=instrument.getTargetContext();var db=new ComputerDatabaseManager(context);ComputerDetails computer=null;
        try{for(var candidate:db.getAllComputers())if(candidate.name.equals(args.getString("computerName"))&&candidate.serverCert!=null){assertNull(computer);computer=candidate;}}finally{db.close();}
        assertNotNull(computer);var address=computer.localAddress!=null?computer.localAddress:computer.manualAddress;
        String uid=new IdentityManager(context).getUniqueId();
        Intent intent=new Intent(context,HerdrActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(Game.EXTRA_HOST,address.address).putExtra(Game.EXTRA_PORT,address.port).putExtra(Game.EXTRA_UNIQUEID,uid)
            .putExtra(Game.EXTRA_PC_UUID,computer.uuid).putExtra(Game.EXTRA_PC_NAME,computer.name).putExtra(Game.EXTRA_SERVER_CERT,computer.serverCert.getEncoded());
        try(ActivityScenario<HerdrActivity> scenario=ActivityScenario.launch(intent)){
            HerdrActivity[] active={null};scenario.onActivity(a->active[0]=a);HerdrActivity activity=active[0];
            await("Verification Codex absent",()->find((View)field(activity,"list"),name)!=null);
            ui(()->((View)find((View)field(activity,"list"),name).getParent()).performClick());
            await("Codex input unavailable",()->((Button)field(activity,"send")).isEnabled());
            HerdrTerminalView terminal=(HerdrTerminalView)field(activity,"terminalView");
            ui(()->{assertNull("Tab removed",find((View)field(activity,"keyRow"),"Tab"));terminal.performClick();});
            await("Tap terminal must focus native input",()->((EditText)field(activity,"composer")).hasFocus());
            if(android.os.Build.VERSION.SDK_INT>=30)await("Tap terminal opens keyboard",()->activity.getWindow().getDecorView().getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime()));
            // Only this generated fixture is selected; never read user photos.
            java.io.File directory=new java.io.File(context.getCacheDir(),"clipboard_images");directory.mkdirs();java.io.File fixture=new java.io.File(directory,"herdr-image-check.png");
            Bitmap bitmap=Bitmap.createBitmap(640,320,Bitmap.Config.ARGB_8888);Canvas canvas=new Canvas(bitmap);canvas.drawColor(android.graphics.Color.WHITE);
            android.graphics.Paint paint=new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);paint.setColor(android.graphics.Color.BLUE);paint.setTextSize(110);canvas.drawText("4827",155,205,paint);
            try(var out=new java.io.FileOutputStream(fixture)){bitmap.compress(Bitmap.CompressFormat.PNG,100,out);}bitmap.recycle();
            android.net.Uri uri=androidx.core.content.FileProvider.getUriForFile(context,context.getPackageName()+".fileprovider",fixture);
            ui(()->{try{
                Field f=HerdrActivity.class.getDeclaredField("pickerTerminal");f.setAccessible(true);f.set(activity,((HerdrProtocol.Watch)field(activity,"watch")).id);
                var method=HerdrActivity.class.getDeclaredMethod("onActivityResult",int.class,int.class,Intent.class);method.setAccessible(true);method.invoke(activity,71,android.app.Activity.RESULT_OK,new Intent().setData(uri));
            }catch(Exception error){throw new AssertionError(error);}});
            await("Selected image thumbnail missing",()->((com.limelight.herdr.HerdrAttachments<?>)field(activity,"images")).size()==1&&((View)field(activity,"attachmentRow")).getVisibility()==View.VISIBLE);
            // Selecting again appends, and removing the second item retains the first.
            ui(()->{try{var method=HerdrActivity.class.getDeclaredMethod("onActivityResult",int.class,int.class,Intent.class);method.setAccessible(true);method.invoke(activity,71,android.app.Activity.RESULT_OK,new Intent().setData(uri));}catch(Exception e){throw new AssertionError(e);}});
            await("Second selection replaced first image",()->((com.limelight.herdr.HerdrAttachments<?>)field(activity,"images")).size()==2&&!((Boolean)field(activity,"imageBusy")));
            ui(()->{var previews=(android.widget.LinearLayout)field(activity,"attachmentPreviews");((ViewGroup)previews.getChildAt(1)).getChildAt(1).performClick();assertEquals(1,((com.limelight.herdr.HerdrAttachments<?>)field(activity,"images")).size());});
            ui(()->((EditText)field(activity,"composer")).setText("请先读取图片中的四位数字并回复。然后逐行输出从 CHECKROW_01 到 CHECKROW_50 的 50 行，末尾再次回复图片中的四位数字，用于界面验收。不要调用工具，不读写文件。"));
            capture(activity,"image-draft");
            ui(()->((Button)field(activity,"send")).performClick());
            await("Image and text submission not acknowledged",60000,()->{var w=(HerdrProtocol.Watch)field(activity,"watch");return w!=null&&w.accepted==2&&w.pending==null&&((com.limelight.herdr.HerdrAttachments<?>)field(activity,"images")).size()==0;});
            await("Codex did not read the selected image",120000,()->((TerminalEmulator)field(terminal,"emulator")).getScreen().getTranscriptText().contains("4827"));
            await("Long Codex response incomplete",120000,()->((TerminalEmulator)field(terminal,"emulator")).getScreen().getTranscriptText().contains("CHECKROW_50"));
            ui(()->{((android.view.inputmethod.InputMethodManager)activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(((EditText)field(activity,"composer")).getWindowToken(),0);((EditText)field(activity,"composer")).clearFocus();});
            SystemClock.sleep(600);capture(activity,"image-result");
            BooleanSupplier older=()->java.util.regex.Pattern.compile("(?m)^\\s*[•]?\\s*CHECKROW_01\\s*$").matcher(((TerminalEmulator)field(terminal,"emulator")).getScreen().getTranscriptText()).find();
            await("Inline Codex must retain earlier response in local scrollback",older);
            long oldSequence=((HerdrProtocol.Watch)field(activity,"watch")).accepted;
            float before=(Float)field(terminal,"offsetY");
            for(int n=0;n<5;n++)swipePhone(terminal,true,n==0);
            ui(()->assertTrue("Scrolling back must move within local history",(Float)field(terminal,"offsetY")<before));
            capture(activity,"history-older");
            for(int n=0;n<5;n++)swipePhone(terminal,false,false);
            ui(()->assertEquals("Reading history must send no terminal input",oldSequence,((HerdrProtocol.Watch)field(activity,"watch")).accepted));
            capture(activity,"history-newer");fixture.delete();
        }
    }
}
