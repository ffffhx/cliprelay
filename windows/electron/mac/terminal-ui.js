const api=window.cliprelayTerminal,$=id=>document.getElementById(id),host=$('host'),sessions=$('sessions'),status=$('status'),notice=$('notice');
const term=new window.Terminal({cols:100,rows:30,fontSize:14,fontFamily:'Consolas, Menlo, monospace',scrollback:3000,cursorBlink:true,disableStdin:true,screenReaderMode:true,theme:{background:'#141820',foreground:'#edf0f5'},linkHandler:{activate:()=>{}},windowOptions:{}});
const fit=new window.FitAddon.FitAddon();term.loadAddon(fit);term.open($('terminal'));
// Remote escape sequences cannot read/write the local clipboard or open URLs.
term.parser.registerOscHandler(52,()=>true);
let state,closed=false,polling=false,renderingReplay=false,parsing=false,screen='',catalog='',feedback='',timer,resizeTimer,endTarget;
const running=()=>state?.sessions.find(session=>session.id===state.selected)?.state==='running';
function render(next){
  if(!next)return;state=next;host.textContent=(state.hostName || '远程电脑')+' · 终端';
  if(screen!==state.screen){screen=state.screen;term.reset();clearTimeout(resizeTimer);resizeTimer=setTimeout(size,150);}
  const labels={idle:'未连接',connecting:'正在连接',ready:running()?'终端已连接':'请选择或新建会话',paused:'连接已暂停',recovering:'正在恢复连接',error:'连接需要处理'};
  status.textContent=feedback || state.error || labels[state.phase] || state.phase;notice.textContent=state.notice || '关闭窗口后会话继续运行；30 分钟未访问时自动结束。终端以电脑当前登录用户的普通权限运行。';
  const key=JSON.stringify(state.sessions.map(s=>[s.id,s.shell,s.state,s.openSequence]));if(key!==catalog){catalog=key;sessions.replaceChildren();const empty=document.createElement('option');empty.textContent='选择会话';empty.value='';sessions.append(empty);for(const s of state.sessions){const option=document.createElement('option');option.value=s.id;option.textContent=s.shell+' '+s.openSequence+' · '+(s.state==='running'?'运行中':'已结束');sessions.append(option);}}sessions.value=state.selected;
  term.options.disableStdin=state.phase!=='ready' || !running() || renderingReplay;
  $('new').disabled=state.phase!=='ready' || state.uncertain || parsing;$('refresh').disabled=['connecting','recovering'].includes(state.phase);$('end').disabled=state.phase!=='ready' || !running() || parsing;$('paste').disabled=term.options.disableStdin;
  $('pause').disabled=['paused','idle'].includes(state.phase);$('resume').disabled=!['paused','error','recovering'].includes(state.phase);sessions.disabled=state.phase!=='ready' || state.uncertain || parsing;
  $('input-status').textContent=state.uncertain?'输入结果待确认':state.queuedBytes?'待发送 '+state.queuedBytes+' 字节':state.accepted>state.written?'电脑已接收，等待写入终端':'输入已确认';
}
async function action(name,data){const view=state?.view;try{feedback='';const next=await api.request(name,data);if(next?.phase && (state?.view===view || next.view===state?.view))render(next);return next;}catch(error){if(state?.view===view){feedback=error.message;render(state);}return null;}}
function send(value,binary=false){if(!state || state.phase!=='ready' || !running() || renderingReplay)return;const data={view:state.view,id:state.selected};if(binary){data.binary=true;data.data=btoa(value);}else data.text=value;void action('input',data);}
term.onData(text=>send(text));term.onBinary(data=>send(data,true));
term.onSelectionChange(()=>{$('copy').disabled=!term.hasSelection();});
async function copy(){if(term.hasSelection())await action('copy',{text:term.getSelection()});}
async function paste(){if(term.options.disableStdin)return;const view=state.view,id=state.selected,result=await action('paste');if(result?.text && state.phase==='ready' && state.view===view && state.selected===id)term.paste(result.text);term.focus();}
term.attachCustomKeyEventHandler(event=>{const command=event.ctrlKey && event.shiftKey || event.metaKey;if(command && ['c','v'].includes(event.key.toLowerCase())){if(event.type==='keydown'){event.preventDefault();event.key.toLowerCase()==='c'?void copy():void paste();}return false;}return true;});
$('copy').onclick=copy;$('paste').onclick=paste;
$('new').onclick=()=>{if(!parsing)void action('open',{shell:$('shell').value});};$('refresh').onclick=()=>action('refresh');$('pause').onclick=()=>action('pause');$('resume').onclick=()=>action('resume');
sessions.onchange=()=>{if(sessions.value && !parsing)void action('select',{id:sessions.value});};
$('end').onclick=()=>{if(parsing)return;endTarget={view:state.view,id:state.selected};$('end-dialog').showModal();};$('end-cancel').onclick=()=>$('end-dialog').close();$('end-confirm').onclick=()=>{const data=endTarget;$('end-dialog').close();void action('end',data);};
function size(){if(closed || !state)return;fit.fit();const columns=Math.max(20,Math.min(240,term.cols)),rows=Math.max(5,Math.min(120,term.rows));if(term.cols!==columns || term.rows!==rows)term.resize(columns,rows);if(state.phase==='ready' && running())void action('resize',{view:state.view,id:state.selected,columns,rows});}
new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(size,150);}).observe($('terminal'));
async function poll(){
  if(closed || polling)return;polling=true;
  try{
    const before=state?.view,result=await api.request('poll');if(state?.view!==before && result.state.view!==state?.view)return;render(result.state);if(result.frame && result.frame.view===state.view){
      const frame=result.frame;if(frame.gap)term.reset();if(term.cols!==frame.columns || term.rows!==frame.rows)term.resize(frame.columns,frame.rows);
      parsing=true;renderingReplay=frame.replay;render(state);
      const bytes=Uint8Array.from(atob(frame.data),value=>value.charCodeAt(0));await new Promise(resolve=>term.write(bytes,resolve));renderingReplay=false;parsing=false;render(state);
    }
  }catch(error){feedback=error.message;render(state);}finally{polling=false;if(!closed)timer=setTimeout(poll,75);}
}
window.addEventListener('beforeunload',()=>{closed=true;clearTimeout(timer);clearTimeout(resizeTimer);term.dispose();},{once:true});
render(await api.request('initial'));size();void poll();
