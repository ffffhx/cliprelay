const api=window.cliprelayTerminal,$=id=>document.getElementById(id),host=$('host'),sessions=$('sessions'),status=$('status'),notice=$('notice');
const term=new window.Terminal({cols:100,rows:30,fontSize:14,fontFamily:'Consolas, Menlo, monospace',scrollback:3000,cursorBlink:true,disableStdin:true,screenReaderMode:true,theme:{background:'#141820',foreground:'#edf0f5'},linkHandler:{activate:()=>{}},windowOptions:{}});
const fit=new window.FitAddon.FitAddon();term.loadAddon(fit);term.open($('terminal'));
// Remote escape sequences cannot read/write the local clipboard or open URLs.
term.parser.registerOscHandler(52,()=>true);
let state,closed=false,polling=false,renderingReplay=false,parsing=false,screen='',catalog='',shellCatalog='',feedback='',timer,resizeTimer,endTarget,pasteTarget,pasteOpening=false,pasteSending=false,geometryPending=false;
const running=()=>state?.sessions.find(session=>session.id===state.selected)?.state==='running';
const mouseUI=new window.ClipRelayTerminalMouse({window,document,element:$('terminal'),term,
  getState:()=>{const mouse=state?.sessions.find(s=>s.id===state.selected)?.mouse;return {view:state?.view,id:state?.selected,epoch:mouse?.epoch,mode:mouse?.mode || 0,format:mouse?.format || 0,...state?.mouse,parsing,blocked:state?.phase!=='ready' || renderingReplay || !!pasteTarget || pasteOpening || geometryPending};},
  send:async data=>{const result=await action('mouse',data);clearTimeout(timer);if(!closed)void poll();return result;},
  changed:()=>{$('selection-mode').textContent=mouseUI.selectionMode?'操作程序':'选择文字';$('selection-mode').setAttribute('aria-pressed',String(mouseUI.selectionMode));$('mouse-status').textContent=mouseUI.description();},
  problem:text=>{feedback=feedback || text;render(state);}});
function render(next){
  if(!next)return;state=next;host.textContent=(state.hostName || '远程电脑')+' · 终端';
  const supported=state.shells || [],shellKey=JSON.stringify(supported);
  if(shellKey!==shellCatalog){shellCatalog=shellKey;const picker=$('shell'),selected=picker.value;picker.replaceChildren();for(const shell of supported){const option=document.createElement('option');option.value=shell;option.textContent=({powershell:'PowerShell',cmd:'CMD',zsh:'Zsh',bash:'Bash'})[shell];picker.append(option);}picker.value=supported.includes(selected)?selected:(supported[0] || '');}
  $('shell').disabled=state.phase!=='ready' || state.uncertain || parsing || !supported.length;
  if(pasteTarget && (state.phase!=='ready' || !running() || state.view!==pasteTarget.view || state.selected!==pasteTarget.id))dismissPaste();
  if(screen!==state.screen){screen=state.screen;term.reset();clearTimeout(resizeTimer);resizeTimer=setTimeout(size,150);}
  const labels={idle:'未连接',connecting:'正在连接',ready:running()?'终端已连接':'请选择或新建会话',paused:'连接已暂停',recovering:'正在恢复连接',error:'连接需要处理'};
  status.textContent=feedback || state.error || labels[state.phase] || state.phase;notice.textContent=state.notice || '关闭窗口后会话继续运行；30 分钟未访问时自动结束。终端以电脑当前登录用户的普通权限运行。';
  const key=JSON.stringify(state.sessions.map(s=>[s.id,s.shell,s.state,s.openSequence]));if(key!==catalog){catalog=key;sessions.replaceChildren();const empty=document.createElement('option');empty.textContent='选择会话';empty.value='';sessions.append(empty);for(const s of state.sessions){const option=document.createElement('option');option.value=s.id;option.textContent=s.shell+' '+s.openSequence+' · '+(s.state==='running'?'运行中':'已结束');sessions.append(option);}}sessions.value=state.selected;
  const reviewing=!!pasteTarget || pasteOpening;$('terminal').inert=reviewing;
  // xterm's disableStdin also suppresses parser-generated replies. Keep the
  // terminal inert to human input, but allow replies while parsing live output.
  term.options.disableStdin=state.phase!=='ready' || !running() || renderingReplay || reviewing && !parsing;
  $('paste-confirm').disabled=parsing || renderingReplay || pasteSending || !pasteTarget;
  $('paste-text').disabled=pasteSending;
  $('paste-cancel').disabled=pasteSending;
  $('new').disabled=state.phase!=='ready' || state.uncertain || parsing || !supported.length;$('refresh').disabled=['connecting','recovering'].includes(state.phase);$('end').disabled=state.phase!=='ready' || !running() || parsing;$('paste').disabled=term.options.disableStdin;
  $('pause').disabled=['paused','idle'].includes(state.phase);$('resume').disabled=!['paused','error','recovering'].includes(state.phase);sessions.disabled=state.phase!=='ready' || state.uncertain || parsing;
  $('input-status').textContent=state.uncertain?'输入结果待确认':state.queuedBytes?'待发送 '+state.queuedBytes+' 字节':state.accepted>state.written?'电脑已接收，等待写入终端':'输入已确认';
  if(state.mouse?.busy)$('input-status').textContent+=' · 鼠标操作中';
  mouseUI.sync();
}
async function action(name,data){const view=state?.view;try{if(name!=='parsed' && (name!=='mouse' || data?.action==='press'))feedback='';const next=await api.request(name,data);if(next?.phase && (state?.view===view || next.view===state?.view))render(next);return next;}catch(error){if(state?.view===view){feedback=error.message;render(state);}return null;}}
function send(value,binary=false){if(!state || state.phase!=='ready' || !running() || renderingReplay || (pasteTarget || pasteOpening) && !parsing)return;const data={view:state.view,id:state.selected};if(binary){data.binary=true;data.data=btoa(value);}else data.text=value;void action('input',data);}
term.onData(text=>send(text));term.onBinary(data=>send(data,true));
term.onSelectionChange(()=>{$('copy').disabled=!term.hasSelection();});
async function copy(){if(term.hasSelection())await action('copy',{text:term.getSelection()});}
function dismissPaste(){const target=pasteTarget;pasteTarget=null;$('paste-dialog').close();$('paste-text').value='';if(target)void action('paste-cancel',{token:target.token});}
async function paste(text){
  if(term.options.disableStdin || parsing || pasteOpening || pasteTarget)return;
  const view=state.view,id=state.selected;pasteOpening=true;render(state);
  try{
    const result=await action(typeof text==='string'?'paste-preview':'paste',{view,id,...(typeof text==='string'?{text}:{})});
    if(!result?.token)return;
    if(state.phase!=='ready' || !running() || state.view!==view || state.selected!==id){void action('paste-cancel',{token:result.token});return;}
    pasteTarget=result;$('paste-text').value=result.text;$('paste-note').textContent=result.changed?'换行已统一，控制字符已移除。请检查内容后再发送。':'请检查内容；多行文本可能执行多条命令。';
    $('paste-dialog').showModal();$('paste-text').focus();
  }finally{pasteOpening=false;render(state);}
}
async function confirmPaste(){
  if(!pasteTarget || parsing || renderingReplay || pasteSending)return;
  const target=pasteTarget;pasteSending=true;render(state);
  try{
    const result=await action('paste-submit',{token:target.token,view:target.view,id:target.id,text:$('paste-text').value,bracketed:term.modes.bracketedPasteMode});
    if(pasteTarget!==target)return;
    if(result?.review){$('paste-text').value=result.text;$('paste-note').textContent='编辑后的控制字符已移除，请再次检查并确认。';}
    else if(result?.sent){dismissPaste();render(result.state);term.focus();}
    else $('paste-note').textContent=feedback || '未发送，请检查内容后重试。';
  }finally{pasteSending=false;render(state);}
}
// Capture before xterm's textarea handler, including native context-menu paste.
$('terminal').addEventListener('paste',event=>{event.preventDefault();event.stopImmediatePropagation();void paste(event.clipboardData?.getData('text/plain') || '');},true);
$('terminal').addEventListener('drop',event=>{event.preventDefault();event.stopImmediatePropagation();},true);
term.attachCustomKeyEventHandler(event=>{
  if(pasteTarget || pasteOpening)return false;
  const key=event.key.toLowerCase(),isPaste=(event.ctrlKey || event.metaKey) && key==='v' || event.shiftKey && key==='insert',isCopy=(event.ctrlKey && event.shiftKey || event.metaKey) && key==='c';
  if(isPaste || isCopy){if(event.type==='keydown'){event.preventDefault();isCopy?void copy():void paste();}return false;}return true;
});
$('paste-cancel').onclick=()=>{if(pasteSending)return;dismissPaste();render(state);term.focus();};$('paste-dialog').addEventListener('cancel',event=>{event.preventDefault();if(pasteSending)return;dismissPaste();render(state);});$('paste-confirm').onclick=confirmPaste;
$('copy').onclick=copy;$('paste').onclick=paste;
$('selection-mode').onclick=()=>{mouseUI.toggle();term.focus();};
$('new').onclick=()=>{if(!parsing)void action('open',{shell:$('shell').value});};$('refresh').onclick=()=>action('refresh');$('pause').onclick=()=>action('pause');$('resume').onclick=()=>action('resume');
sessions.onchange=()=>{if(sessions.value && !parsing)void action('select',{id:sessions.value});};
$('end').onclick=()=>{if(parsing)return;endTarget={view:state.view,id:state.selected};$('end-dialog').showModal();};$('end-cancel').onclick=()=>$('end-dialog').close();$('end-confirm').onclick=()=>{const data=endTarget;$('end-dialog').close();void action('end',data);};
async function size(){if(closed || !state)return;fit.fit();const columns=Math.max(20,Math.min(240,term.cols)),rows=Math.max(5,Math.min(120,term.rows));if(term.cols!==columns || term.rows!==rows)term.resize(columns,rows);if(state.phase==='ready' && running())await action('resize',{view:state.view,id:state.selected,columns,rows});geometryPending=false;render(state);}
new ResizeObserver(()=>{geometryPending=true;mouseUI.cancel(true,state?.mouse?.supported && state?.phase==='ready' && running());clearTimeout(resizeTimer);resizeTimer=setTimeout(size,150);}).observe($('terminal'));
async function poll(){
  if(closed || polling)return;polling=true;
  try{
    const before=state?.view,result=await api.request('poll');if(state?.view!==before && result.state.view!==state?.view)return;render(result.state);if(result.frame && result.frame.view===state.view){
      const frame=result.frame;if(frame.gap)term.reset();if(term.cols!==frame.columns || term.rows!==frame.rows)term.resize(frame.columns,frame.rows);
      parsing=true;renderingReplay=frame.replay;render(state);
      const id=state.selected,bytes=Uint8Array.from(atob(frame.data),value=>value.charCodeAt(0));await new Promise(resolve=>term.write(bytes,resolve));renderingReplay=false;parsing=false;if(frame.token)await action('parsed',{view:frame.view,id,token:frame.token});render(state);
    }
  }catch(error){feedback=error.message;render(state);}finally{polling=false;if(!closed)timer=setTimeout(poll,state?.mouse?.busy || mouseUI.held?16:75);}
}
window.addEventListener('beforeunload',()=>{closed=true;clearTimeout(timer);clearTimeout(resizeTimer);mouseUI.dispose();term.dispose();},{once:true});
render(await api.request('initial'));size();void poll();
