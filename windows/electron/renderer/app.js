import {renderControl,byId,text,checked,click,setValue} from './layout.js';
import {openDialog} from './dialogs.js';

const api=window.cliprelay;
const view=new URLSearchParams(location.search).get('view') || 'control-center';
let snapshot, polling=false, closed=false, busy=false, addressIndex=0, peerSignature='', peerStatuses=new Map();
let roster='',generation=0,scanCommit=false,shown=false,saveQueue=Promise.resolve();
const app=byId('app');
const clock=()=>new Date().toLocaleTimeString('zh-CN',{hour12:false});
const date=value=>value ? new Date(typeof value==='string' && value.startsWith('/Date(')?Number(value.match(/\d+/)[0]):value).toLocaleTimeString('zh-CN',{hour12:false}) : '—';
const color=(id,value)=>{if(byId(id))byId(id).style.color=value;};
const open=name=>api.window('open',{name});
const fail=error=>{text('AutoSaveStatusLabel','● 更改尚未保存');color('AutoSaveStatusLabel','#f43f5e');if(byId('AutoSaveStatusLabel'))byId('AutoSaveStatusLabel').title=error.message;};

function patch(data) {
  const operation=saveQueue.catch(()=>{}).then(()=>savePatch(data));
  saveQueue=operation;return operation;
}
async function savePatch(data) {
  text('AutoSaveStatusLabel','● 正在保存…');color('AutoSaveStatusLabel','#fbbf24');
  try {snapshot=await api.request('patch',data);render();text('AutoSaveStatusLabel','● 已自动保存 · '+clock());color('AutoSaveStatusLabel','#10b981');}
  catch(error){fail(error);throw error;}
}
function showError(error){
  fail(error);
  const dialog=document.createElement('dialog');dialog.className='error-dialog';
  const heading=document.createElement('strong');heading.textContent='无法自动保存设置';
  const message=document.createElement('p');message.textContent=error.message;
  const ok=document.createElement('button');ok.textContent='确定';ok.onclick=()=>dialog.close();
  dialog.append(heading,message,ok);app.append(dialog);dialog.onclose=()=>dialog.remove();dialog.showModal();
}
async function closeSettings(){
  try{
    await saveQueue;
    const data={};
    for(const [id,key] of Object.entries({DeviceNameInput:'deviceName',PortInput:'port',AccessTokenInput:'accessToken'})){
      const value=byId(id).value;
      if(key==='port' && (!/^\d+$/.test(value.trim()) || Number(value)<1 || Number(value)>65535))throw new Error('服务端口必须是 1 到 65535 之间的整数。');
      if(String(snapshot.config[key])!==value)data[key]=key==='port'?Number(value):value;
    }
    if(Object.keys(data).length)await patch(data);
    await api.window('close');
  }catch(error){showError(error);saveQueue=Promise.resolve();}
}

const layout=view==='control-center'?await (await fetch('./layouts/control-center.json')).json():null;
let peerTemplate;
if(layout){
  layout.x=0;layout.y=0;renderControl(layout,app);
  peerTemplate=structuredClone(find(layout,'PeerRow0'));
  byId('PeerDetailsPanel').replaceChildren();
  byId('ScreenSharingStatusPanel').hidden=true;
  for(const id of ['topCategoryHeader','largeHeader','topSubHeader','brandLogo','brandTitle','brandSubtitle'])byId(id)?.classList.add('drag');
  for(const id of ['CloseButton','CloseSettingsButton'])click(id,closeSettings);
  click('MinimizeButton',()=>api.window('minimize'));
  api.onClose(closeSettings);api.onError(message=>showError(new Error(message)));
  document.addEventListener('keydown',event=>{if(event.key==='Escape' && !document.querySelector('dialog[open]'))closeSettings();});
  click('PinButton',async()=>{const pinned=await api.window('pin');text('PinButton',pinned?'已置顶':'Pin');byId('PinButton').ariaLabel=pinned?'取消置顶窗口':'置顶窗口';byId('PinButton').style.setProperty('--fill',pinned?'#3b82f6':'#111318');});
  click('PhonePreviewButton',()=>open('preview-remote'));click('RemoteDesktopButton',()=>open('remote-desktop'));
  click('ScreenShareButton',()=>open('screen-share-picker'));click('UpdateButton',()=>open('updates'));
  click('ScreenSharingActionButton',async()=>{try{if(snapshot.sharing.Active)await api.request('stop-sharing');else await open('screen-share-picker');await refresh();}catch(error){fail(error);}});
  click('showTokenButton',()=>{const input=byId('AccessTokenInput');input.type=input.type==='password'?'text':'password';text('showTokenButton',input.type==='password'?'显示':'隐藏');});
  click('switchAddressButton',()=>{addressIndex=(addressIndex+1)%snapshot.addresses.length;renderAddress();});
  click('copyButton',async()=>{await api.request('copy',{text:snapshot.addresses[addressIndex].Address});text('copyButton','已复制');setTimeout(()=>text('copyButton','复制'),2000);});
  click('AddPeerButton',()=>open('peer-editor'));
  for(const [id,key] of Object.entries({NotificationToggle:'notifications',StartupToggle:'startupEnabled',DiscoveryToggle:'discoveryEnabled',LegacyReceiverToggle:'legacyReceiverEnabled'})){
    byId(id).ariaLabel={notifications:'气泡通知提醒',startupEnabled:'开机自动启动',discoveryEnabled:'局域网自动发现 (mDNS)',legacyReceiverEnabled:'允许旧版未加密接收，仅限局域网'}[key];
    click(id,async()=>{byId(id).disabled=true;try{await patch({[key]:!snapshot.config[key]});}catch(error){showError(error);}finally{byId(id).disabled=false;}});
  }
  for(const [id,key] of Object.entries({DeviceNameInput:'deviceName',PortInput:'port',AccessTokenInput:'accessToken'})){
    byId(id).ariaLabel={deviceName:'发现设备名称',port:'本机端口',accessToken:'本机接收密钥'}[key];
    byId(id).addEventListener('blur',()=>{
      const value=byId(id).value;
      if(String(snapshot.config[key])===value)return;
      if(key==='port' && (!/^\d+$/.test(value.trim()) || Number(value)<1 || Number(value)>65535)){fail(new Error('服务端口必须是 1 到 65535 之间的整数。'));return;}
      patch({[key]:key==='port'?Number(value):value}).catch(()=>{});
    });
  }
  click('ScanPeersButton',()=>checkPeers(true));click('TestPeersButton',()=>checkPeers(false));
}

function find(node,id){if(node.id===id)return node;for(const child of node.children || []){const found=find(child,id);if(found)return found;}}
function renderAddress(){const addresses=snapshot.addresses || [];addressIndex=Math.min(addressIndex,Math.max(0,addresses.length-1));text('localAddressValue',addresses[addressIndex]?.Address || '未检测到地址');byId('copyButton').disabled=!addresses.length;byId('switchAddressButton').disabled=addresses.length<2;}
function renderPeers(){
  const peers=snapshot.config.peers || [];
  const signature=JSON.stringify([peers,[...peerStatuses]]);if(signature===peerSignature)return;peerSignature=signature;
  const panel=byId('PeerDetailsPanel');const scroll=panel.scrollTop;panel.replaceChildren();
  peers.forEach((peer,index)=>{
    const model=structuredClone(peerTemplate);model.y=index*64;
    const rename=node=>{node.id=node.id.replace(/0$/,String(index));node.children?.forEach(rename);};rename(model);
    renderControl(model,panel);
    text('PeerNameLabel'+index,peer.name);text('PeerAddressLabel'+index,peer.pairedOwner?'配对加密连接':peer.address);
    const state=peerStatuses.get(peer.id);
    const blocked=!peer.pairedOwner && peer.legacyAllowed!==true;
    text('PeerStatusLabel'+index,peer.enabled?(blocked?'兼容未开启':(state?.text || '待检测')):'已停用');color('PeerStatusLabel'+index,peer.enabled?(blocked?'#fbbf24':(state?.color || '#94a3b8')):'#64748b');
    checked('PeerEnabledToggle'+index,peer.enabled);byId('PeerEnabledToggle'+index).ariaLabel=`向 ${peer.name} 发送`;
    click('PeerEnabledToggle'+index,()=>{cancelCheck();patch({peers:peers.map(item=>item.id===peer.id?{...item,enabled:!item.enabled}:item),expectedRevision:snapshot.revision}).catch(showError);});
    byId('PeerMoreButton'+index).ariaLabel=`${peer.name} 的更多操作`;
    click('PeerMoreButton'+index,()=>api.window('peer-menu',{id:peer.id}));
    byId('PeerRow'+index).oncontextmenu=event=>{event.preventDefault();api.window('peer-menu',{id:peer.id});};
  });
  if(!peers.length){const label=document.createElement('div');label.id='EmptyPeersLabel';label.textContent='尚未添加设备';label.style.cssText='position:absolute;left:8px;top:48px;width:164px;height:28px;display:flex;align-items:center;justify-content:center;color:#94a3b8';panel.append(label);}
  panel.scrollTop=scroll;byId('AddPeerButton').disabled=peers.length>=16;
}
function render(){
  if(!layout || !snapshot)return;
  const {config,runtime,sharing,update}=snapshot;
  const currentRoster=JSON.stringify(config.peers);
  if(roster && roster!==currentRoster && !scanCommit){cancelCheck();peerStatuses.clear();const count=config.peers.filter(p=>p.enabled).length;connection(count?`已启用 ${count} 台设备 · 待检测`:'已暂停发送',count?'设备选择已保存，下一次复制会发送给已开启的设备':'开启设备开关即可恢复发送，本机仍可接收');text('OnlineStatusLabel',count?'待检测':'已暂停');color('OnlineStatusLabel','#94a3b8');}
  roster=currentRoster;
  const legacy=config.legacyReceiverEnabled===true;
  text('serviceLabel',legacy?'旧版接收已开启':'旧版接收已关闭');
  text('serviceSub',legacy?`未加密 · :${config.port}`:'配对连接独立运行');text('statusHeroCard-4',legacy?'旧版仅限局域网':'旧版 HTTP 推送已禁用');
  text('PeerCountLabel',`${(config.peers || []).filter(p=>p.enabled).length} 台`);
  text('sidebarAuthLabel',legacy?(config.accessToken?'已设密钥':'未设密钥'):'兼容关闭');color('sidebarAuthLabel',legacy?'#fbbf24':'#64748b');
  checked('NotificationToggle',config.notifications);checked('StartupToggle',config.startupEnabled);checked('DiscoveryToggle',config.discoveryEnabled);checked('LegacyReceiverToggle',legacy);
  byId('LegacyReceiverToggle').title='文本、截图和访问密钥均以明文传输。仅为旧设备开启；配对连接不需要此开关。';
  setValue('DeviceNameInput',config.deviceName);setValue('PortInput',config.port);setValue('AccessTokenInput',config.accessToken);
  text('screenshotHotkeyState',runtime.ScreenshotHotkeyAvailable?'可用':'冲突');color('screenshotHotkeyState',runtime.ScreenshotHotkeyAvailable?'#10b981':'#f43f5e');
  text('activityTitle',runtime.Detail);text('activityTime',date(runtime.At));text('sidebarLastRelayLabel',date(runtime.At));
  const activityColor=({success:'#10b981',partial:'#8b5cf6',error:'#f43f5e'})[runtime.State] || '#94a3b8';
  byId('activityAccent').style.backgroundColor=activityColor;color('activityTitle',['partial','error'].includes(runtime.State)?activityColor:'#f1f5f9');
  const hasSharing=sharing.Stage!=='idle';byId('ScreenSharingStatusPanel').hidden=!hasSharing;byId('connectionPanel').hidden=hasSharing;
  text('ScreenSharingStatusTitle',sharing.Title);text('ScreenSharingStatusDetail',sharing.Detail);text('ScreenSharingActionButton',sharing.Action);
  text('UpdateButton',update.Release?`● 新版 ${update.Release.versionName}`:`版本 v${update.CurrentVersion}`);
  renderAddress();renderPeers();
}
function connection(title,detail,stroke='#262c3c',dot='#94a3b8'){
  text('ConnectionTitleLabel',title);text('connectionDetail',detail);
  byId('connectionPanel').style.setProperty('--panel-border',stroke);color('connectionDot',dot);
}
function cancelCheck(){generation++;busy=false;byId('TestPeersButton').disabled=false;byId('ScanPeersButton').disabled=false;text('TestPeersButton','⚡ 检测全链路连接');}
function setPeerStates(peers,label,tint='#94a3b8'){peerStatuses=new Map(peers.map(peer=>[peer.id,{text:label,color:tint}]));renderPeers();}
async function checkPeers(addNew){
  if(busy)return;
  let enabled=snapshot.config.peers.filter(p=>p.enabled);
  if(!enabled.length && !addNew){connection('已暂停发送','在左侧添加或开启设备即可发送，本机仍可接收');text('OnlineStatusLabel','已暂停');color('OnlineStatusLabel','#94a3b8');return;}
  const current=++generation;const active=()=>current===generation && !closed;
  busy=true;byId('TestPeersButton').disabled=true;byId('ScanPeersButton').disabled=true;text('TestPeersButton','更新地址中...');
  connection(addNew?'正在扫描局域网设备':'正在查找设备的最新地址',addNew?'发现的设备会加入左侧列表，可随时开关或编辑':'扫描局域网，更新已保存设备的 IP 和端口后检测连接');
  text('OnlineStatusLabel','更新地址中');color('OnlineStatusLabel','#fbbf24');setPeerStates(enabled,'更新地址中');
  let detail='';
  try{
    let devices=[];try{devices=await api.request('discover');devices=Array.isArray(devices)?devices:devices?[devices]:[];if(!devices.length)detail='未发现设备，按已保存地址检测 · ';}catch{detail='扫描失败，按已保存地址检测 · ';}
    if(!active())return;
    const latest=await api.request('snapshot');if(!active())return;
    if(JSON.stringify(latest.config.peers)!==roster){snapshot=latest;render();return;}
    const merged=await api.request('merge',{peers:latest.config.peers,devices,addNew});if(!active())return;
    if(merged.Added || merged.Updated || merged.Removed){
      scanCommit=true;try{await patch({peers:merged.Peers,expectedRevision:latest.revision});}finally{scanCommit=false;}
      detail=addNew?`已新增 ${merged.Added} 台，更新 ${merged.Updated} 台 · `:`已更新 ${merged.Updated} 台设备地址 · `;
    }else snapshot=latest;
    if(!active())return;
    enabled=snapshot.config.peers.filter(p=>p.enabled);
    if(!enabled.length){connection('已暂停发送','开启左侧设备的开关即可恢复发送，本机仍可接收');text('OnlineStatusLabel','已暂停');color('OnlineStatusLabel','#94a3b8');return;}
    text('TestPeersButton','检测中...');connection(`正在并行检测 ${enabled.length} 台设备`,detail+'每台设备独立响应，不会修改剪贴板内容');
    text('OnlineStatusLabel','检测中');setPeerStates(enabled,'检测中');
    const response=await api.request('probe',{peers:enabled});const results=Array.isArray(response)?response:[response];
    if(!active())return;
    const summary=await api.request('summary',{results});if(!active())return;
    const successful=results.filter(r=>r.Success).length;
    const tint=successful===results.length?'#10b981':successful?'#8b5cf6':'#f43f5e';
    connection(successful===results.length?`全部可用 · ${successful}/${results.length} 台设备`:successful?`部分可用 · ${successful}/${results.length} 台设备`:'所有广播设备均不可达',detail+summary.Detail+' · '+clock(),tint,tint);
    text('OnlineStatusLabel',`${successful}/${results.length} 台可用`);color('OnlineStatusLabel',successful===results.length?'#10b981':successful?'#fbbf24':'#f43f5e');
    peerStatuses=new Map(enabled.map((peer,index)=>[peer.id,{text:results[index]?.Success?'✓ 可用':'× 不可用',color:results[index]?.Success?'#10b981':'#f43f5e'}]));
    renderPeers();
  }catch(error){if(active()){connection('无法检测广播设备',error.message,'#f43f5e','#f43f5e');text('OnlineStatusLabel','检测失败');color('OnlineStatusLabel','#f43f5e');setPeerStates(enabled,'× 检测失败','#f43f5e');}}
  finally{if(active())cancelCheck();}
}
let dialog;
if(!layout)dialog=await openDialog(view,app,api,new URLSearchParams(location.search));
async function refresh(){
  if(polling || closed)return;polling=true;
  try{snapshot=await api.request('snapshot');render();await dialog?.update?.(snapshot);document.body.dataset.ready='true';if(!shown){shown=true;await api.window('ready');if(layout)checkPeers(false);}}
  catch(error){if(!layout)dialog?.error?.(error);}
  finally{polling=false;}
}
api.onRefresh(refresh);
window.addEventListener('beforeunload',()=>{closed=true;dialog?.dispose?.();});
await refresh();
setInterval(refresh,view==='updates'?250:750);
