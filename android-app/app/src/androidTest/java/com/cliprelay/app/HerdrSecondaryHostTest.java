package com.cliprelay.app;

import android.app.Dialog;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.widget.*;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import com.limelight.Game;
import com.limelight.binding.PlatformBinding;
import com.limelight.computers.ComputerDatabaseManager;
import com.limelight.computers.IdentityManager;
import com.limelight.herdr.*;
import com.limelight.nvstream.http.*;
import org.json.*;
import org.junit.Test;
import java.io.File;
import java.lang.reflect.*;
import java.util.function.BooleanSupplier;
import static org.junit.Assert.*;
import static org.junit.Assume.*;

/** Real phone secondary-flow acceptance; launches only the explicit disposable CLI fixture. */
public class HerdrSecondaryHostTest {
    final android.app.Instrumentation test=InstrumentationRegistry.getInstrumentation();
    void ui(Runnable r){test.runOnMainSync(r);}
    Object field(Object o,String n){try{Field f=o.getClass().getDeclaredField(n);f.setAccessible(true);return f.get(o);}catch(Exception e){throw new AssertionError(e);}}
    void set(Object o,String n,Object v){try{Field f=o.getClass().getDeclaredField(n);f.setAccessible(true);f.set(o,v);}catch(Exception e){throw new AssertionError(e);}}
    void call(Object o,String n){try{Method m=o.getClass().getDeclaredMethod(n);m.setAccessible(true);m.invoke(o);}catch(Exception e){throw new AssertionError(e);}}
    void await(String message,BooleanSupplier check){long end=SystemClock.uptimeMillis()+30000;do{boolean[] ok={false};ui(()->ok[0]=check.getAsBoolean());if(ok[0])return;SystemClock.sleep(150);}while(SystemClock.uptimeMillis()<end);fail(message);}
    View find(View root,String label){if(label.contentEquals(root.getContentDescription()==null?"":root.getContentDescription())||(root instanceof TextView&&!(root instanceof EditText)&&label.contentEquals(((TextView)root).getText())))return root;if(root instanceof ViewGroup)for(int i=0;i<((ViewGroup)root).getChildCount();i++){View v=find(((ViewGroup)root).getChildAt(i),label);if(v!=null)return v;}return null;}
    View decor(HerdrActivity a,String name){return ((Dialog)field(a,name)).getWindow().getDecorView();}
    void click(HerdrActivity a,String panel,String label){ui(()->{View v=find(decor(a,panel),label);assertNotNull(label,v);assertTrue(label,v.isEnabled());while(!v.isClickable()&&v.getParent() instanceof View)v=(View)v.getParent();assertTrue(label,v.performClick());});test.waitForIdleSync();}
    void input(HerdrActivity a,String panel,String label,String text){ui(()->{View v=find(decor(a,panel),label);assertTrue(label,v instanceof EditText);((EditText)v).setText(text);});}
    void dismiss(HerdrActivity a,String name){ui(()->{Object d=field(a,name);if(d!=null)((Dialog)d).dismiss();});}
    void capture(Context context,String name)throws Exception{test.waitForIdleSync();SystemClock.sleep(250);Bitmap b=test.getUiAutomation().takeScreenshot();assertNotNull(b);try(var out=new java.io.FileOutputStream(new File(context.getExternalFilesDir(null),"herdr-sheet-"+name+".png"))){assertTrue(b.compress(Bitmap.CompressFormat.PNG,100,out));}finally{b.recycle();}}
    void rowsFit(View root){if(root instanceof LinearLayout&&((LinearLayout)root).getOrientation()==LinearLayout.HORIZONTAL){int edge=-1;for(int i=0;i<((LinearLayout)root).getChildCount();i++){View v=((LinearLayout)root).getChildAt(i);if(v.getVisibility()!=View.VISIBLE)continue;assertTrue("Row children overlap",v.getLeft()>=edge);edge=v.getRight();assertTrue("Row clips a control",edge<=root.getWidth());}}if(root instanceof ViewGroup)for(int i=0;i<((ViewGroup)root).getChildCount();i++)rowsFit(((ViewGroup)root).getChildAt(i));}
    HerdrProtocol.Reply api(NvHTTP http,JSONObject request)throws Exception{for(int n=0;;n++){JSONObject raw=http.herdrRequest(request);if(!raw.optString("code").equals("HERDR_BUSY")||n>40)return new HerdrProtocol.Reply(request,raw);SystemClock.sleep(150);}}
    @Test public void allSecondaryFlowsAndUnlistedCli()throws Exception{
        var args=InstrumentationRegistry.getArguments();assumeTrue("true".equals(args.getString("herdrSecondary")));
        String command=args.getString("herdrFixtureCommand","");assertTrue(command.matches("cliprelay-verify-agent-[a-z0-9]{4,16}"));
        Context context=test.getTargetContext();var home=test.startActivitySync(new Intent(context,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ComputerDetails computer=null;var db=new ComputerDatabaseManager(context);try{for(var c:db.getAllComputers())if(c.name.equals(args.getString("computerName"))&&c.serverCert!=null){assertNull(computer);computer=c;}}finally{db.close();}assertNotNull(computer);
        var address=computer.localAddress!=null?computer.localAddress:computer.manualAddress;String uid=new IdentityManager(context).getUniqueId();var http=new NvHTTP(address,0,uid,computer.serverCert,PlatformBinding.getCryptoProvider(context));http.getServerInfo(true);
        Intent intent=new Intent(context,HerdrActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(Game.EXTRA_HOST,address.address).putExtra(Game.EXTRA_PORT,address.port).putExtra(Game.EXTRA_UNIQUEID,uid).putExtra(Game.EXTRA_PC_UUID,computer.uuid).putExtra(Game.EXTRA_PC_NAME,computer.name).putExtra(Game.EXTRA_SERVER_CERT,computer.serverCert.getEncoded());
        android.content.SharedPreferences[] savedPreferences={null};String[] savedSelection={null,null};
        try(ActivityScenario<HerdrActivity> scene=ActivityScenario.launch(intent)){
            HerdrActivity[] holder={null};scene.onActivity(a->holder[0]=a);HerdrActivity a=holder[0];
            savedPreferences[0]=(android.content.SharedPreferences)field(a,"preferences");savedSelection[0]=savedPreferences[0].getString("lastAgent",null);savedSelection[1]=savedPreferences[0].getString("lastProject",null);
            await("Catalog ready",()->((Button)field(a,"newAgent")).isEnabled());
            // Inspect actual reminders, then use a private in-memory store for long/unread/empty cases.
            ui(()->call(a,"showInbox"));capture(context,"inbox-real");dismiss(a,"secondary");
            Object actualStore=field(a,"monitorStore");File fixtureDir=new File(context.getCacheDir(),"herdr-secondary-check");fixtureDir.mkdirs();
            var ctor=HerdrMonitorStore.class.getDeclaredConstructor(Context.class);ctor.setAccessible(true);HerdrMonitorStore fake=ctor.newInstance(new ContextWrapper(context){@Override public File getNoBackupFilesDir(){return fixtureDir;}});
            var target=fake.register((JSONObject)field(a,"host"),"default");target.enabled=false;
            JSONArray inbox=target.ledger.json().getJSONArray("inbox");while(inbox.length()>0)inbox.remove(0);
            for(int i=0;i<5;i++)inbox.put(new JSONObject().put("id","secondary-fixture-"+i).put("terminal","fixture").put("project",i==4?"garden-lab · 一个较长的项目名称用于检查自动换行":"garden-lab").put("title","检查手机端的提醒列表、长标题和按钮间距，第 "+i+" 项任务").put("agent",i%2==0?"Codex":"Custom Agent").put("kind",i%2==0?"done":"blocked").put("time",System.currentTimeMillis()-60000L*i).put("read",false));
            try{
                ui(()->{set(a,"monitorStore",fake);call(a,"showInbox");});capture(context,"inbox-long");ui(()->rowsFit(decor(a,"secondary")));
                click(a,"secondary","全部标为已读");assertEquals(0,target.ledger.unread());capture(context,"inbox-read");
                while(inbox.length()>0)inbox.remove(0);ui(()->call(a,"showInbox"));capture(context,"inbox-empty");
                target.error="电脑暂时离线，连接恢复后会继续接收提醒。";ui(()->call(a,"showInbox"));capture(context,"inbox-error");dismiss(a,"secondary");
            }finally{ui(()->set(a,"monitorStore",actualStore));for(File f:fixtureDir.listFiles())f.delete();fixtureDir.delete();}
            ui(()->((Button)field(a,"newAgent")).performClick());capture(context,"create");
            click(a,"createDialog","选择项目");capture(context,"projects");ui(()->rowsFit(decor(a,"secondary")));
            input(a,"secondary","搜索项目","no-project-matches-7fc2");capture(context,"projects-empty");dismiss(a,"secondary");
            click(a,"createDialog","选择 Agent");await("Agents loaded",()->field(a,"pendingAgents")==null);capture(context,"agents");
            Method state=HerdrActivity.class.getDeclaredMethod("renderAgentState",String.class,String.class,boolean.class);state.setAccessible(true);
            ui(()->{try{state.invoke(a,"正在查找电脑上的 CLI","首次扫描可能需要几秒钟。",true);}catch(Exception e){throw new AssertionError(e);}});capture(context,"agents-loading");
            ui(()->{try{state.invoke(a,"暂时无法读取电脑 CLI","检查电脑连接后重试。",false);}catch(Exception e){throw new AssertionError(e);}});capture(context,"agents-error");click(a,"secondary","重新查找");await("Catalog retried",()->field(a,"pendingAgents")==null);
            input(a,"secondary","搜索 Agent 或 CLI 名称","no-cli-matches-7fc2");await("Empty query applied",()->field(a,"pendingAgents")==null&&find(decor(a,"secondary"),"没有找到这个 CLI")!=null);capture(context,"agents-empty");
            input(a,"secondary","搜索 Agent 或 CLI 名称",command);await("Unlisted CLI discovered",()->find(decor(a,"secondary"),command)!=null);capture(context,"agents-custom");click(a,"secondary",command);
            assertTrue(((String)field(a,"selectedAgent")).startsWith("cli-"));
            input(a,"createDialog","会话名称","cliprelay-mobile-check-secondary1104");
            ui(()->{EditText name=(EditText)find(decor(a,"createDialog"),"会话名称");name.requestFocus();((android.view.inputmethod.InputMethodManager)context.getSystemService(Context.INPUT_METHOD_SERVICE)).showSoftInput(name,android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);});SystemClock.sleep(500);capture(context,"create-keyboard");
            ui(()->{Rect visible=new Rect();decor(a,"createDialog").getWindowVisibleDisplayFrame(visible);Rect button=new Rect();assertTrue(((Button)field(a,"createButton")).getGlobalVisibleRect(button));assertTrue("Create button behind keyboard",button.bottom<=visible.bottom);View input=find(decor(a,"createDialog"),"会话名称");Rect inputVisible=new Rect();assertTrue(input.getGlobalVisibleRect(inputVisible));assertEquals("Input must be fully visible",input.getHeight(),inputVisible.height());TextView close=(TextView)find(decor(a,"createDialog"),"关闭面板");assertTrue("Close symbol fits",close.getPaint().measureText(close.getText().toString())<=close.getWidth()-close.getPaddingLeft()-close.getPaddingRight());rowsFit(decor(a,"createDialog"));});
            click(a,"createDialog","创建会话");capture(context,"creating");await("Generic CLI created",()->field(a,"watch")!=null&&((HerdrProtocol.Watch)field(a,"watch")).attached);
            HerdrProtocol.Watch watch=(HerdrProtocol.Watch)field(a,"watch");
            var catalog=api(http,new JSONObject().put("op","list"));HerdrProtocol.Terminal terminal=catalog.terminals().stream().filter(t->t.address.equals(watch.terminal)).findFirst().orElseThrow();assertEquals(command,terminal.agentName);assertTrue(terminal.agent.startsWith("cli-"));
            await("Generic program output",()->((com.termux.terminal.TerminalEmulator)field(field(a,"terminalView"),"emulator")).getScreen().getTranscriptText().contains("CLIPRELAY_GENERIC_AGENT_READY"));capture(context,"generic-terminal");
            ui(()->call(a,"chooseControlKey"));capture(context,"keys");dismiss(a,"secondary");
            ui(()->call(a,"showTerminalMenu"));capture(context,"terminal-menu");click(a,"secondary","文字大小");capture(context,"text-size");dismiss(a,"secondary");
            ui(()->call(a,"showTerminalMenu"));click(a,"secondary","删除会话");capture(context,"delete-confirm");ui(()->rowsFit(decor(a,"secondary")));click(a,"secondary","取消");
            ui(()->((Button)field(a,"back")).performClick());await("Back to list",()->field(a,"watch")==null&&field(a,"detach")==null&&!(Boolean)field(a,"needList"));
            ui(()->((EditText)field(a,"search")).setText("cliprelay-mobile-check-secondary1104"));
            ui(()->{View title=find((View)field(a,"list"),"cliprelay-mobile-check-secondary1104  ›");assertNotNull(title);assertTrue(((View)title.getParent()).performLongClick());});capture(context,"session-menu");click(a,"secondary","删除会话");click(a,"secondary","删除会话");
            await("Test terminal removed",()->field(a,"pendingClose")==null&&!(Boolean)field(a,"needList"));
            assertFalse(api(http,new JSONObject().put("op","list")).terminals().stream().anyMatch(t->t.address.equals(terminal.address)));
        }finally{if(savedPreferences[0]!=null){var editor=savedPreferences[0].edit();for(int i=0;i<2;i++){String key=i==0?"lastAgent":"lastProject";if(savedSelection[i]==null)editor.remove(key);else editor.putString(key,savedSelection[i]);}editor.commit();}ui(home::finish);}
    }
}
