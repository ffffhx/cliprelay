package com.limelight.herdr;

import android.app.Activity;
import android.app.Dialog;
import android.content.SharedPreferences;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.content.res.ColorStateList;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.text.Editable;
import android.text.TextWatcher;
import android.text.TextUtils;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.*;
import com.limelight.computers.ComputerDatabaseManager;
import com.limelight.computers.StreamRouteRecovery;
import com.limelight.files.TransferStorage;
import com.limelight.nvstream.http.ComputerDetails;
import com.limelight.nvstream.http.NvHTTP;
import com.limelight.nvstream.ClipboardData;
import com.limelight.ui.RemoteImageCodec;
import org.json.JSONObject;
import java.io.IOException;
import java.util.*;
import java.util.concurrent.*;

/** Native project catalog, agent launcher and observer for the desktop Herdr core. */
public final class HerdrActivity extends Activity {
    private final Handler main=new Handler(Looper.getMainLooper());
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final Runnable tick=this::pump;
    private JSONObject host;
    private String instance="",core="default",coreId="",sentText="";
    private HerdrProtocol.Watch watch;
    private List<HerdrProtocol.Terminal> terminals=new ArrayList<>();
    private List<HerdrProtocol.Project> projects=new ArrayList<>();
    private List<HerdrProtocol.Agent> agents=new ArrayList<>();
    private HerdrProtocol.Terminal selected;
    private SharedPreferences preferences;
    private JSONObject pendingCreate;
    private JSONObject pendingClose;
    private JSONObject pendingAgents;
    private HerdrSheet secondary,agentPicker;
    private HerdrProtocol.Agent pickedAgent;
    private String agentQuery="";
    private LinearLayout agentResults;
    private final Runnable agentSearch=()->requestAgents(agentQuery);
    private Dialog createDialog;
    private LinearLayout sheet;
    private Button createButton,newAgent;
    private TextView creationNotice,computer,detailMeta,detailTask,modelStatus;
    private String selectedProject="",selectedAgent="codex",creationName="",filter="all",listSignature="";
    private EditText search;
    private LinearLayout filters,listFooter;
    private boolean connected;
    private String activeOp="";
    private volatile NvHTTP transport;
    private volatile boolean foreground;
    private volatile int epoch;
    private boolean busy,needList=true,halted,recoverRoute,readBeforeRetry;
    private boolean yieldingRead;
    private final ArrayDeque<String> queuedKeys=new ArrayDeque<>();
    private int failures;
    private JSONObject detach;
    private Future<?> task;
    private LinearLayout page,list,detail,keyRow;
    private HerdrCommandSuggestions commandSuggestions;
    private ScrollView scroll;
    private TextView heading,notice,count;
    private EditText composer;
    private Button send,refresh,back,more;
    private HerdrPalette colors;
    private HerdrTerminalView terminalView;
    private Button attachImage;
    private LinearLayout attachmentRow,attachmentPreviews;
    private TextView imageStatus;
    private final HerdrAttachments<RemoteImageCodec.Image> images=new HerdrAttachments<>();
    private String imageId="",imagePhase="",imageText="",pickerTerminal="";
    private boolean imageBusy,imagePasted,imageUncertain;
    private static final int PICK_IMAGE=71;
    private Button inboxButton;
    private String notificationTerminal="",notificationCoreId="",monitorKey="";
    private HerdrMonitorStore monitorStore;
    private final android.content.BroadcastReceiver notifications=new android.content.BroadcastReceiver(){
        @Override public void onReceive(android.content.Context context,Intent intent){updateInbox();}
    };

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        colors=new HerdrPalette(this);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        try{host=TransferStorage.host(getIntent());}catch(Exception error){finish();return;}
        preferences=getSharedPreferences("herdr-"+host.optString("uuid"),MODE_PRIVATE);
        core=preferences.getString("core","default");
        core=getIntent().getStringExtra("herdrCore")==null?core:getIntent().getStringExtra("herdrCore");
        notificationTerminal=getIntent().getStringExtra("herdrTerminal")==null?"":getIntent().getStringExtra("herdrTerminal");
        notificationCoreId=getIntent().getStringExtra("herdrCoreId")==null?"":getIntent().getStringExtra("herdrCoreId");
        try{monitorStore=HerdrMonitorStore.get(this);}catch(IOException ignored){}
        try{String pending=preferences.getString("pendingCreate","");if(!pending.isEmpty()){pendingCreate=new JSONObject(pending);String pendingCore=pendingCreate.getString("coreSession");if(!core.equals(pendingCore)){notificationTerminal="";notificationCoreId="";}core=pendingCore;}}catch(Exception ignored){}
        page=column();page.setBackgroundColor(colors.background);page.setFocusableInTouchMode(true);page.requestFocus();
        if(Build.VERSION.SDK_INT>=29)page.setForceDarkAllowed(false);
        int pad=dp(8);page.setPadding(pad,0,pad,0);
        LinearLayout bar=row();page.addView(bar,new LinearLayout.LayoutParams(-1,dp(48)));
        back=button(bar,"‹",()->{if(watch!=null)leaveWatch();else finish();});back.setContentDescription("返回");back.setTextSize(26);styleButton(back,colors.background);
        heading=label("Herdr",20,colors.ink);heading.setTypeface(null,Typeface.BOLD);heading.setSingleLine();heading.setEllipsize(TextUtils.TruncateAt.END);
        bar.addView(heading,new LinearLayout.LayoutParams(0,-2,1));
        inboxButton=button(bar,"提醒",this::showInbox);inboxButton.setContentDescription("Agent 通知收件箱");styleButton(inboxButton,colors.background);
        refresh=button(bar,"刷新",this::refreshConnection);styleButton(refresh,colors.background);
        more=button(bar,"⋯",this::showTerminalMenu);more.setTextSize(24);more.setContentDescription("终端菜单");styleButton(more,colors.background);
        computer=label(computerName()+" · 正在连接",12,colors.muted);computer.setPadding(dp(6),0,0,dp(8));page.addView(computer);
        detailMeta=label("",13,colors.muted);detailTask=label("",13,colors.ink);
        notice=label("正在连接…",12,colors.primary);notice.setSingleLine();notice.setEllipsize(TextUtils.TruncateAt.END);notice.setPadding(dp(6),dp(4),dp(6),dp(4));page.addView(notice,new LinearLayout.LayoutParams(-1,dp(26)));
        search=new EditText(this);search.setSingleLine();search.setTextSize(14);search.setTextColor(colors.ink);search.setHintTextColor(colors.muted);search.setHint("搜索项目或会话");
        search.setContentDescription("搜索项目或会话");search.setBackground(rounded(colors.field));search.setPadding(dp(12),0,dp(12),0);search.setIncludeFontPadding(false);page.addView(search,new LinearLayout.LayoutParams(-1,dp(44)));
        search.addTextChangedListener(new TextWatcher(){public void beforeTextChanged(CharSequence s,int st,int c,int a){} public void onTextChanged(CharSequence s,int st,int b,int c){showList(true);} public void afterTextChanged(Editable e){}});
        filters=row();page.addView(filters);count=label("",11,colors.muted);count.setPadding(dp(6),dp(4),0,dp(4));page.addView(count);
        scroll=new ScrollView(this);scroll.setFillViewport(true);scroll.setVerticalScrollBarEnabled(false);list=column();scroll.addView(list);page.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        listFooter=column();listFooter.setPadding(0,dp(6),0,dp(6));newAgent=button(listFooter,"＋  新建 Agent",()->showCreate(null));newAgent.setTextSize(15);styleButton(newAgent,colors.primary);newAgent.setLayoutParams(new LinearLayout.LayoutParams(-1,dp(48)));page.addView(listFooter);
        detail=column();detail.setVisibility(View.GONE);page.addView(detail,new LinearLayout.LayoutParams(-1,0,1));
        detailTask.setPadding(dp(6),0,dp(6),dp(7));detailTask.setSingleLine();detailTask.setEllipsize(TextUtils.TruncateAt.END);detail.addView(detailTask);
        terminalView=new HerdrTerminalView(this);detail.addView(terminalView,new LinearLayout.LayoutParams(-1,0,1));
        terminalView.setOnClickListener(v->focusComposer());
        HorizontalScrollView keyScroll=new HorizontalScrollView(this);keyScroll.setFillViewport(true);keyScroll.setHorizontalScrollBarEnabled(false);detail.addView(keyScroll);
        keyRow=row();keyRow.setMinimumWidth(dp(328));keyRow.setPadding(0,dp(4),0,dp(4));keyScroll.addView(keyRow);
        for(String[] key:new String[][]{{"Esc","esc"},{"Ctrl","ctrl"},{"Shift+←","shift+left"},{"↑","up"},{"↓","down"},{"Enter","enter"}}){
            Button keyButton=button(keyRow,key[0],()->{if(key[1].equals("ctrl"))chooseControlKey();else key(key[1]);});
            if(key[1].equals("shift+left")){keyButton.setContentDescription("Shift 加左方向键");keyButton.setTooltipText("发送 Shift + 左方向键");}
            keyButton.setSingleLine();keyButton.setMinWidth(0);keyButton.setMinimumWidth(0);keyButton.setPadding(0,0,0,0);LinearLayout.LayoutParams size=new LinearLayout.LayoutParams(0,dp(48),key[1].equals("shift+left")?1.4f:1);if(keyRow.getChildCount()>1)size.setMarginStart(dp(4));keyButton.setLayoutParams(size);
        }
        attachmentRow=column();attachmentRow.setPadding(0,0,0,dp(4));attachmentRow.setVisibility(View.GONE);detail.addView(attachmentRow);
        HorizontalScrollView previews=new HorizontalScrollView(this);previews.setHorizontalScrollBarEnabled(false);attachmentPreviews=row();previews.addView(attachmentPreviews);attachmentRow.addView(previews,new LinearLayout.LayoutParams(-1,dp(52)));
        imageStatus=label("图片 · 待发送",12,colors.muted);imageStatus.setSingleLine();attachmentRow.addView(imageStatus);
        LinearLayout input=row();input.setGravity(android.view.Gravity.BOTTOM);input.setPadding(0,0,0,dp(4));detail.addView(input);
        attachImage=button(input,"＋",this::pickImage);attachImage.setTextSize(22);attachImage.setContentDescription("添加图片");
        composer=new EditText(this);composer.setTextColor(colors.ink);composer.setHintTextColor(colors.muted);composer.setTextSize(15);composer.setBackground(rounded(colors.field));composer.setPadding(dp(12),dp(10),dp(12),dp(10));composer.setIncludeFontPadding(false);
        composer.setHint("输入消息…");composer.setMinLines(1);composer.setMaxLines(3);composer.setMinHeight(dp(44));
        composer.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_MULTI_LINE|InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        composer.setImeOptions(EditorInfo.IME_FLAG_NO_EXTRACT_UI|EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING);composer.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        composer.setContentDescription("消息输入框");
        LinearLayout.LayoutParams composerSize=new LinearLayout.LayoutParams(0,-2,1);composerSize.setMarginStart(dp(4));input.addView(composer,composerSize);send=button(input,"发送",this::send);styleButton(send,colors.primary);
        commandSuggestions=new HerdrCommandSuggestions(this,composer);
        LinearLayout.LayoutParams suggestionsSize=new LinearLayout.LayoutParams(-1,-2);suggestionsSize.bottomMargin=dp(4);
        detail.addView(commandSuggestions,detail.indexOfChild(input),suggestionsSize);
        modelStatus=label("",11,colors.muted);modelStatus.setSingleLine();modelStatus.setEllipsize(TextUtils.TruncateAt.END);
        modelStatus.setPadding(dp(10),dp(2),dp(10),dp(5));modelStatus.setVisibility(View.INVISIBLE);detail.addView(modelStatus,new LinearLayout.LayoutParams(-1,dp(22)));
        terminalView.setModelListener(model->{modelStatus.setText(model);modelStatus.setContentDescription("当前模型："+model);modelStatus.setVisibility(watch!=null&&!model.isEmpty()?View.VISIBLE:View.INVISIBLE);});
        setContentView(page);
        page.setOnApplyWindowInsetsListener((v,insets)->{
            if(Build.VERSION.SDK_INT>=30){android.graphics.Insets bars=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.ime());v.setPadding(pad+bars.left,bars.top,pad+bars.right,bars.bottom);}
            else v.setPadding(pad+insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),pad+insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());return insets;
        });
        heading.setOnLongClickListener(v->{chooseCore();return true;});update();
    }
    private LinearLayout column(){LinearLayout v=new LinearLayout(this);v.setOrientation(LinearLayout.VERTICAL);return v;}
    private LinearLayout row(){LinearLayout v=new LinearLayout(this);v.setBaselineAligned(false);v.setGravity(android.view.Gravity.CENTER_VERTICAL);return v;}
    private String computerName(){return host.optString("name").replaceFirst("^ClipRelay - ","");}
    private void refreshConnection(){halted=false;needList=true;recoverRoute=true;failures=0;schedule(0);}
    private void focusComposer(){if(watch==null)return;composer.requestFocus();((android.view.inputmethod.InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).showSoftInput(composer,android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);}
    private boolean supportsImage(){return selected!=null&&(selected.agent.equals("codex")||selected.agent.equals("claude"))&&!selected.address.contains("/");}
    private void pickImage(){
        if(!canInput())return;
        if(images.size()>=HerdrAttachments.LIMIT){Toast.makeText(this,"每条消息最多添加 8 张图片",Toast.LENGTH_SHORT).show();return;}
        if(!supportsImage()){Toast.makeText(this,"图片用于本机 Codex / Claude Code 会话",Toast.LENGTH_SHORT).show();return;}
        pickerTerminal=watch.id;hideKeyboard();
        try{
            Intent picker;
            if(androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia.isPhotoPickerAvailable(this)){
                picker=new androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia(HerdrAttachments.LIMIT).createIntent(this,
                    new androidx.activity.result.PickVisualMediaRequest.Builder().setMediaType(androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia.ImageOnly.INSTANCE).build());
            }else picker=new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true);
            startActivityForResult(picker.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),PICK_IMAGE);
        }
        catch(android.content.ActivityNotFoundException error){notice.setText("未找到图片选择器");update();}
    }
    @Override protected void onActivityResult(int request,int result,Intent data){
        super.onActivityResult(request,result,data);
        if(request!=PICK_IMAGE||result!=RESULT_OK||data==null||watch==null||!watch.id.equals(pickerTerminal))return;
        List<Uri> uris=new ArrayList<>();
        if(data.getClipData()!=null)for(int i=0;i<data.getClipData().getItemCount();i++){Uri uri=data.getClipData().getItemAt(i).getUri();if(uri!=null&&!uris.contains(uri))uris.add(uri);}
        else if(data.getData()!=null)uris.add(data.getData());
        if(uris.isEmpty())return;
        if(uris.size()>HerdrAttachments.LIMIT-images.size()){notice.setText("每条消息最多 8 张图片，请重新选择。");update();return;}
        String target=watch.id;imageBusy=true;notice.setText("正在准备图片…");update();
        worker.execute(()->{try{
            // Decode one at a time; publish on the UI thread and bound the total
            // draft. Full image bitmaps are not retained alongside PNG payloads.
            for(Uri uri:uris){
                RemoteImageCodec.Image image=RemoteImageCodec.read(getContentResolver(),uri);
                Bitmap thumbnail=Bitmap.createScaledBitmap(image.preview,Math.max(1,image.preview.getWidth()*96/Math.max(image.preview.getWidth(),image.preview.getHeight())),Math.max(1,image.preview.getHeight()*96/Math.max(image.preview.getWidth(),image.preview.getHeight())),true);
                if(thumbnail!=image.preview)image.preview.recycle();
                RemoteImageCodec.Image draft=new RemoteImageCodec.Image(thumbnail,image.png);
                main.post(()->{if(isDestroyed()||watch==null||!watch.id.equals(target)){draft.preview.recycle();return;}
                    if(!images.add(draft,draft.png.length)){draft.preview.recycle();notice.setText("图片总量最多 32 MB，请减少图片。");}
                    renderImages();});
            }
            main.post(()->{if(isDestroyed())return;imageBusy=false;if(watch!=null&&watch.id.equals(target)&&!notice.getText().toString().contains("32 MB"))notice.setText("图片已添加 · "+images.size()+" 张");update();schedule(0);});
        }catch(Exception|OutOfMemoryError error){main.post(()->{if(!isDestroyed()){imageBusy=false;notice.setText("图片无法读取，请选择不超过 20 MB 的图片。");update();schedule(0);}});}});
    }
    private void renderImages(){
        attachmentPreviews.removeAllViews();
        for(int i=0;i<images.size();i++){final int index=i;LinearLayout item=row();ImageView preview=new ImageView(this);preview.setImageBitmap(images.get(i).preview);preview.setScaleType(ImageView.ScaleType.CENTER_CROP);preview.setContentDescription("待发送图片 "+(i+1));item.addView(preview,new LinearLayout.LayoutParams(dp(48),dp(48)));
            Button remove=button(item,"×",()->{if(imageBusy||!imagePhase.isEmpty()||images.pasted()>0)return;images.remove(index).preview.recycle();renderImages();update();});remove.setContentDescription("移除图片 "+(i+1));remove.setEnabled(!imageBusy&&imagePhase.isEmpty()&&images.pasted()==0);attachmentPreviews.addView(item);}
        imageStatus.setText(images.size()+" 张图片 · "+(images.pasted()>0?"已添加 "+images.pasted()+" 张到电脑":"待发送"));
    }
    private void clearImage(){if(attachmentPreviews!=null)attachmentPreviews.removeAllViews();for(int i=0;i<images.size();i++)images.get(i).preview.recycle();images.clear();imageId="";imagePasted=false;imageUncertain=false;imagePhase="";imageText="";if(attachmentRow!=null)attachmentRow.setVisibility(View.GONE);}
    private void uploadImage(String text){
        imageText=text;imageId=HerdrProtocol.newId();imageBusy=true;imagePhase="upload";notice.setText("正在发送图片…");update();
        final int generation=epoch;final String target=watch.id;final byte[] png=images.get(images.pasted()).png;final String id=imageId;
        imageStatus.setText("正在传输第 "+(images.pasted()+1)+" / "+images.size()+" 张图片");yieldRead();
        worker.execute(()->{try{
            NvHTTP http=connection(generation,false);http.clipboardRequest(ClipboardData.png(png).request(id));
            main.post(()->{if(foreground&&epoch==generation&&watch!=null&&watch.id.equals(target)){
                imageBusy=false;imagePhase="paste";
                try{watch.key("ctrl+v");update();schedule(0);}catch(Exception error){imagePhase="";failure(error);}
            }});
        }catch(Exception error){main.post(()->{if(foreground&&epoch==generation){imageBusy=false;imagePhase="";notice.setText("图片传输未确认，图片和文字已保留，请重试。");update();schedule(0);}});}});
    }
    private void showTerminalMenu(){
        HerdrSheet menu=panel("终端操作",selected==null?"":selected.label());
        menu.choice("回到最新","查看最近的输出","↓",false,true,()->{menu.dismiss();terminalView.latest();});
        menu.choice("文字大小","调整手机上的阅读字号","Aa",false,true,()->{menu.dismiss();HerdrSheet size=panel("文字大小","仅调整手机上的显示");size.action("缩小",false,false,()->terminalView.changeTextScale(.9f));size.action("放大",true,false,()->terminalView.changeTextScale(1.1f));size.show();});
        menu.choice("会话详情",computerName(),"i",false,true,()->{menu.dismiss();HerdrSheet info=panel("会话详情",selected==null?"":selected.label());info.state(computer.getText().toString(),detailMeta.getText().toString(),false);info.show();});
        menu.choice("刷新连接","重新同步电脑上的会话","↻",false,true,()->{menu.dismiss();refreshConnection();});
        menu.action("删除会话",false,true,()->{menu.dismiss();confirmClose(selected);});menu.show();
    }
    private HerdrSheet panel(String title,String caption){
        if(secondary!=null)secondary.dismiss();HerdrSheet next=new HerdrSheet(this,title,caption);secondary=next;
        next.setOnDismissListener(d->{if(secondary==next)secondary=null;if(agentPicker==next){agentPicker=null;pendingAgents=null;main.removeCallbacks(agentSearch);}});return next;
    }
    private void showSessionMenu(View anchor,HerdrProtocol.Terminal terminal){
        HerdrSheet menu=panel("会话操作",terminal.projectLabel());menu.choice(terminal.agentName,terminal.label(),agentMark(terminal.agentName),false,true,()->{menu.dismiss();open(terminal);});
        menu.action("删除会话",false,true,()->{menu.dismiss();confirmClose(terminal);});menu.show();
    }
    private void confirmClose(HerdrProtocol.Terminal terminal){
        if(terminal==null)return;
        if(pendingClose!=null||pendingCreate!=null||imageBusy||!imagePhase.isEmpty()||(watch!=null&&watch.pending!=null)){
            Toast.makeText(this,"正在处理上一项操作，请稍候。",Toast.LENGTH_SHORT).show();return;
        }
        if(!connected||halted){Toast.makeText(this,"请先恢复电脑连接，再删除会话。",Toast.LENGTH_SHORT).show();return;}
        if(terminal.createdMs<=0||coreId.isEmpty()){Toast.makeText(this,"请更新电脑端 ClipRelay 后再删除会话。",Toast.LENGTH_LONG).show();return;}
        if(!terminal.address.matches("t[0-9a-z]{1,63}")){Toast.makeText(this,"请在该终端所在电脑上关闭会话。",Toast.LENGTH_LONG).show();return;}
        HerdrSheet confirm=panel("删除这个会话？",terminal.projectLabel()+" · "+terminal.label());
        confirm.content.addView(confirm.text("将关闭电脑上对应的终端，并停止其中运行的"+(terminal.agent.isEmpty()?"程序":" "+terminal.agentName)+"。终端画面和滚动记录会被移除。",15,colors.ink));
        confirm.gap(14);confirm.content.addView(confirm.text("项目文件会保留。",13,colors.muted));
        confirm.action("取消",false,false,confirm::dismiss);confirm.action("删除会话",false,true,()->{
                if(!foreground||!connected||halted||pendingClose!=null||pendingCreate!=null||imageBusy||!imagePhase.isEmpty()||(watch!=null&&watch.pending!=null))return;
                try{pendingClose=HerdrProtocol.close(instance,core,coreId,terminal);confirm.dismiss();hideKeyboard();notice.setText("正在关闭电脑上的会话…");update();schedule(0);}
                catch(Exception error){Toast.makeText(this,"会话信息已变化，请刷新后重试。",Toast.LENGTH_LONG).show();}
            });confirm.show();
    }
    private void chooseControlKey(){if(!canInput())return;String[] labels={"Ctrl+A","Ctrl+C","Ctrl+D","Ctrl+E","Ctrl+K","Ctrl+L","Ctrl+U","Ctrl+W","Ctrl+Z","←","→","退格"};String[] keys={"ctrl+a","ctrl+c","ctrl+d","ctrl+e","ctrl+k","ctrl+l","ctrl+u","ctrl+w","ctrl+z","left","right","backspace"};HerdrSheet menu=panel("快捷按键","发送到当前终端");
        for(int i=0;i<labels.length;i+=3){LinearLayout line=menu.row();for(int j=i;j<Math.min(i+3,labels.length);j++){final String k=keys[j];Button b=menu.button(labels[j],false,()->{menu.dismiss();key(k);});LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(0,dp(48),1);if(j>i)p.setMarginStart(dp(8));line.addView(b,p);}menu.content.addView(line);menu.gap(8);}menu.show();}
    private int dp(int value){return (int)(value*getResources().getDisplayMetrics().density+.5f);}
    private TextView label(String text,int size,int color){TextView view=new TextView(this);view.setText(text);view.setTextSize(size);view.setTextColor(color);view.setIncludeFontPadding(false);return view;}
    private GradientDrawable rounded(int color){GradientDrawable shape=new GradientDrawable();shape.setColor(color);shape.setCornerRadius(dp(10));return shape;}
    private void styleButton(Button button,int color){
        button.setBackgroundTintList(null);button.setStateListAnimator(null);
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(0x183f5ed7),rounded(color),null));
        button.setTextColor(new ColorStateList(new int[][]{new int[]{-android.R.attr.state_enabled},new int[]{}},new int[]{colors.muted,color==colors.primary?colors.onPrimary:colors.ink}));
    }
    private Button button(LinearLayout row,String text,Runnable action){Button button=new Button(this);button.setText(text);button.setTextSize(13);button.setAllCaps(false);button.setMinWidth(dp(44));button.setMinimumWidth(dp(44));button.setMinHeight(0);button.setMinimumHeight(0);button.setIncludeFontPadding(false);button.setGravity(android.view.Gravity.CENTER);button.setPadding(dp(10),0,dp(10),0);styleButton(button,colors.field);button.setOnClickListener(v->action.run());LinearLayout.LayoutParams size=new LinearLayout.LayoutParams(-2,dp(44));if(row.getChildCount()>0)size.setMarginStart(dp(4));row.addView(button,size);return button;}
    @Override protected void onStart(){super.onStart();foreground=true;epoch++;needList=true;halted=false;readBeforeRetry=true;monitorKey="";
        androidx.core.content.ContextCompat.registerReceiver(this,notifications,new android.content.IntentFilter(HerdrMonitorService.CHANGED),androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED);
        visibleSession();updateInbox();schedule(0);}
    @Override protected void onStop(){
        foreground=false;epoch++;main.removeCallbacks(tick);busy=false;yieldingRead=false;queuedKeys.clear();
        HerdrMonitorService.visible("","","");unregisterReceiver(notifications);
        NvHTTP http=transport;transport=null;if(http!=null){http.cancelHerdrRequests();http.cancelClipboardRequests();}
        if(imagePhase.equals("upload")){imageBusy=false;imagePhase="";notice.setText("图片发送已暂停，返回后可重试。");}
        if(task!=null)task.cancel(true);
        if(pendingClose!=null){pendingClose=null;watch=null;detach=null;clearImage();needList=true;notice.setText("删除结果尚未确认，返回后将刷新列表；不会自动重复删除。");}
        // Unsent drafts stay on this page. A request whose outcome is unknown
        // keeps its sequence; resume reconciles it before any retransmission.
        // The host expires idle observers; it never owns the agent's lifetime.
        super.onStop();
    }
    @Override protected void onDestroy(){main.removeCallbacks(agentSearch);if(secondary!=null)secondary.dismiss();if(createDialog!=null)createDialog.dismiss();worker.shutdownNow();clearImage();super.onDestroy();}
    @Override public void onBackPressed(){if(watch!=null)leaveWatch();else super.onBackPressed();}
    private void schedule(long delay){main.removeCallbacks(tick);if(foreground&&!halted)main.postDelayed(tick,delay);}
    private boolean canInput(){return canKey()&&!imageUncertain&&watch.pending==null&&queuedKeys.isEmpty();}
    private boolean canKey(){return foreground&&connected&&!halted&&!needList&&pendingClose==null&&!imageBusy&&imagePhase.isEmpty()&&watch!=null&&watch.attached&&watch.state.equals("live")&&(watch.pending==null||watch.pending.optString("op").equals("keys"))&&queuedKeys.size()<16;}
    private void yieldRead(){if(busy&&activeOp.equals("read")){yieldingRead=true;NvHTTP http=transport;if(http!=null)http.interruptHerdrRead();}}
    private void update(){
        boolean viewing=watch!=null;scroll.setVisibility(viewing?View.GONE:View.VISIBLE);detail.setVisibility(viewing?View.VISIBLE:View.GONE);count.setVisibility(viewing?View.GONE:View.VISIBLE);
        search.setVisibility(viewing?View.GONE:View.VISIBLE);filters.setVisibility(viewing?View.GONE:View.VISIBLE);listFooter.setVisibility(viewing?View.GONE:View.VISIBLE);
        computer.setVisibility(viewing?View.GONE:View.VISIBLE);refresh.setVisibility(viewing?View.GONE:View.VISIBLE);more.setVisibility(viewing?View.VISIBLE:View.GONE);
        String message=notice.getText().toString();boolean ordinary=message.startsWith("选择已有会话")||message.startsWith("已接入原会话")||message.equals("已发送到电脑会话");
        notice.setVisibility(!viewing&&ordinary&&connected&&pendingCreate==null?View.INVISIBLE:View.VISIBLE);
        computer.setText(computerName()+" · "+(connected?"已连接":halted?"未连接":"连接中"));newAgent.setText(pendingCreate==null?"＋  新建 Agent":"正在核对创建结果…");newAgent.setEnabled(canCreate());updateCreate();
        for(int i=0;i<list.getChildCount();i++){View section=list.getChildAt(i);if(section instanceof LinearLayout){View header=((LinearLayout)section).getChildAt(0);if(header instanceof LinearLayout){LinearLayout row=(LinearLayout)header;for(int j=0;j<row.getChildCount();j++)if(row.getChildAt(j) instanceof Button)row.getChildAt(j).setEnabled(canCreate());}}}
        send.setEnabled(canInput());for(int i=0;i<keyRow.getChildCount();i++)keyRow.getChildAt(i).setEnabled(canKey());refresh.setEnabled(!busy);
        attachImage.setEnabled(canInput()&&images.pasted()==0&&!imagePasted);composer.setEnabled(!imageBusy&&imagePhase.isEmpty());
        commandSuggestions.setContext(selected==null?"":selected.agent,viewing&&canInput());
        attachmentRow.setVisibility(images.size()==0?View.GONE:View.VISIBLE);
        for(int i=0;i<attachmentPreviews.getChildCount();i++)((LinearLayout)attachmentPreviews.getChildAt(i)).getChildAt(1).setEnabled(!imageBusy&&imagePhase.isEmpty()&&images.pasted()==0&&!imagePasted);
        back.setEnabled(!imageBusy&&imagePhase.isEmpty()&&(!busy || watch==null || watch.pending==null));
        boolean agent=selected!=null&&HerdrSessions.isAgent(selected);
        detailTask.setVisibility(viewing&&agent?View.VISIBLE:View.GONE);
        HerdrMonitorService.visible(foreground?host.optString("uuid"):"",core,watch==null?"":watch.terminal);
    }
    private void visibleSession(){HerdrMonitorService.visible(foreground?host.optString("uuid"):"",core,watch==null?"":watch.terminal);if(watch!=null)markRead(watch.terminal);}
    private void markRead(String terminal){
        SharedPreferences.Editor read=preferences.edit();for(HerdrProtocol.Terminal t:terminals)if(terminal==null||terminal.equals(t.address))read.putLong("readTurn:"+coreId+":"+t.address,t.turn);read.apply();
        if(monitorStore==null)return;synchronized(monitorStore){HerdrMonitorStore.Target target=monitorStore.find(host.optString("uuid"),core);if(target==null)return;try{
        target.ledger.read(terminal);monitorStore.save();for(JSONObject e:target.ledger.events())if(e.optBoolean("read"))getSystemService(android.app.NotificationManager.class).cancel(e.optString("id"),7822);
    }catch(Exception ignored){}}updateInbox();}
    private void updateInbox(){if(inboxButton==null)return;int unread=0;if(monitorStore!=null)synchronized(monitorStore){HerdrMonitorStore.Target target=monitorStore.find(host.optString("uuid"),core);if(target!=null)unread=target.ledger.unread();}inboxButton.setText(unread>0?"提醒 "+unread:"提醒");if(search!=null)showList();}
    private Set<String> unreadTerminals(){
        Set<String> result=new HashSet<>();
        if(monitorStore!=null)synchronized(monitorStore){HerdrMonitorStore.Target target=monitorStore.find(host.optString("uuid"),core);if(target!=null)for(JSONObject event:target.ledger.events())if(!event.optBoolean("read")&&coreId.equals(event.optString("coreId")))result.add(event.optString("terminal"));}
        for(HerdrProtocol.Terminal t:terminals)if(t.unread&&preferences.getLong("readTurn:"+coreId+":"+t.address,-1)<t.turn)result.add(t.address);
        return result;
    }
    private void ensureMonitor(){
        if(monitorStore==null||monitorKey.equals(host.optString("uuid")+":"+core))return;
        try{HerdrMonitorStore.Target target=monitorStore.register(host,core);monitorKey=target.key();
            if(target.enabled){HerdrMonitorService.start(this);if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)!=android.content.pm.PackageManager.PERMISSION_GRANTED&&!preferences.getBoolean("notificationAsked",false)){
                preferences.edit().putBoolean("notificationAsked",true).apply();requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS},72);
            }}
        }catch(Exception error){Toast.makeText(this,"后台提醒暂未启动，可在提醒中重试",Toast.LENGTH_LONG).show();}updateInbox();
    }
    private void showInbox(){
        HerdrSheet dialog=panel("Agent 提醒",computerName()+" · 完成与待处理消息");
        if(monitorStore==null){dialog.state("暂时无法读取提醒","关闭面板后重试。",false);dialog.show();return;}
        HerdrMonitorStore.Target target=monitorStore.find(host.optString("uuid"),core);
        if(target==null){dialog.state("还没有连接电脑","连接后可在这里接收 Agent 提醒。",false);dialog.show();return;}
        LinearLayout setting=dialog.row();setting.setPadding(dp(14),dp(12),dp(14),dp(12));setting.setBackground(dialog.shape(colors.field,16));
        LinearLayout words=dialog.column();words.addView(dialog.text("后台提醒",15,colors.ink));TextView hint=dialog.text("任务完成或需要你处理时通知",12,colors.muted);hint.setPadding(0,dp(5),dp(8),0);words.addView(hint);setting.addView(words,new LinearLayout.LayoutParams(0,-2,1));
        Switch enabled=new Switch(this);enabled.setContentDescription("后台完成与待处理提醒");enabled.setChecked(target.enabled);enabled.setThumbTintList(new ColorStateList(new int[][]{new int[]{android.R.attr.state_checked},new int[]{}},new int[]{colors.primary,colors.muted}));setting.addView(enabled);dialog.content.addView(setting);dialog.gap(12);
        enabled.setOnCheckedChangeListener((v,on)->{synchronized(monitorStore){target.enabled=on;try{monitorStore.save();if(on)HerdrMonitorService.start(this);}catch(Exception e){Toast.makeText(this,"提醒设置未能保存",Toast.LENGTH_LONG).show();}}});
        if(!target.error.isEmpty()){dialog.state("提醒连接待恢复",target.error,false);dialog.gap(12);}
        if(!getSystemService(android.app.NotificationManager.class).areNotificationsEnabled())dialog.choice("允许系统通知","在系统设置中开启通知权限","i",false,true,()->startActivity(new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE,getPackageName())));
        List<JSONObject> events;synchronized(monitorStore){events=target.ledger.events();}
        dialog.label("最近提醒 · "+target.ledger.unread()+" 条未读");
        if(events.isEmpty())dialog.state("暂无提醒","Agent 完成任务或等待输入时，消息会出现在这里。",false);
        for(JSONObject event:events){String address=event.optString("terminal");boolean unread=!event.optBoolean("read");
            LinearLayout card=dialog.column();card.setPadding(dp(14),dp(14),dp(14),dp(14));card.setBackground(new RippleDrawable(ColorStateList.valueOf(0x183f5ed7),dialog.shape(unread?colors.selection:colors.field,16),null));
            LinearLayout top=dialog.row();TextView title=dialog.text(event.optString("project"),16,colors.ink);title.setTypeface(null,Typeface.BOLD);title.setMaxLines(2);top.addView(title,new LinearLayout.LayoutParams(0,-2,1));
            TextView status=dialog.text(HerdrEventLedger.label(event.optString("kind")),11,event.optString("kind").equals("error")?colors.danger:colors.primary);status.setPadding(dp(8),dp(5),dp(8),dp(5));status.setBackground(dialog.shape(colors.surface,8));LinearLayout.LayoutParams badge=new LinearLayout.LayoutParams(-2,-2);badge.setMarginStart(dp(10));top.addView(status,badge);card.addView(top);
            TextView task=dialog.text(event.optString("title"),14,colors.ink);task.setPadding(0,dp(10),0,dp(8));task.setMaxLines(3);task.setEllipsize(TextUtils.TruncateAt.END);card.addView(task);
            String when=android.text.format.DateUtils.getRelativeTimeSpanString(event.optLong("time"),System.currentTimeMillis(),60000).toString();card.addView(dialog.text((unread?"●  ":"")+event.optString("agent")+" · "+when,12,colors.muted));
            card.setContentDescription(event.optString("project")+"，"+HerdrEventLedger.label(event.optString("kind"))+"，"+event.optString("title"));card.setFocusable(true);card.setOnClickListener(v->{notificationTerminal=address;notificationCoreId=event.optString("coreId",event.optString("id").split(":")[0]);dialog.dismiss();needList=true;schedule(0);});
            LinearLayout.LayoutParams size=new LinearLayout.LayoutParams(-1,-2);size.bottomMargin=dp(10);dialog.content.addView(card,size);
        }dialog.show();
        if(!events.isEmpty()){Button read=dialog.action("全部标为已读",false,false,()->{markRead(null);showInbox();});read.setEnabled(target.ledger.unread()>0);}
    }
    @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);setIntent(intent);
        try{JSONObject destination=TransferStorage.host(intent);if(!TransferStorage.sameHost(host,destination)||!core.equals(intent.getStringExtra("herdrCore"))){startActivity(new Intent(intent).setFlags(0));return;}
            notificationTerminal=intent.getStringExtra("herdrTerminal");if(notificationTerminal==null)notificationTerminal="";notificationCoreId=intent.getStringExtra("herdrCoreId");if(notificationCoreId==null)notificationCoreId="";needList=true;schedule(0);
        }catch(Exception ignored){}
    }
    private static String status(String word){switch(word){case "working":return "运行中";case "blocked":return "等待输入";case "done":return "已完成";case "idle":return "就绪";case "error":return "出现错误";default:return "状态未知";}}
    private void showList(){showList(false);}
    private void showList(boolean force){
        if(list==null||watch!=null)return;
        heading.setText("Herdr");
        String query=search.getText().toString().trim().toLowerCase(Locale.ROOT);
        Set<String> unread=unreadTerminals();
        List<HerdrProtocol.Terminal> agentSessions=HerdrSessions.select(terminals,unread,"all","");
        List<HerdrProtocol.Terminal> visible=HerdrSessions.select(agentSessions,unread,filter,query);
        StringBuilder signature=new StringBuilder(query+filter);
        for(HerdrProtocol.Project p:projects)signature.append(p.id).append(p.name).append(p.available);
        for(HerdrProtocol.Terminal t:agentSessions)signature.append(t.address).append(t.projectLabel()).append(t.label()).append(t.status).append(t.agentName).append(t.updatedMs).append(unread.contains(t.address));
        if(!force&&signature.toString().equals(listSignature))return;
        listSignature=signature.toString();int position=scroll.getScrollY();list.removeAllViews();filters.removeAllViews();
        LinkedHashMap<String,String> names=new LinkedHashMap<>();
        String[] sections={"等待你处理","运行中","未读","已完成","其他会话","已结束"};
        for(HerdrProtocol.Terminal t:visible){int rank=HerdrSessions.priority(t,unread);names.put(String.valueOf(rank),sections[rank]);}
        int working=0,unreadCount=0,done=0;Set<String> projectIds=new HashSet<>();for(HerdrProtocol.Terminal t:agentSessions){projectIds.add(t.group());if(t.status.equals("working"))working++;if(unread.contains(t.address))unreadCount++;if(t.status.equals("done"))done++;}
        String[][] choices={{"全部 "+agentSessions.size(),"all"},{"运行中 "+working,"working"},{"未读 "+unreadCount,"unread"},{"已完成 "+done,"done"}};
        for(String[] choice:choices){Button b=button(filters,choice[0],()->{filter=choice[1];showList(true);});b.setTextSize(11);b.setPadding(dp(8),0,dp(8),0);styleButton(b,filter.equals(choice[1])?colors.selection:colors.field);}
        count.setText(agentSessions.size()+" 个 Agent 会话 · "+projectIds.size()+" 个项目");
        int groups=0;
        for(Map.Entry<String,String> group:names.entrySet()){
            List<HerdrProtocol.Terminal> items=new ArrayList<>();
            for(HerdrProtocol.Terminal t:visible)if(String.valueOf(HerdrSessions.priority(t,unread)).equals(group.getKey()))items.add(t);
            if(items.isEmpty()&&(!filter.equals("all")||(!query.isEmpty()&&!group.getValue().toLowerCase(Locale.ROOT).contains(query))))continue;
            groups++;LinearLayout section=column();LinearLayout.LayoutParams margin=new LinearLayout.LayoutParams(-1,-2);margin.setMargins(0,dp(10),0,dp(4));list.addView(section,margin);
            LinearLayout header=row();TextView title=label(group.getValue(),20,colors.ink);title.setTypeface(null,Typeface.BOLD);title.setMaxLines(2);title.setEllipsize(TextUtils.TruncateAt.END);header.addView(title,new LinearLayout.LayoutParams(0,-2,1));
            section.addView(header);TextView sub=label(items.size()+" 个会话",11,colors.muted);sub.setPadding(0,0,0,dp(8));section.addView(sub);
            if(items.isEmpty())section.addView(label("还没有会话，点 ＋ 开始",12,colors.muted));
            for(HerdrProtocol.Terminal item:items){
                LinearLayout card=column();card.setPadding(dp(12),dp(10),dp(12),dp(10));card.setBackground(new RippleDrawable(ColorStateList.valueOf(0x208fb7ff),rounded(colors.surface),null));
                LinearLayout.LayoutParams cardSize=new LinearLayout.LayoutParams(-1,-2);cardSize.bottomMargin=dp(6);section.addView(card,cardSize);
                LinearLayout line=row();
                if(item.agent.equals("codex")||item.agent.equals("claude")){
                    ImageView mark=new ImageView(this);mark.setImageResource(item.agent.equals("codex")?com.limelight.R.drawable.herdr_codex:com.limelight.R.drawable.herdr_claude);
                    mark.setScaleType(ImageView.ScaleType.FIT_CENTER);mark.setContentDescription(item.agentName+" 图标");line.addView(mark,new LinearLayout.LayoutParams(dp(30),dp(30)));
                }else{TextView mark=label("›_",18,colors.primary);mark.setGravity(android.view.Gravity.CENTER);mark.setBackground(rounded(colors.selection));line.addView(mark,new LinearLayout.LayoutParams(dp(30),dp(30)));}
                TextView titleText=label(item.label(),15,colors.ink);titleText.setTypeface(null,Typeface.BOLD);titleText.setPadding(dp(9),0,dp(5),0);titleText.setMaxLines(2);titleText.setEllipsize(TextUtils.TruncateAt.END);line.addView(titleText,new LinearLayout.LayoutParams(0,-2,1));card.addView(line);
                TextView metadata=label(item.projectLabel()+" · "+item.agentName+" · "+item.address+(unread.contains(item.address)?" · 未读":""),12,unread.contains(item.address)||item.status.equals("working")?colors.primary:colors.muted);metadata.setPadding(dp(39),dp(6),0,0);card.addView(metadata);
                card.setFocusable(true);card.setContentDescription(item.projectLabel()+"，"+item.agentName+"，"+item.label()+"，"+status(item.status));card.setOnClickListener(v->open(item));
                card.setOnLongClickListener(v->{showSessionMenu(v,item);return true;});
            }
        }
        if(groups==0)list.addView(label(query.isEmpty()?"暂无匹配的会话。可点「＋ 新建 Agent」开始。":"没有找到匹配的项目或会话。",14,colors.muted));
        scroll.post(()->scroll.scrollTo(0,force?0:position));
    }
    private HerdrProtocol.Project project(String id){for(HerdrProtocol.Project p:projects)if(p.id.equals(id))return p;return null;}
    private HerdrProtocol.Agent agent(String id){if(pickedAgent!=null&&pickedAgent.id.equals(id))return pickedAgent;for(HerdrProtocol.Agent a:agents)if(a.id.equals(id))return a;return null;}
    private String agentMark(String name){return name.equals("Codex")?":codex":name.equals("Claude Code")?":claude":name.isEmpty()?"›_":name.substring(0,1).toUpperCase(Locale.ROOT);}
    private boolean canCreate(){return connected&&!halted&&!needList&&pendingClose==null&&pendingCreate==null&&!projects.isEmpty();}
    private void showCreate(String id){
        if(!canCreate())return;
        selectedProject=id==null?preferences.getString("lastProject",""):id;
        if(project(selectedProject)==null)selectedProject=projects.get(0).id;
        selectedAgent=preferences.getString("lastAgent","codex");
        if(agent(selectedAgent)==null||!agent(selectedAgent).available)for(HerdrProtocol.Agent a:agents)if(a.available){selectedAgent=a.id;break;}
        creationName="";openCreateDialog();
    }
    private void openCreateDialog(){
        if(createDialog!=null&&createDialog.isShowing())return;
        HerdrSheet dialog=new HerdrSheet(this,"新建 Agent","在电脑 "+computerName()+" 上启动");createDialog=dialog;sheet=dialog.content;
        sheet.setFocusableInTouchMode(true);sheet.requestFocus();dialog.setOnDismissListener(d->{if(createDialog==dialog){createDialog=null;createButton=null;}});
        renderCreate();dialog.show();
    }
    private void renderCreate(){
        if(!(createDialog instanceof HerdrSheet))return;HerdrSheet dialog=(HerdrSheet)createDialog;sheet.removeAllViews();dialog.footer.removeAllViews();boolean creating=pendingCreate!=null;
        dialog.label("项目");HerdrProtocol.Project p=project(selectedProject);dialog.choice(p==null?"选择项目":p.name,p==null?"选择电脑上的工作空间":p.folder,"▱",false,!creating,this::chooseProject).setContentDescription("选择项目");
        dialog.label("Agent");HerdrProtocol.Agent a=agent(selectedAgent);dialog.choice(a==null?"选择 Agent":a.name,a==null?"查找电脑已安装的 CLI":a.available?a.command+" · 已安装":a.reason,a==null?"+":agentMark(a.name),false,!creating,this::chooseAgent).setContentDescription("选择 Agent");
        dialog.label("会话名称 · 选填");EditText name=dialog.search("例如：修复手机连接");name.setContentDescription("会话名称");name.setText(creationName);name.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(80)});name.setEnabled(!creating);name.addTextChangedListener(new TextWatcher(){public void beforeTextChanged(CharSequence s,int st,int c,int n){}public void onTextChanged(CharSequence s,int st,int b,int c){creationName=s.toString();}public void afterTextChanged(Editable e){}});
        if(creating)dialog.state("正在创建会话","连接恢复后会核对结果，不会重复启动。",true);
        creationNotice=label(creating?"正在创建；断线后会先核对结果，不重复启动。":"留空时自动使用 Agent 名称与序号。",12,colors.muted);creationNotice.setPadding(0,dp(13),0,dp(8));sheet.addView(creationNotice);
        createButton=dialog.action("创建会话",true,false,this::create);updateCreate();
        createDialog.setCancelable(true);
    }
    private void chooseProject(){
        if(pendingCreate!=null)return;hideKeyboard();HerdrSheet dialog=panel("选择项目",projects.size()+" 个电脑工作空间");EditText search=dialog.search("搜索项目");
        LinearLayout results=column();dialog.content.addView(results);Runnable render=()->{results.removeAllViews();String q=search.getText().toString().trim().toLowerCase(Locale.ROOT);for(HerdrProtocol.Project p:projects)if((p.name+" "+p.folder).toLowerCase(Locale.ROOT).contains(q)){
            LinearLayout card=dialog.choice(p.name,p.available?p.folder:p.reason,"▱",p.id.equals(selectedProject),p.available,()->{selectedProject=p.id;dialog.dismiss();renderCreate();});dialog.content.removeView(card);results.addView(card);
        }if(results.getChildCount()==0){TextView empty=dialog.text("没有找到匹配的项目",14,colors.muted);empty.setPadding(dp(8),dp(24),dp(8),dp(24));results.addView(empty);}};
        search.addTextChangedListener(watcher(render));render.run();dialog.show();
    }
    private TextWatcher watcher(Runnable changed){return new TextWatcher(){public void beforeTextChanged(CharSequence s,int st,int c,int a){}public void onTextChanged(CharSequence s,int st,int b,int c){changed.run();}public void afterTextChanged(Editable e){}};}
    private void chooseAgent(){
        if(pendingCreate!=null)return;hideKeyboard();HerdrSheet dialog=panel("选择 Agent","电脑上可调用的 CLI，都可以从这里创建");agentPicker=dialog;agentQuery="";
        EditText query=dialog.search("搜索 Agent 或 CLI 名称");query.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(80)});agentResults=column();dialog.content.addView(agentResults);
        query.addTextChangedListener(watcher(()->{agentQuery=query.getText().toString().trim();main.removeCallbacks(agentSearch);main.postDelayed(agentSearch,250);}));
        dialog.show();requestAgents("");
    }
    private void requestAgents(String query){
        if(agentPicker==null||!agentPicker.isShowing())return;
        try{pendingAgents=new JSONObject().put("op","agents").put("query",query);renderAgentState("正在查找电脑上的 CLI","首次扫描可能需要几秒钟。",true);schedule(0);}catch(Exception ignored){}
    }
    private void renderAgentState(String title,String caption,boolean loading){
        if(agentPicker==null)return;agentResults.removeAllViews();agentPicker.state(title,caption,loading);View state=agentPicker.content.getChildAt(agentPicker.content.getChildCount()-1);agentPicker.content.removeView(state);agentResults.addView(state);
        if(!loading){Button retry=agentPicker.button("重新查找",false,()->requestAgents(agentQuery));LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,dp(48));p.topMargin=dp(12);agentResults.addView(retry,p);}
    }
    private void showAgentResults(List<HerdrProtocol.Agent> values,int total){
        if(agentPicker==null)return;HerdrSheet dialog=agentPicker;agentResults.removeAllViews();
        if(values.isEmpty()){dialog.state(agentQuery.isEmpty()?"还没有识别到 Agent":"没有找到这个 CLI",agentQuery.isEmpty()?"输入 CLI 命令名搜索，也支持 Herdr 中自定义的启动配置。":"请确认该 CLI 已安装，并且电脑终端可以调用它。",false);View v=dialog.content.getChildAt(dialog.content.getChildCount()-1);dialog.content.removeView(v);agentResults.addView(v);return;}
        for(HerdrProtocol.Agent a:values){String detail=a.command+" · "+(a.source.equals("configured")?"Herdr 配置":a.source.equals("cli")?"电脑 CLI":"已安装");if(!a.available)detail=a.reason;
            LinearLayout card=dialog.choice(a.name,detail,agentMark(a.name),a.id.equals(selectedAgent),a.available,()->{pickedAgent=a;selectedAgent=a.id;dialog.dismiss();hideKeyboard();renderCreate();});dialog.content.removeView(card);agentResults.addView(card);
        }
        TextView hint=dialog.text(total>values.size()?"还有更多结果，请输入更完整的命令名。":"没有看到想用的 Agent？输入 CLI 命令名搜索。",12,colors.muted);hint.setPadding(dp(4),dp(12),dp(4),dp(8));agentResults.addView(hint);
    }
    private void updateCreate(){
        if(createButton==null)return;HerdrProtocol.Project p=project(selectedProject);HerdrProtocol.Agent a=agent(selectedAgent);
        createButton.setText(pendingCreate!=null?"正在创建…":"创建会话");
        createButton.setEnabled(canCreate()&&p!=null&&p.available&&a!=null&&a.available);
        if(pendingCreate==null&&creationNotice!=null){
            if(!connected)creationNotice.setText("电脑连接已断开，恢复连接后即可创建。");
            else if(p!=null&&!p.available)creationNotice.setText(p.reason);
            else if(a!=null&&!a.available)creationNotice.setText(a.reason);
        }
    }
    private void create(){
        if(!canCreate())return;
        try{JSONObject request=HerdrProtocol.create(core,selectedProject,selectedAgent,creationName);
            if(!preferences.edit().putString("pendingCreate",request.toString()).putString("lastProject",selectedProject).putString("lastAgent",selectedAgent).commit())throw new IOException("无法保存创建请求，请重试。");
            hideKeyboard();pendingCreate=request;renderCreate();notice.setText("正在电脑上创建会话…");update();schedule(0);
        }catch(Exception error){creationNotice.setText(error.getMessage());}
    }
    private void clearCreate(){pendingCreate=null;preferences.edit().remove("pendingCreate").commit();}
    private void hideKeyboard(){View focus=createDialog!=null?createDialog.getCurrentFocus():getCurrentFocus();if(focus!=null)((android.view.inputmethod.InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(focus.getWindowToken(),0);}
    private void open(HerdrProtocol.Terminal terminal){
        if(needList||instance.isEmpty()||pendingClose!=null)return;
        if(!terminal.state.equals("live")){notice.setText("这个终端已结束，请新建会话。");return;}
        // A catalog refresh must not hold up a deliberate session selection.
        // Only cancel the read-only catalog request; never interrupt input/create.
        if(busy&&activeOp.equals("list")){
            epoch++;busy=false;if(task!=null)task.cancel(true);
            NvHTTP http=transport;transport=null;if(http!=null)http.cancelHerdrRequests();
        }
        hideKeyboard();clearImage();selected=terminal;watch=new HerdrProtocol.Watch(instance,core,terminal.address);sentText="";composer.setText("");terminalView.setAgent(terminal.agent);terminalView.reset(80,24);heading.setText(terminal.label());heading.setContentDescription(terminal.label());
        visibleSession();
        detailMeta.setText(terminal.agentName+"  ·  "+status(terminal.status));detailTask.setText(terminal.projectLabel()+" · "+terminal.agentName+" · "+terminal.address);composer.setHint("给 "+terminal.agentName+" 发消息…");
        notice.setText("正在接入原会话…");readBeforeRetry=false;halted=false;update();schedule(0);
    }
    private void leaveWatch(){
        if(watch==null)return;
        if(pendingClose!=null){notice.setText("正在关闭会话，请稍候。");return;}
        if(watch.pending!=null||imageBusy||!imagePhase.isEmpty()){notice.setText("正在确认上一条输入，请稍候再切换会话。");return;}
        try{detach=HerdrProtocol.request("detach",watch.instance,watch.id);}catch(Exception ignored){}
        watch=null;clearImage();composer.setText("");sentText="";needList=false;halted=false;showList();update();schedule(0);
        visibleSession();
    }
    private void send(){if(!canInput())return;String text=composer.getText().toString();try{
        if(images.size()>0){
            // Validate text before changing the computer clipboard or submitting anything.
            if(!text.isEmpty()){HerdrProtocol.Watch check=new HerdrProtocol.Watch(instance,core,watch.terminal);check.attached=true;check.send(text);}
            if(!images.allPasted()){uploadImage(text);return;}
            imagePhase="submit";
            if(text.isEmpty())watch.key("enter");else watch.send(text);
        }else if(text.isEmpty())watch.key("enter");else watch.send(text);
        sentText=text;notice.setText("正在提交到电脑…");yieldRead();update();schedule(0);
    }catch(Exception error){imagePhase="";composer.setError("请输入有效文字，最多 16 KiB。");}}
    private void key(String key){if(!canKey())return;try{
        if(watch.pending!=null)queuedKeys.addLast(key);else watch.key(key);
        sentText="";notice.setText("正在发送按键…");yieldRead();update();schedule(0);
    }catch(Exception error){failure(error);}}
    private void chooseCore(){
        if(watch!=null||busy||pendingCreate!=null||pendingClose!=null)return;
        HerdrSheet dialog=panel("连接工作区","通常使用 default；电脑启用了命名 core 时再修改。");EditText name=dialog.search("工作区名称");name.setText(core);
        dialog.action("取消",false,false,dialog::dismiss);dialog.action("连接",true,false,()->{String value=name.getText().toString().trim();if(value.matches("[^/\\\\:*?\"<>|\\p{Cntrl}]{1,80}")&&!value.equals(".")&&!value.equals("..")){core=value;preferences.edit().putString("core",core).apply();needList=true;halted=false;dialog.dismiss();schedule(0);}else name.setError("请输入有效的工作区名称");});dialog.show();
    }
    private void pump(){
        if(!foreground||busy||halted||imageBusy)return;
        try{
            JSONObject request;
            if(detach!=null)request=new JSONObject(detach.toString());
            else if(pendingClose!=null)request=new JSONObject(pendingClose.toString());
            else if(pendingAgents!=null)request=new JSONObject(pendingAgents.toString());
            else if(needList)request=new JSONObject().put("op","list").put("coreSession",core);
            else if(pendingCreate!=null)request=new JSONObject(pendingCreate.toString());
            else if(watch==null)request=new JSONObject().put("op","list").put("coreSession",core);
            else if(!watch.attached)request=watch.attach();
            else if(readBeforeRetry)request=watch.read();
            else if(watch.pending!=null)request=new JSONObject(watch.pending.toString());
            else request=watch.read();
            activeOp=request.getString("op");busy=true;if(!activeOp.equals("read"))update();final int generation=epoch;final boolean recover=recoverRoute;recoverRoute=false;
            task=worker.submit(()->{try{
                NvHTTP http=connection(generation,recover);
                HerdrProtocol.Reply reply=new HerdrProtocol.Reply(request,http.herdrRequest(request));
                main.post(()->{if(foreground&&epoch==generation){busy=false;success(request,reply);}});
            }catch(Exception error){main.post(()->{if(foreground&&epoch==generation){busy=false;failure(error);}});}});
        }catch(Exception error){failure(error);}
    }
    private NvHTTP connection(int generation,boolean recover) throws Exception {
        JSONObject destination=new JSONObject(host.toString());
        ComputerDatabaseManager database=new ComputerDatabaseManager(getApplicationContext());ComputerDetails computer;
        try{computer=database.getComputerByUUID(host.getString("uuid"));}finally{database.close();}
        if(computer==null||computer.serverCert==null||!Base64.getEncoder().encodeToString(computer.serverCert.getEncoded()).equals(host.getString("cert")))throw new IOException("HERDR_UNPAIRED");
        if(recover){ComputerDetails route=StreamRouteRecovery.select(getApplicationContext(),host.getString("uuid"),host.getString("uniqueId"));if(route==null||route.activeAddress==null)throw new IOException("HERDR_UNAVAILABLE");destination.put("address",route.activeAddress.address).put("port",route.activeAddress.port).put("https",route.httpsPort);}
        NvHTTP http=transport;
        if(http==null||recover){if(http!=null)http.cancelHerdrRequests();http=TransferStorage.connection(getApplicationContext(),destination);transport=http;}
        if(!foreground||epoch!=generation||Thread.currentThread().isInterrupted()){http.cancelHerdrRequests();if(transport==http)transport=null;throw new InterruptedException();}
        return http;
    }
    private void inputResult(JSONObject result) throws Exception {
        watch.acknowledge(result);
        if(imagePhase.equals("paste")){
            imagePhase="";
            if(!watch.inputCode.isEmpty()){notice.setText("图片粘贴结果未确认，请先检查电脑输入框，未继续提交。");imageUncertain=true;imageStatus.setText("粘贴结果待核对，可返回后重新编辑");return;}
            images.acknowledgePaste();imagePasted=images.allPasted();
            if(!imagePasted){uploadImage(imageText);return;}
            imageStatus.setText(images.size()+" 张图片已添加，正在提交…");imagePhase="submit";sentText=imageText;
            if(imageText.isEmpty())watch.key("enter");else watch.send(imageText);
            return;
        }
        if(watch.inputCode.isEmpty()){
            boolean submitted=!sentText.isEmpty()||imagePhase.equals("submit");
            if(!sentText.isEmpty()&&composer.getText().toString().equals(sentText))composer.setText("");
            if(imagePhase.equals("submit"))clearImage();
            notice.setText(submitted?"文字和回车已送达，请查看终端回应":"按键已送达终端");
        }else {queuedKeys.clear();notice.setText(message(watch.inputCode)+" 请查看输出后再决定是否重发。");}
        imagePhase="";
        sentText="";
        if(!queuedKeys.isEmpty())watch.key(queuedKeys.removeFirst());
    }
    private void success(JSONObject request,HerdrProtocol.Reply reply){
        yieldingRead=false;
        boolean wasConnected=connected;failures=0;connected=true;
        try{
            String op=request.getString("op");
            boolean receivedOutput=false,refreshUi=!op.equals("read")||!wasConnected;
            if(op.equals("agents")){
                if(pendingAgents!=null&&request.optString("query").equals(pendingAgents.optString("query")))pendingAgents=null;
                if(agentPicker!=null&&request.optString("query").equals(agentQuery))showAgentResults(reply.agents(),reply.result.optInt("total"));
            }else if(op.equals("list")){
                if(!instance.isEmpty()&&!instance.equals(reply.instance)&&watch!=null){boolean uncertain=watch.pending!=null;watch=null;imagePhase="";imageBusy=false;sentText="";notice.setText(uncertain?"连接服务已重启，上一条输入结果不确定，请检查电脑会话。":"连接已恢复，请重新选择会话。");}
                instance=reply.instance;coreId=reply.result.optString("coreId");terminals=reply.terminals();projects=reply.projects();agents=reply.agents();needList=false;
                if(reply.result.has("coreId"))ensureMonitor();
                if(watch==null){showList();if(!notice.getText().toString().contains("不确定"))notice.setText(pendingCreate==null?"选择已有会话，或点 ＋ 新建 Agent":"正在核对创建结果…");}
                if(pendingCreate!=null){selectedProject=pendingCreate.getString("project");selectedAgent=pendingCreate.getString("agent");creationName=pendingCreate.optString("name");openCreateDialog();}
                if(!notificationTerminal.isEmpty()&&!notificationCoreId.isEmpty()&&!notificationCoreId.equals(reply.result.optString("coreId"))){notificationTerminal="";notice.setText("电脑工作区已重启，这条旧提醒对应的会话已结束。");}
                if(!notificationTerminal.isEmpty()&&pendingCreate==null&&!imageBusy&&imagePhase.isEmpty()&&(watch==null||watch.pending==null)){
                    String target=notificationTerminal;notificationTerminal="";HerdrProtocol.Terminal found=null;for(HerdrProtocol.Terminal t:terminals)if(t.address.equals(target))found=t;
                    if(found!=null){if(watch!=null&&!watch.terminal.equals(target))leaveWatch();if(watch==null)open(found);if(watch!=null&&watch.terminal.equals(target)){markRead(target);if(watch.attached)notice.setText("已接入原会话 · 电脑与手机共用");}}
                    else notice.setText("通知对应的终端已不在运行，可返回查看其他会话。");
                }
            }else if(op.equals("create")){
                HerdrProtocol.Terminal created=new HerdrProtocol.Terminal(reply.result.getJSONObject("terminal"));
                instance=reply.instance;clearCreate();if(createDialog!=null){createDialog.dismiss();createDialog=null;createButton=null;}
                terminals.removeIf(t->t.address.equals(created.address));terminals.add(0,created);needList=false;open(created);
            }else if(op.equals("close")){
                HerdrProtocol.require(reply.result.getBoolean("closed")&&request.getString("terminal").equals(reply.result.getString("terminal")));
                String closed=request.getString("terminal");pendingClose=null;
                terminals.removeIf(t->t.address.equals(closed));
                if(watch!=null&&watch.terminal.equals(closed))leaveWatch();
                needList=true;showList(true);notice.setText("会话已删除，项目文件已保留。");Toast.makeText(this,"会话已删除",Toast.LENGTH_SHORT).show();
            }else if(op.equals("detach")){detach=null;needList=true;}
            else if(watch!=null&&request.getString("id").equals(watch.id)){
                if(op.equals("watch")){
                    int columns=reply.result.getInt("columns"),rows=reply.result.getInt("rows");HerdrProtocol.dimensions(columns,rows);
                    terminalView.reset(columns,rows);watch.attached=true;notice.setText("已接入原会话 · 电脑与手机共用");
                }else if(op.equals("read")){
                    for(HerdrProtocol.Chunk chunk:watch.consume(reply.result)){
                        if(chunk.kind.equals("resize"))terminalView.resize(chunk.columns,chunk.rows);
                        else if(chunk.kind.equals("data")){terminalView.append(chunk.data);receivedOutput=true;}
                    }
                    if(readBeforeRetry&&watch.pending!=null){refreshUi=true;long accepted=reply.result.getLong("accepted");if(accepted==watch.pending.getLong("sequence"))inputResult(reply.result);else HerdrProtocol.require(accepted==watch.accepted);}
                    readBeforeRetry=false;
                    if(watch.state.equals("disconnected")){throw new IOException("HERDR_RESYNC");}
                    if(watch.state.equals("finished")){refreshUi=true;notice.setText("这个终端已结束，可返回选择其他会话。");}
                    else if(watch.pending==null&&notice.getText().toString().equals("连接暂时中断，正在重连…")){
                        notice.setText("已接入原会话 · 电脑与手机共用");refreshUi=true;
                    }
                }else if(op.equals("send")||op.equals("keys"))inputResult(reply.result);
            }
            if(!notificationTerminal.isEmpty()&&pendingCreate==null&&!imageBusy&&imagePhase.isEmpty()&&(watch==null||watch.pending==null))needList=true;
            if(refreshUi)update();
            // Drain queued snapshot chunks immediately; idle reads need no view relayout.
            schedule(pendingAgents!=null||pendingCreate!=null||watch!=null&&watch.pending!=null?0:watch==null&&detach==null?2500:op.equals("read")&&!receivedOutput?150:0);
        }catch(Exception error){failure(error);}
    }
    private void failure(Exception error){
        if(yieldingRead&&activeOp.equals("read")){yieldingRead=false;busy=false;schedule(0);return;}
        // BUSY is a pre-dispatch rejection caused by another observer. Keep TLS
        // and the exact pending sequence; route discovery cannot resolve it.
        if("HERDR_BUSY".equals(error.getMessage())){busy=false;schedule(100);return;}
        queuedKeys.clear();
        busy=false;connected=false;String code=error.getMessage()==null?"HERDR_UNAVAILABLE":error.getMessage();
        NvHTTP http=transport;transport=null;if(http!=null)http.cancelHerdrRequests();
        readBeforeRetry=true;recoverRoute=!code.equals("HERDR_BUSY");failures++;
        if(activeOp.equals("agents")){
            if(code.equals("HERDR_BUSY")&&pendingAgents!=null&&failures<=5){connected=true;schedule(400);return;}
            pendingAgents=null;renderAgentState("暂时无法读取电脑 CLI",code.equals("HERDR_BAD_REQUEST")?"请先更新电脑端 ClipRelay。":"检查电脑连接后重试。",false);update();schedule(1500);return;
        }
        if(activeOp.equals("close")){
            // BUSY is an explicit pre-dispatch rejection, not an uncertain deletion.
            if(code.equals("HERDR_BUSY")&&pendingClose!=null&&failures<=5){connected=true;notice.setText("正在等待电脑处理删除…");update();schedule(400);return;}
            pendingClose=null;if(watch!=null)leaveWatch();needList=true;halted=false;
            String text=code.equals("HERDR_STALE")?"会话信息已变化，请刷新后重新选择。":code.equals("HERDR_BAD_REQUEST")?"电脑端尚不支持删除会话，请更新电脑端。":"删除结果尚未确认，正在刷新列表；不会自动重复删除。";
            notice.setText(text);Toast.makeText(this,text,Toast.LENGTH_LONG).show();update();schedule(1000);return;
        }
        if(activeOp.equals("create")&&code.matches("HERDR_(CREATE_UNCERTAIN|PROJECT_NOT_FOUND|PROJECT_UNAVAILABLE|AGENT_UNAVAILABLE|COMMAND_FAILED|BAD_REQUEST|CONFLICT|FINISHED)")){
            clearCreate();connected=true;needList=true;
            if(createDialog!=null){renderCreate();creationNotice.setText(message(code));creationNotice.setTextColor(colors.primary);}
            notice.setText(message(code));update();schedule(1000);return;
        }
        if(code.equals("HERDR_RESYNC")||code.equals("HERDR_NOT_FOUND")||code.equals("HERDR_STALE")){
            if(watch!=null&&watch.pending==null&& !code.equals("HERDR_STALE")){watch=new HerdrProtocol.Watch(instance,core,watch.terminal);notice.setText("正在重新同步终端画面…");}
            else {watch=null;imagePhase="";imageBusy=false;sentText="";needList=true;notice.setText("会话连接已变化，未重发输入；请重新选择并检查输出。");showList();}
            detach=null;
        }else if(code.matches("HERDR_(UNPAIRED|UNSUPPORTED|USER_REQUIRED|NOT_RUNNING|UPDATE_REQUIRED|INVALID_RESPONSE|BAD_REQUEST|SEQUENCE|CONFLICT)")){
            halted=true;notice.setText(message(code));
        }else notice.setText(pendingCreate!=null?"连接中断，正在核对创建结果…":watch!=null&&watch.pending!=null?"连接中断，正在确认上一条输入…":"连接暂时中断，正在重连…");
        if(pendingCreate!=null&&creationNotice!=null)creationNotice.setText(halted?message(code):"正在重新连接并核对结果，不重复启动。");
        update();schedule(Math.min(10000,failures*1000L));
    }
    private static String message(String code){switch(code){
        case "HERDR_UNPAIRED":return "电脑已撤销配对，请重新连接授权。";
        case "HERDR_UNSUPPORTED":return "电脑 ClipRelay 尚不支持 Herdr，请更新电脑端。";
        case "HERDR_USER_REQUIRED":return "请在电脑普通用户桌面启动 Herdr，不要以管理员身份运行。";
        case "HERDR_NOT_RUNNING":return "电脑的 Herdr 尚未运行，请先打开 Herdr，再点刷新。";
        case "HERDR_UPDATE_REQUIRED":return "请更新电脑的 herdr-core，以支持同步终端画面。";
        case "HERDR_OUTCOME_UNKNOWN":return "这条输入的执行结果不确定。";
        case "HERDR_FINISHED":return "这个终端已结束。";
        case "HERDR_PROJECT_NOT_FOUND":return "电脑上的项目已变化，请重新选择。";
        case "HERDR_PROJECT_UNAVAILABLE":return "电脑上的项目目录不存在，请检查目录。";
        case "HERDR_AGENT_UNAVAILABLE":return "电脑上未找到该 Agent，请先安装或检查 Herdr 启动配置。";
        case "HERDR_AGENT_CONFIG":return "Herdr 的启动配置无法读取，请检查 programs.json。";
        case "HERDR_AGENT_DISCOVERY":return "电脑 CLI 扫描未完成，请稍后刷新。";
        case "HERDR_CREATE_UNCERTAIN":return "创建结果不确定，未重复启动。请先检查会话列表，确认不存在后再新建。";
        case "HERDR_COMMAND_FAILED":return "电脑未能启动该会话，请检查 Agent 配置后重试。";
        default:return "连接状态无法确认，请刷新后重试。";
    }}
}
