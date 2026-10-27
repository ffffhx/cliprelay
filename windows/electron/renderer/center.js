import {icon,esc} from './icons.js';

const button=(label,action,kind='',glyph='',extra='')=>`<button class="btn ${kind}" data-action="${action}" ${extra}>${glyph?icon(glyph):''}${label}</button>`;
const toggle=(label,key,value)=>`<button class="switch" role="switch" aria-label="${label}" aria-checked="${!!value}" data-setting="${key}"></button>`;
const platforms={windows:'Windows',macos:'macOS',mac:'macOS',darwin:'macOS',linux:'Linux',android:'Android',ios:'iOS'};
const platform=peer=>platforms[String(peer.platform).toLowerCase()] || '设备';
const glyph=peer=>platform(peer)==='Android'||platform(peer)==='iOS'?'phone':platform(peer)==='macOS'?'laptop':'monitor';
const time=value=>value?new Date(typeof value==='string'&&value.startsWith('/Date(')?Number(value.match(/\d+/)?.[0]):value).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'';
const list=value=>Array.isArray(value)?value:value?[value]:[];
const signature=value=>JSON.stringify(value);
// Sending selection does not change a device's connectivity or invalidate probes.
const probeRoster=value=>signature(value.map(({enabled,...peer})=>peer));
const row=(title,detail,control)=>`<div class="setting-row"><div><strong>${title}</strong><p>${detail}</p></div>${control}</div>`;

export async function mount(root,api,view='control-center'){
  let snapshot,closed=false,polling=false,shown=false,saveQueue=Promise.resolve(),saving=0,saveError='',connectionError='',page=['remote-home','remote-desktop','remote-network'].includes(view)?'remote':'devices',settingsTab='general';
  let probe=null,generation=0,roster='',pageSignature='',scanCommit=false,toastTimer,dialogReturnFocus;
  let remoteProbe=null,remoteGeneration=0,remoteRoster='',remoteSession={phase:'idle',peerId:'',error:''};
  let directory={devices:[],error:''},activeComputer=null;
  let remoteHost=null,remoteHostError='',remoteHostBusy=false,remoteHostReading=false,remoteHostGeneration=0;
  let theme=localStorage.getItem('cliprelay-appearance')||'light';
  const media=matchMedia('(prefers-color-scheme: dark)');
  const applyTheme=()=>document.body.classList.toggle('dark',theme==='dark'||theme==='system'&&media.matches);
  media.addEventListener('change',applyTheme);applyTheme();
  root.innerHTML=`<section class="app" aria-label="ClipRelay"><aside class="sidebar"><div class="brand"><img src="./logo.png" alt=""><span>ClipRelay</span></div><nav aria-label="应用导航">${[['devices','clipboard','剪切板'],['remote','remote','远程控制']].map(([id,g,label])=>`<button class="nav-item" data-page="${id}">${icon(g)}<span>${label}</span></button>`).join('')}</nav><div class="sidebar-bottom"><button class="nav-item" data-page="settings">${icon('settings')}<span>设置</span></button><div class="local-device">${icon('monitor')}<div><div class="name" id="local-name">这台电脑</div><div class="muted" id="local-state">正在连接后台…</div></div></div></div></aside><div class="workspace"><div class="window-bar"><span class="small" id="window-label">剪切板</span><div class="window-actions">${[['minus','minimize','最小化'],['square','maximize','最大化或还原'],['close','close','关闭窗口']].map(([g,a,l])=>`<button data-action="${a}" aria-label="${l}">${icon(g)}</button>`).join('')}</div></div><div class="content" id="page"><div class="empty-state">正在加载设备…</div></div></div></section><dialog class="modal" id="dialog"></dialog><div class="toast" role="status" aria-live="polite"></div>`;
  const content=root.querySelector('#page'),dialog=root.querySelector('#dialog');
  const peers=()=>snapshot?.config.peers||[];
  const targets=()=>peers().filter(p=>p.enabled);
  const computers=()=>{
    const saved=peers().filter(p=>!['Android','iOS'].includes(platform(p)));
    const found=directory.devices||[];
    const all=[...saved.map(p=>{const entry=found.find(d=>d.deviceId===p.id);return entry?{...p,directoryId:entry.id,connectable:entry.connectable}:p;}),
      ...found.filter(d=>!saved.some(p=>p.id===d.deviceId)).map(d=>({...d,id:'directory:'+d.id,directoryId:d.id}))];
    if(activeComputer&&remoteActive()&&!all.some(p=>p.id===activeComputer.id))all.push(activeComputer);
    return all;
  };
  const remoteTarget=p=>({id:p.id,name:p.name,...(p.directoryId?{directoryId:p.directoryId}:{address:p.address,port:Number(p.remotePort||48789)})});
  function toast(message){clearTimeout(toastTimer);root.querySelector('.toast').textContent=message;toastTimer=setTimeout(()=>root.querySelector('.toast').textContent='',4000);}
  function closeDialog(){dialog.close();}
  dialog.addEventListener('close',()=>{if(dialog.open)return;dialog.replaceChildren();dialogReturnFocus?.focus();dialogReturnFocus=null;});
  function modal(title,body,footer=''){
    dialog.scanMarker=null;
    if(!dialog.open)dialogReturnFocus=document.activeElement;
    dialog.innerHTML=`<div class="modal-head"><h2 id="modal-title">${esc(title)}</h2><button class="icon-button" data-action="dismiss" aria-label="关闭弹窗">${icon('close')}</button></div>${body}<p class="modal-error" role="alert"></p>${footer?`<div class="modal-footer">${footer}</div>`:''}`;
    dialog.setAttribute('aria-labelledby','modal-title');if(!dialog.open)dialog.showModal();
  }
  function error(error){const message=error?.message||String(error);if(dialog.open)dialog.querySelector('.modal-error').textContent=message;else toast(message);}
  function cancelProbe(){generation++;probe=null;}
  function patch(data){
    saving++;paint();
    const task=saveQueue.catch(()=>{}).then(async()=>{
      const payload=typeof data==='function'?await data(await api.request('snapshot')):data;
      const next=await api.request('patch',payload);accept(next);saveError='';return next;
    }).catch(e=>{saveError=e.message;throw e;}).finally(()=>{saving--;paint();});
    saveQueue=task;return task;
  }
  function accept(next){
    // Revisions restart at zero with the native process after discovery/port edits.
    if(snapshot && next.instanceId===snapshot.instanceId && next.revision<snapshot.revision)return;
    const nextRoster=probeRoster(next.config.peers);
    if(roster&&roster!==nextRoster&&!scanCommit)cancelProbe();
    roster=nextRoster;snapshot=next;
    const nextRemoteRoster=signature(computers().map(remoteTarget));
    if(nextRemoteRoster!==remoteRoster){remoteGeneration++;remoteProbe=null;remoteRoster=nextRemoteRoster;}
  }
  const heading=(title,subtitle,action='')=>`<header class="page-head"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</header>`;
  function peerResult(peer){return probe?.phase==='done'?probe.results.find(r=>r.id===peer.id):null;}
  function peerState(peer){const result=peerResult(peer);return result?result.ok?'可发送':'接收未响应':probe?.error?'检测未完成':probe&&probe.ids.includes(peer.id)?probe.phase==='discover'?'更新地址中':'检测中':'待检测';}
  function peerMeta(peer){const result=peerResult(peer);return `<div class="device-meta"><span>${platform(peer)}</span><span class="${result?result.ok?'passed':'failed':'muted'}">${result?.ok?'<span class="status-dot"></span>':''}${peerState(peer)}</span></div>`;}
  function sendingToggle(peer){return `<div class="sending-choice"><span>发送剪切板</span><button class="switch" role="switch" aria-label="向 ${esc(peer.name)} 发送剪切板" aria-checked="${!!peer.enabled}" data-action="toggle-target" data-id="${esc(peer.id)}" ${saving?'disabled':''}></button></div>`;}
  function peerRow(peer){
    return `<article class="clipboard-device-row" data-device-id="${esc(peer.id)}"><div class="device-art">${icon(glyph(peer))}</div><div class="row-detail"><h3>${esc(peer.name)}</h3>${peerMeta(peer)}</div>${sendingToggle(peer)}<button class="icon-button" data-action="detail" data-id="${esc(peer.id)}" aria-label="${esc(peer.name)} 的设备详情">${icon('more')}</button></article>`;
  }
  function probeSummary(){
    if(!probe)return '';
    const busy=probe.phase!=='done',passed=probe.results.filter(r=>r.ok).length;
    const title=probe.phase==='discover'?'正在更新设备地址':probe.phase==='probe'?'正在检测接收端响应':probe.error?'检测未完成':`${passed}/${probe.ids.length} 台设备接收可用`;
    return `<section class="probe-summary" aria-label="全链路检测结果"><div role="status" aria-live="polite">${icon(busy?'clock':passed===probe.ids.length?'checkCircle':'help')}<span><strong>${title}</strong><span class="probe-description">${esc(probe.detail||'检测不会修改对方剪贴板')}</span></span></div>${busy?'':`<div class="probe-actions">${button('查看详情','probe-detail','text')}${button('重新检测','probe','soft')}</div>`}</section>`;
  }
  function deviceList(){
    if(!peers().length)return `<div class="empty-state">${icon('devices')}<h2>添加你的第一台设备</h2><p>打开另一台设备上的 ClipRelay，即可在附近找到它。</p>${button('添加设备','add','primary','plus')}</div>`;
    return `<div class="clipboard-device-list">${peers().map(peerRow).join('')}</div>`;
  }
  function shortcutRows(){return `<div class="shortcut-row"><span>${icon('text')}发送文本</span><span class="key-combo"><kbd>Ctrl</kbd> + <kbd>C</kbd></span></div><div class="shortcut-row"><span>${icon('screenshot')}发送截图${snapshot.runtime.ScreenshotHotkeyAvailable===false?'<span class="failed">快捷键冲突</span>':''}</span><span class="key-combo"><kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>F12</kbd></span></div>`;}
  function devices(){return heading('剪切板','选择接收设备，按快捷键发送文本或截图。',button('添加设备','add','','plus'))+`<div class="section-heading"><h2>设备 <span>${peers().length}</span></h2><div class="device-toolbar"><span class="small muted">${probe?.phase==='done'?probe.results.filter(r=>r.ok).length+' 台可发送剪切板':''}</span>${button(probe&&probe.phase!=='done'?'检测中…':'检测全链路连接','probe','','wifi',probe&&probe.phase!=='done'?'disabled':'')}</div></div>${probeSummary()}${deviceList()}<section class="shortcut-section"><div class="section-heading"><h2>快捷键</h2><button class="inline-action" data-action="targets">发送目标 · ${targets().length} 台设备${icon('down')}</button></div>${shortcutRows()}<div class="last-status" role="status">${icon(['error','partial'].includes(snapshot.runtime.State)?'help':'checkCircle')}<span>${esc(time(snapshot.runtime.At))} ${esc(snapshot.runtime.Detail||'等待下一次发送')}</span></div></section>`;}
  const remoteActive=()=>['connecting','starting','running','recovering','closing'].includes(remoteSession.phase);
  function remoteCard(peer){
    const result=peer.directoryId?{ok:peer.connectable,detail:peer.connectable?'':'对方暂未允许连接'}:remoteProbe?.results.find(r=>r.id===peer.id),owned=remoteSession.peerId===peer.id;
    const phase=owned&&remoteActive()?remoteSession.phase:'';
    const failure=owned&&remoteSession.error||(!result?.ok&&result?.detail)||remoteProbe?.error||'';
    const label=phase?({connecting:'正在连接…',starting:'正在启动控制…',running:'已连接',recovering:'正在重连…',closing:'正在断开…'})[phase]:failure?'无法连接':result?.ok?'可连接':remoteProbe?.phase==='checking'?'检测中…':'待检测';
    const action=phase?button(phase==='connecting'?'取消连接':'断开连接','remote-stop','','',phase==='closing'?'disabled':''):button('连接电脑','connect','primary','remote',`data-id="${esc(peer.id)}" ${!result?.ok||remoteActive()?'disabled':''}`);
    return `<article class="device-card remote-card" data-device-id="${esc(peer.id)}"><div class="remote-art">${icon(glyph(peer))}</div><div class="remote-info"><h3>${esc(peer.name)}</h3><div class="device-meta"><span>${platform(peer)}</span><span class="${failure?'failed':result?.ok?'passed':'muted'}">${label}</span></div>${failure?`<p class="remote-error" role="status">${esc(failure)}</p>`:''}${action}</div></article>`;
  }
  function remote(){return heading('远程控制','已开启发现的电脑会自动出现，选择后即可连接。',button('添加电脑','connect-new','','plus'))+`${directory.error?`<p class="remote-error" role="status">${esc(directory.error)}</p>`:''}<div class="section-heading"><h2>电脑 <span>${computers().length}</span></h2>${button(remoteProbe?.phase==='checking'?'检测中…':'重新检测','remote-probe','','wifi',remoteProbe?.phase==='checking'?'disabled':'')}</div>${computers().length?`<div class="devices-grid">${computers().map(remoteCard).join('')}</div>`:'<div class="empty-state">'+icon('monitor')+'<h2>等待电脑上线</h2><p>请在对方 ClipRelay 中开启「允许被发现」和「允许被连接」。</p></div>'}`;}
  function settings(){
    const c=snapshot.config;
    const hostDetail=remoteHostError?'无法读取远控状态：'+esc(remoteHostError):remoteHostBusy?'正在保存…':!remoteHost?'正在读取远控状态…':remoteHost.enabled&&!remoteHost.ready?'正在准备接收连接…':'开启后，使用此 ClipRelay 服务的人可直接控制本机，无需逐台确认。关闭会断开远控并停止接收连接。';
    const hostControl=`<button class="switch" role="switch" aria-label="允许被连接" aria-checked="${remoteHost?.enabled===true}" data-action="toggle-host" ${remoteHostBusy||!remoteHost?'disabled':''}></button>`;
    const common=row('设备名称','在其他设备上显示的名称。',`<input class="setting-input" id="device-name" aria-label="设备名称" maxlength="32" value="${esc(c.deviceName)}">`)+row('允许被连接',hostDetail,hostControl)+row('允许被发现','开启后，使用此 ClipRelay 服务的人都能发现本机，无需处于同一网络。关闭后退出设备目录，已添加的设备仍可连接。',toggle('允许被发现','discoveryEnabled',c.discoveryEnabled))+row('开机启动','登录后在后台保持连接。',toggle('开机启动','startupEnabled',c.startupEnabled))+row('通知提醒','发送和接收完成后显示通知。',toggle('通知提醒','notifications',c.notifications))+row('外观','选择适合你的界面。',`<select class="setting-input" id="appearance" aria-label="外观">${[['light','浅色'],['dark','深色'],['system','跟随系统']].map(([v,l])=>`<option value="${v}" ${theme===v?'selected':''}>${l}</option>`).join('')}</select>`);
    const advanced=row('快捷键发送目标',`已选择 ${targets().length} 台设备。`,button('选择设备','targets'))+`<details class="accordion"><summary>快捷键</summary>${shortcutRows()}<p>复制文本后自动发送；截图快捷键调用系统截图。</p></details><details class="accordion"><summary>连接诊断</summary><p>本机地址：${(snapshot.addresses||[]).map(a=>esc(a.Address)).join(' / ')||'暂未获取'} · 端口 ${c.port}</p>${row('服务端口','更改后自动重启接收服务。',`<input class="setting-input" id="listen-port" aria-label="服务端口" inputmode="numeric" value="${c.port}">`)}${button('检测全链路连接','probe','','wifi')}</details><details class="accordion"><summary>关于与更新</summary><p>ClipRelay · v${esc(snapshot.update.CurrentVersion||'—')}</p>${button(snapshot.update.Release?'查看新版':'检查更新','updates')}</details>`;
    return heading('设置','把常用偏好放在一起。')+`<div class="segmented" role="tablist" aria-label="设置分类"><button role="tab" aria-selected="${settingsTab==='general'}" class="${settingsTab==='general'?'active':''}" data-tab="general">通用</button><button role="tab" aria-selected="${settingsTab==='advanced'}" class="${settingsTab==='advanced'?'active':''}" data-tab="advanced">高级</button></div>${settingsTab==='general'?common:advanced}<p class="small muted" role="status">${saving?'正在保存…':saveError?'保存失败：'+esc(saveError):'更改会自动保存'}</p>`;
  }
  function paint(force=false){
    if(!snapshot)return;
    root.querySelector('#local-name').textContent=snapshot.config.deviceName||'这台电脑';
    root.querySelector('#local-state').textContent=connectionError?'后台连接中断':'Windows · 后台运行中';
    for(const node of root.querySelectorAll('[data-page]')){node.classList.toggle('active',node.dataset.page===page);node.setAttribute('aria-current',node.dataset.page===page?'page':'false');}
    root.querySelector('#window-label').textContent=page==='settings'?'偏好设置':page==='remote'?'远程控制':'剪切板';
    const key=signature([page,settingsTab,snapshot.config,snapshot.runtime,snapshot.update,probe,remoteProbe,remoteSession,directory,remoteHost,remoteHostError,remoteHostBusy,saving,saveError,connectionError,theme]);
    if(!force&&(key===pageSignature||content.contains(document.activeElement)&&document.activeElement.matches('input,select')))return;
    const scroll=content.scrollTop,focus=document.activeElement;
    const focusedAction=focus?.dataset.action,focusedId=focus?.dataset.id;
    const expanded=[...content.querySelectorAll('details[open] summary')].map(n=>n.textContent);
    pageSignature=key;content.innerHTML=(connectionError?`<div class="error-banner" role="alert">${esc(connectionError)} ${button('重试','refresh','text')}</div>`:'')+({devices,remote,settings}[page])();
    for(const summary of content.querySelectorAll('details summary'))if(expanded.includes(summary.textContent))summary.parentElement.open=true;
    if(focus?.isConnected===false&&focusedAction){[...content.querySelectorAll('[data-action]')].find(n=>n.dataset.action===focusedAction&&n.dataset.id===focusedId)?.focus({preventScroll:true});}
    content.scrollTop=scroll;
  }
  async function refresh(){
    if(polling||closed)return;polling=true;
    if(page==='remote')try{directory=await api.window('desktop-directory');}catch{directory={devices:[],error:'设备列表暂时无法更新，请稍后重试。'};}
    try{accept(await api.request('snapshot'));connectionError='';if(page==='remote'||remoteActive())remoteSession=await api.window('desktop-status');if(page==='settings')void readRemoteHost();paint();updateDialog();document.body.dataset.ready='true';if(!shown){shown=true;await api.window('ready');if(view==='peer-editor')edit(new URLSearchParams(location.search).get('peerId'));else if(view==='updates')updates();else void checkPeers();}if(page==='remote'&&!remoteProbe)void checkRemote();}
    catch(e){connectionError=e.message;if(snapshot)paint();else{content.innerHTML=`<div class="empty-state"><h2>暂时无法连接后台</h2><p>${esc(e.message)}</p>${button('重试','refresh','primary')}</div>`;if(!shown){await api.window('ready');}}}
    finally{polling=false;}
  }
  async function hostRequest(action){
    const reply=await api.request('remote',{action});
    if(!reply?.ok)throw new Error(reply?.error||'远控服务暂不可用');
    if(typeof reply.data?.enabled!=='boolean')throw new Error('远控服务返回了无效状态');
    return reply.data;
  }
  async function readRemoteHost(){
    if(remoteHostReading||remoteHostBusy||closed)return;
    remoteHostReading=true;const current=remoteHostGeneration;
    try{const value=await hostRequest('status');if(current===remoteHostGeneration&&!closed){remoteHost=value;remoteHostError='';}}
    catch(e){if(current===remoteHostGeneration&&!closed){remoteHost=null;remoteHostError=e.message;}}
    finally{remoteHostReading=false;if(!closed)paint();}
  }
  async function toggleRemoteHost(){
    if(remoteHostBusy||!remoteHost)return;
    const enabled=!remoteHost.enabled;remoteHostBusy=true;remoteHostGeneration++;paint();
    try{
      const value=await hostRequest(enabled?'enable':'disable');
      if(value.enabled!==enabled)throw new Error('远控设置尚未生效，请重试');
      remoteHost={enabled:value.enabled,ready:false};remoteHostError='';
    }catch(e){remoteHost=null;remoteHostError=e.message;throw e;}
    finally{remoteHostBusy=false;paint();void readRemoteHost();}
  }
  async function checkPeers(){
    if(probe&&probe.phase!=='done')return;
    if(!peers().length){toast('请先添加设备');return;}
    const current=++generation,active=()=>current===generation&&!closed;
    probe={phase:'discover',ids:peers().map(p=>p.id),results:[],detail:''};paint();
    try{
      let found=[];try{found=list(await api.request('discover'));}catch{if(active())probe.detail='未能刷新地址，按已保存地址检测';}
      if(!active())return;
      const latest=await api.request('snapshot');if(!active())return;
      if(probeRoster(latest.config.peers)!==roster){accept(latest);paint();return;}
      const merged=await api.request('merge',{peers:latest.config.peers,devices:found,addNew:false});if(!active())return;
      if(merged.Added||merged.Updated||merged.Removed){scanCommit=true;try{await patch(currentSnapshot=>{
        if(probeRoster(currentSnapshot.config.peers)!==probeRoster(latest.config.peers))throw new Error('设备列表已改变，请重新检测');
        const selected=new Map(currentSnapshot.config.peers.map(p=>[p.id,p.enabled]));
        return {peers:merged.Peers.map(p=>({...p,enabled:selected.has(p.id)?selected.get(p.id):p.enabled})),expectedRevision:currentSnapshot.revision};
      });}finally{scanCommit=false;}}
      else accept(latest);
      if(!active())return;
      const devices=peers();probe.ids=devices.map(p=>p.id);probe.phase='probe';paint();
      if(!devices.length){cancelProbe();paint();return;}
      const results=list(await api.request('probe',{peers:devices}));if(!active())return;
      // The broadcaster preserves input order. Bind results to this generation's
      // device IDs, never to a roster changed while a request was in flight.
      probe.results=devices.map((p,i)=>({id:p.id,name:p.name,address:p.address,ok:results[i]?.Success===true,detail:results[i]?.Success?'地址与接收响应正常':results[i]?.ErrorMessage||'接收端未响应',status:results[i]?.StatusCode}));
      probe.phase='done';probe.detail=(probe.detail?probe.detail+' · ':'')+time(Date.now())+' 已检测';paint();
    }catch(e){if(active()){probe.phase='done';probe.error=e.message;probe.detail=e.message;paint();}}
  }
  async function checkRemote(){
    if(remoteProbe?.phase==='checking')return;
    const current=++remoteGeneration;remoteProbe={phase:'checking',results:[]};paint();
    try{directory=await api.window('desktop-directory');const results=await api.window('desktop-probe',{peers:computers().filter(p=>!p.directoryId).map(remoteTarget)});if(current!==remoteGeneration||closed)return;remoteProbe={phase:'done',results};}
    catch(e){if(current!==remoteGeneration||closed)return;remoteProbe={phase:'done',results:[],error:e.message};}
    paint();
  }
  function probeDetails(){modal('剪切板全链路连接检测',`<p>刷新全部设备地址，检测剪切板发送通道和接收端响应，不修改对方剪切板。是否选为发送目标不影响检测。</p>${probe?.error?`<p>${esc(probe.error)}</p>`:''}${(probe?.results||[]).map(r=>`<section class="probe-detail"><h3>${esc(r.name)} <span class="${r.ok?'passed':'failed'}">${r.ok?'可发送剪切板':'检测失败'}</span></h3><p>${esc(r.address||'设备连接')}</p><p>${esc(r.detail)}</p></section>`).join('')}`,button('完成','dismiss','primary'));}
  function selectTargets(){modal('快捷键发送目标',`<p>按快捷键时，内容会发送到选中的设备。</p>${peers().length?peers().map(p=>`<label class="check-row"><input type="checkbox" data-target="${esc(p.id)}" ${p.enabled?'checked':''}>${icon(glyph(p))}<span>${esc(p.name)}<small>${platform(p)} · ${peerState(p)}</small></span></label>`).join(''):'<p>先添加一台设备。</p>'}`,button('取消','dismiss')+button('保存','targets-save','primary'));}
  function detail(id){const p=peers().find(p=>p.id===id);if(!p)return;
    const phone=['Android','iOS'].includes(platform(p));
    modal(p.name,`<dl class="detail-list"><div><dt>平台</dt><dd>${platform(p)}</dd></div><div><dt>接收状态</dt><dd>${peerState(p)}</dd></div><div><dt>快捷键目标</dt><dd>${p.enabled?'已选中':'未选中'}</dd></div><div><dt>地址</dt><dd>${esc(p.address||'设备连接')}${p.address?':'+p.port:''}</dd></div></dl>${phone?'<p>当前手机端支持接收内容和控制电脑，尚未提供手机被控服务。</p>':''}`,button('移除','remove','danger','',`data-id="${esc(p.id)}"`)+button('编辑设备','edit','','',`data-id="${esc(p.id)}"`)+(platform(p)==='Android'?button('查看手机内容','preview','','',`data-id="${esc(p.id)}"`):'')+button('完成','dismiss','primary'));
  }
  function edit(id='',kind='devices'){
    const p=peers().find(p=>p.id===id);
    modal(p?'编辑设备':kind==='computers'?'手动添加电脑':'手动添加设备',`<form id="peer-form" data-id="${esc(id||'')}" data-kind="${kind}"><label>设备名称<input name="name" class="modal-input" maxlength="32" value="${esc(p?.name||'')}" placeholder="例如：我的电脑" required></label>${p?.pairedOwner?'':`<label>设备地址<input name="address" class="modal-input" value="${esc(p?.address||'')}" placeholder="例如 192.168.1.23" autocomplete="off" required></label><label>接收端口<input name="port" class="modal-input" inputmode="numeric" value="${p?.port||47632}" required></label>`}<button type="submit" hidden></button></form>`,button('取消','dismiss')+button('保存设备','peer-save','primary'));
  }
  async function savePeer(){
    const form=dialog.querySelector('#peer-form');if(!form.reportValidity())return;
    const existing=peers().find(p=>p.id===form.dataset.id),values=new FormData(form);
    if(!existing?.pairedOwner&&!/^\d+$/.test(values.get('port')))throw new Error('端口必须是 1 到 65535 之间的整数');
    const candidate={...(existing||{id:crypto.randomUUID().replaceAll('-',''),enabled:form.dataset.kind!=='computers',platform:''}),name:values.get('name').trim()};
    if(!existing?.pairedOwner)Object.assign(candidate,{address:values.get('address').trim(),port:Number(values.get('port')),accessToken:'',legacyAllowed:true,transport:'legacy',pairedOwner:'',requiresAuth:false});
    const normalized=await api.request('normalize-peer',candidate);
    await patch(current=>{const all=[...current.config.peers],index=all.findIndex(p=>p.id===candidate.id);if(index<0){if(all.length>=16)throw new Error('最多可添加 16 台设备');all.push(normalized);}else all[index]=normalized;return {peers:all,expectedRevision:current.revision};});closeDialog();toast('设备已保存');
  }
  let discovered=[],discoveryKind='devices';
  const sameDevice=(a,b)=>a.id&&b.id&&String(a.id).toLowerCase()===String(b.id).toLowerCase()||a.address&&b.address&&String(a.address).toLowerCase()===String(b.address).toLowerCase()&&Number(a.port)===Number(b.port);
  async function add(kind='devices'){
    discoveryKind=kind;discovered=[];
    const computerOnly=kind==='computers',title=computerOnly?'添加电脑':'添加设备';
    const footer=()=>button('手动输入地址','manual','','',`data-kind="${kind}"`)+button('重新扫描','scan-again','','',`data-kind="${kind}"`)+button('完成','dismiss');
    modal(title,`<p role="status">正在扫描局域网中的${computerOnly?'电脑':'设备'}…</p><p>请在对方的 ClipRelay 设置中开启「允许被发现」。</p>`,footer());
    const marker=Symbol();dialog.scanMarker=marker;
    try{const raw=list(await api.request('discover'));if(!dialog.open||dialog.scanMarker!==marker)return;
      const localAddresses=new Set((snapshot.addresses||[]).map(a=>String(a.Address||a.address).toLowerCase()));
      const found=raw.map(d=>({id:String(d.Id||d.id||''),name:String(d.Name||d.name||d.DeviceName||d.Address||d.address||'附近设备'),address:String(d.Address||d.address||''),port:Number(d.Port||d.port||47632),platform:String(d.Platform||d.platform||'').toLowerCase(),requiresAuth:!!(d.RequiresAuth||d.requiresAuth)})).filter(d=>d.id&&d.address&&d.id.toLowerCase()!==String(snapshot.config.deviceId||'').toLowerCase()&&!(localAddresses.has(d.address.toLowerCase())&&d.port===snapshot.config.port)&&(!computerOnly||['Windows','macOS','Linux'].includes(platform(d))));
      discovered=found.filter((d,i)=>found.findIndex(other=>sameDevice(d,other))===i);
      modal(title,`<p>扫描同一局域网中已开启「允许被发现」的${computerOnly?'电脑':'设备'}。</p><div aria-live="polite">${discovered.length?discovered.map((d,i)=>{const added=peers().some(p=>sameDevice(p,d));return `<div class="found-device">${icon(glyph(d))}<div><strong>${esc(d.name)}</strong><p>${platform(d)} · ${esc(d.address)}</p></div>${button(added?'已添加':'添加','add-found','soft','',`data-index="${i}" ${added?'disabled':''}`)}</div>`;}).join(''):'<p>暂未发现'+(computerOnly?'电脑':'设备')+'。请确认两端在同一局域网、ClipRelay 正在运行，并已开启「允许被发现」。</p>'}</div>`,footer());
    }catch(e){if(dialog.open&&dialog.scanMarker===marker)error(e);}
  }
  function updates(){modal('关于与更新','<div id="update-state"></div>',button('完成','dismiss','primary'));updateDialog();if(!snapshot.update.Operation)api.request('update-check').catch(error);}
  function updateDialog(){const node=dialog.querySelector('#update-state');if(!node)return;const u=snapshot.update;node.innerHTML=`<p>ClipRelay · v${esc(u.CurrentVersion||'—')}</p><p role="status">${esc(u.Error|| (u.Operation==='check'?'正在检查更新…':u.Operation==='download'?'正在下载…':u.FilePath?'下载完成':u.Release?'发现新版 v'+u.Release.versionName:u.Checked?'已是最新版本':'等待检查'))}</p>${u.Release?`<div class="update-notes">${esc(u.Release.releaseNotes||'')}</div>`:''}<div class="modal-footer">${button('检查更新','update-check','','',u.Operation?'disabled':'')}${u.Release?button(u.FilePath?'打开下载位置':'下载新版',u.FilePath?'update-open':'update-download','primary','',u.Operation?'disabled':''):''}</div>`;}
  async function close(){try{await commitInput(document.activeElement);await saveQueue;await api.window('close');}catch(e){error(e);}}
  async function commitInput(node){if(!snapshot||!node)return;if(node.id==='device-name'&&node.value!==snapshot.config.deviceName){const value=node.value.trim();if(!value)throw new Error('请输入设备名称');await patch({deviceName:value});}if(node.id==='listen-port'&&node.value!==String(snapshot.config.port)){if(!/^\d+$/.test(node.value)||Number(node.value)<1||Number(node.value)>65535)throw new Error('端口必须是 1 到 65535 之间的整数');await patch({port:Number(node.value)});}}
  const actions={
    'toggle-host':toggleRemoteHost,
    close,minimize:()=>api.window('minimize'),maximize:()=>api.window('maximize'),dismiss:closeDialog,refresh,probe:()=>{if(dialog.open)closeDialog();page='devices';paint();return checkPeers();},'probe-detail':probeDetails,targets:selectTargets,add:()=>add(),'scan-again':el=>add(el.dataset.kind),manual:el=>edit('',el.dataset.kind),edit:el=>edit(el.dataset.id),detail:el=>detail(el.dataset.id),'peer-save':savePeer,
    'targets-save':async()=>{const selected=new Set([...dialog.querySelectorAll('[data-target]:checked')].map(n=>n.dataset.target));await patch(current=>({peers:current.config.peers.map(p=>({...p,enabled:selected.has(p.id)})),expectedRevision:current.revision}));closeDialog();},
    'toggle-target':async el=>{const id=el.dataset.id;await patch(current=>({peers:current.config.peers.map(p=>p.id===id?{...p,enabled:!p.enabled}:p),expectedRevision:current.revision}));},
    remove:async el=>{const id=el.dataset.id;await patch(current=>({peers:current.config.peers.filter(p=>p.id!==id),expectedRevision:current.revision}));closeDialog();toast('设备已移除');},
    'add-found':async el=>{const device=discovered[Number(el.dataset.index)],computerOnly=discoveryKind==='computers';if(!device)return;await patch(async current=>{const merged=await api.request('merge',{peers:current.config.peers,devices:[device],addNew:true});return {peers:merged.Peers.map(p=>computerOnly&&!current.config.peers.some(existing=>sameDevice(existing,p))?{...p,enabled:false}:p),expectedRevision:current.revision};});closeDialog();toast(computerOnly?'电脑已添加':'设备已添加');},
    connect:async el=>{const p=computers().find(p=>p.id===el.dataset.id);if(!p)return;remoteSession=await api.window('desktop-client',{peer:remoteTarget(p)});activeComputer={...p};paint();},
    'remote-probe':checkRemote,'remote-stop':async()=>{remoteSession=await api.window('desktop-stop');paint();},
    'connect-new':()=>add('computers'),preview:()=>api.window('open',{name:'preview-remote'}),updates,'update-check':()=>api.request('update-check'),'update-download':()=>api.request('update-download'),'update-open':()=>api.request('update-open')
  };
  root.addEventListener('click',async event=>{
    const el=event.target.closest('button');if(!el||el.disabled)return;
    try{
      if(el.dataset.page){await commitInput(document.activeElement);page=el.dataset.page;pageSignature='';content.scrollTop=0;paint();if(page==='remote'&&!remoteProbe)void checkRemote();if(page==='settings')void readRemoteHost();return;}
      if(el.dataset.tab){settingsTab=el.dataset.tab;paint();return;}
      if(el.dataset.setting){const key=el.dataset.setting;el.disabled=true;await patch({[key]:!snapshot.config[key]});return;}
      if(actions[el.dataset.action]){el.disabled=true;await actions[el.dataset.action](el);}
    }catch(e){error(e);}finally{if(el.isConnected)el.disabled=false;}
  });
  root.addEventListener('submit',event=>{if(event.target.id==='peer-form'){event.preventDefault();savePeer().catch(error);}});
  root.addEventListener('change',event=>{if(event.target.id==='appearance'){theme=event.target.value;localStorage.setItem('cliprelay-appearance',theme);applyTheme();paint();}});
  root.addEventListener('focusout',event=>{if(['device-name','listen-port'].includes(event.target.id))commitInput(event.target).catch(error);});
  api.onClose(close);api.onError(message=>error(new Error(message)));const unsubscribe=api.onRefresh(refresh);
  const disposeNavigate=api.onNavigate?.(value=>{page=['remote','settings'].includes(value)?value:'devices';paint();if(page==='remote'&&!remoteProbe)void checkRemote();if(page==='settings')void readRemoteHost();});
  window.addEventListener('beforeunload',()=>{closed=true;generation++;remoteGeneration++;clearInterval(timer);clearTimeout(toastTimer);unsubscribe?.();disposeNavigate?.();media.removeEventListener('change',applyTheme);});
  await refresh();const timer=setInterval(refresh,900);
}
