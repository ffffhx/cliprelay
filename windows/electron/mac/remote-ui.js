import {icon,esc} from '../renderer/icons.js';
import {mountFiles} from './file-ui.js';
import {mountBitrate} from './bitrate-ui.js';
import {mountDisplays} from './display-ui.js';
import {mountInput} from './input-ui.js';
import {mountPrivacy} from './privacy-ui.js';
import {mountAudioMute} from './audio-mute-ui.js';
import {mountSessionLock} from './session-lock-ui.js';
import {mountWake} from './wake-ui.js';

// Shared connection surface for Windows and macOS. Controllers retain their
// lifecycle, transport validation and session tools; this view owns navigation.
export async function mount(root,api,close,initial){
  document.querySelector('link[rel=stylesheet]').href='./remote-ui.css';
  const theme=localStorage.getItem('cliprelay-appearance')||'light';document.body.classList.toggle('dark',theme==='dark'||theme==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);
  root.className='remote-app';
  root.innerHTML=`<header class="page-head"><div><h1>远程控制</h1><p>选择电脑，连接后开始操作。</p></div><button data-action="add">${icon('plus')} 连接电脑</button></header><div class="host-list" aria-label="已保存的电脑"></div><p class="notice" role="status" aria-live="polite"></p><section class="session-panel"><div class="session-heading"><div><h2 id="session-name">选择一台电脑</h2><p id="session-state"></p></div><span>${icon('remote')}</span></div><div class="session-actions"><select id="quality" aria-label="画面质量"><option value="1080">清晰 · 1080p / 60 帧</option><option value="720">流畅 · 720p / 30 帧</option><option value="2160">超清 · 4K / 60 帧</option></select><button class="primary" data-action="open">连接电脑</button><button data-action="stop">结束远控</button></div></section><details id="connect"><summary>添加电脑</summary><form class="connect-form"><label>电脑地址<input name="address" placeholder="IP 或主机名" autocomplete="off" maxlength="253" required></label><label>设备名称（可选）<input name="label" placeholder="例如：我的电脑" maxlength="128"></label><details><summary>连接参数</summary><label>远控端口<input name="port" value="48789" inputmode="numeric" required></label></details><div class="actions"><button type="button" data-action="cancel-connect">取消连接</button><button class="primary" type="submit">连接电脑</button></div></form></details><details id="network"><summary>通过连接码添加电脑</summary><form class="connect-form"><label>连接码<input name="code" placeholder="8 位数字" inputmode="numeric" pattern="[0-9]{8}" maxlength="8" required></label><div class="actions"><button class="primary">连接电脑</button></div></form><div id="network-list"></div></details><div id="session-tools" hidden><details id="files"><summary>文件传输</summary><div></div></details><details id="display"><summary>画面与输入</summary><div></div></details><details id="tools"><summary>更多工具</summary><div></div></details></div><div class="actions"><button data-action="close">关闭</button></div>`;
  let state=initial,busy=false,closed=false,polling=false,roster='',feedback='',launchNonce='',autoOpen=false;
  const node=s=>root.querySelector(s),current=()=>state.hosts.find(h=>h.selected);
  const controllers=[];
  const request=async(action,data)=>{state=await api.request(action,data);render();return state;};
  controllers.push(mountFiles(node('#files>div'),request));
  for(const fn of [mountBitrate,mountDisplays,mountInput])controllers.push(fn(node('#display>div'),request));
  for(const fn of [mountPrivacy,mountAudioMute,mountSessionLock,mountWake])controllers.push(fn(node('#tools>div'),request));
  const terminal=document.createElement('button');terminal.textContent='打开终端';terminal.dataset.action='terminal';node('#tools>div').append(terminal);
  const preset=()=>node('#quality').value==='720'?{width:1280,height:720,fps:30,bitrate:6000}:node('#quality').value==='2160'?{width:3840,height:2160,fps:60,bitrate:35000}:{width:1920,height:1080,fps:60,bitrate:12000};
  const connecting=()=>['preparing','waiting'].includes(state.pairing?.state)||['preparing','approval','connecting','waiting'].includes(state.network?.pairing?.state);
  const active=()=>['starting','running','recovering','closing'].includes(state.viewer?.phase);
  async function run(operation){if(busy)return;busy=true;feedback='';render();try{await operation();}catch(e){feedback=e.message;autoOpen=false;}finally{busy=false;render();}}
  async function choose(host,open=true){
    if(!host.enabled)state=await api.request('paired-enable',{id:host.id,enabled:true});
    state=await api.request('paired-select',{id:host.id});
    if(open)state=await api.request('viewer-open',preset());
  }
  async function connect(target){
    const existing=state.hosts.find(h=>h.address===target.address&&h.port===Number(target.port));
    if(existing){await choose(existing);return;}
    state=await api.request('pair-start',target);autoOpen=true;
  }
  function render(){
    const host=current(),phase=state.viewer?.phase||'idle';
    const key=JSON.stringify(state.hosts);if(key!==roster){roster=key;node('.host-list').innerHTML=state.hosts.length?state.hosts.map(h=>`<article class="host-row ${h.selected?'active':''}"><div class="device-art">${icon('monitor')}</div><div><strong>${esc(h.name)}</strong><small>${h.selected&&phase==='running'?'已连接':h.routeReady===false?'等待上线':'已保存'}</small></div><button data-action="choose" data-id="${esc(h.id)}">连接</button><button data-action="remove" data-id="${esc(h.id)}" aria-label="移除 ${esc(h.name)}">×</button></article>`).join(''):'<div class="empty-state">'+icon('monitor')+'<h2>连接你的电脑</h2><p>输入电脑地址，或使用连接码。</p></div>';}
    node('#session-name').textContent=host?.name||'选择一台电脑';
    node('#session-state').textContent=state.viewer?.available===false?'远程控制组件尚未安装':({idle:'准备就绪',starting:'正在连接…',running:'已连接',recovering:'连接中断，正在重连…',closing:'正在结束…',error:'连接未完成，请重试'})[phase]||'';
    node('[data-action=open]').disabled=busy||!host||host.routeReady===false||active()||!state.viewer?.available;
    node('[data-action=stop]').disabled=busy||!active()||phase==='closing';node('#quality').disabled=active();
    node('[data-action=cancel-connect]').disabled=busy||!connecting();
    node('#session-tools').hidden=!host;
    for(const c of controllers)c.render(state);
    terminal.disabled=busy||!host?.enabled||host.routeReady===false;
    const pairingError=state.pairing?.state==='error'?state.pairing.message:state.network?.pairing?.state==='error'?'连接码未能完成连接，请重试':'';
    node('.notice').textContent=feedback||pairingError||(connecting()?'正在连接电脑…':'');node('.notice').classList.toggle('error',!!(feedback||pairingError));
    for(const b of root.querySelectorAll('[data-action=choose],[data-action=remove],form button[type=submit]'))b.disabled=busy||connecting();
    node('#network').hidden=state.network?.available===false;
    node('#network-list').innerHTML=(state.network?.computers||[]).map(h=>`<div class="host-row"><div><strong>${esc(h.name)}</strong><small>${esc(h.phase==='ready'?'连接可用':'等待连接')}</small></div>${h.paired?'':`<button data-action="network-connect" data-id="${esc(h.id)}">连接</button>`}</div>`).join('');
  }
  const actions={add:()=>{node('#connect').open=true;node('[name=address]').focus();},close,
    open:()=>request('viewer-open',preset()),stop:()=>request('viewer-stop'),terminal:()=>request('terminal-open'),
    choose:el=>choose(state.hosts.find(h=>h.id===el.dataset.id)),remove:el=>request('paired-remove',{id:el.dataset.id}),
    'network-connect':async el=>{state=await api.request('network-pair',{id:el.dataset.id});autoOpen=true;},
    'cancel-connect':async()=>{autoOpen=false;state=await api.request('pair-cancel');state=await api.request('network-cancel');}
  };
  root.addEventListener('click',event=>{const el=event.target.closest('[data-action]');if(el&&!el.disabled&&actions[el.dataset.action])void run(()=>actions[el.dataset.action](el));});
  node('#connect form').onsubmit=event=>{event.preventDefault();const form=new FormData(event.target);void run(()=>connect({address:form.get('address').trim(),port:Number(form.get('port')),label:form.get('label').trim()}));};
  node('#network form').onsubmit=event=>{event.preventDefault();void run(async()=>{state=await api.request('network-claim',{code:new FormData(event.target).get('code')});autoOpen=true;});};
  async function applyLaunch(){const target=state.launchTarget;if(!target||target.nonce===launchNonce||busy)return;launchNonce=target.nonce;await run(()=>connect(target));}
  const timer=setInterval(async()=>{
    if(closed||polling||busy)return;polling=true;
    try{state=await api.request('paired-status');render();await applyLaunch();
      if(autoOpen&&!connecting()){
        autoOpen=false;
        if(state.pairing?.state==='paired'||state.network?.pairing?.state==='paired')await run(()=>request('viewer-open',preset()));
      }
    }catch(e){feedback=e.message;render();}finally{polling=false;}
  },750);
  window.addEventListener('beforeunload',()=>{closed=true;clearInterval(timer);},{once:true});render();await applyLaunch();
}
