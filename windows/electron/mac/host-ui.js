export function mount(root,api,cancel,initial){
  root.className='host-settings';let state=initial,disposed=false,pending=false,refreshing=false,timer=null,noticeText='',generation=0;
  const confirmations=new Map();let revocation=null;
  const element=(tag,text='')=>{const node=document.createElement(tag);node.textContent=text;return node;};
  const title=element('h1','本机远程访问'),status=element('p'),controls=element('div'),start=element('button','启动远程访问'),stop=element('button','停止远程访问');
  const permissions=element('button','检查系统权限'),close=element('button','关闭'),notice=element('p'),requests=element('div'),clients=element('div'),capabilities=element('p'),clipboard=element('p');
  const startupLabel=element('label'),startup=element('input');startup.type='checkbox';startup.name='host-auto-start';
  startupLabel.className='host-startup';startupLabel.append(startup,element('span','打开 ClipRelay 时自动启动远程访问'));
  const loginLabel=element('label'),login=element('input'),loginStatus=element('p');login.type='checkbox';login.name='login-startup';
  loginLabel.className='host-startup';loginLabel.append(login,element('span','登录 Mac 后打开 ClipRelay'));loginStatus.setAttribute('role','status');
  status.setAttribute('role','status');notice.setAttribute('aria-live','polite');controls.className='host-actions';
  controls.append(start,stop,permissions,close);root.append(title,status,controls,loginLabel,loginStatus,startupLabel,
    element('p','自动启动设置在下次打开应用时生效。当前远程访问使用上方的启动、停止按钮控制。'),
    element('p','启动后，可在同一局域网的另一台设备中添加这台 Mac；配对请求会自动允许。关闭此窗口后仍允许连接，点击“停止远程访问”可结束连接。'),
    capabilities,clipboard,element('p','本机语音及隐私控制仍待提供。'),notice,requests,clients);
  const errors={HOST_UNAVAILABLE:'此安装包未包含完整的本机远程访问组件。',HOST_PERMISSION_REQUIRED:'请先允许屏幕录制和键鼠控制。',HOST_KEYCHAIN_UNAVAILABLE:'系统钥匙串不可用，请稍后重试。',HOST_PAIR_STALE:'这次请求已过期或已处理，请核对当前请求。',HOST_PAIR_CLOSED:'远程访问已停止。',HOST_PAIR_TIMEOUT:'读取配对请求超时，请重试。',HOST_PAIR_UNAVAILABLE:'暂时无法读取配对请求，请重试。',HOST_ENGINE_EXITED:'远程画面组件已退出。',HOST_COMPANION_EXITED:'远程连接组件已退出。'};
  function render(){
    clipboard.textContent=state.phase!=='running'?'远程访问启动后会显示剪贴板的可用状态。':state.clipboardExchange===true?
      '已配对设备可主动发送或读取本机剪贴板中的文本和图片。读取时如有系统权限提示，请在这台 Mac 上确认。':
      '此安装版本尚未提供远程剪贴板读写。';
    capabilities.textContent=state.phase!=='running'?'远程访问启动后会显示文件传输的可用状态。':state.fileTransfer===true?
      '当前支持远程画面、键鼠控制与文件传输。允许连接的设备可浏览、上传和下载个人目录中的文件；系统限制的目录需要相应权限。':
      '当前支持远程画面与键鼠控制，此安装版本尚未提供文件传输。';
    status.textContent=({stopped:'远程访问已停止',starting:'正在启动远程访问…',running:'远程访问已启动',stopping:'正在停止远程访问…',failed:'远程访问未能运行',closed:'应用正在退出'})[state.phase] || '无法确认远程访问状态';
    start.disabled=pending || !state.available || !['stopped','failed'].includes(state.phase);
    stop.disabled=pending || !state.available || !['starting','running'].includes(state.phase);
    startup.checked=state.autoStart===true;startup.disabled=pending || state.phase==='closed' || (!state.available && !startup.checked);
    const loginState=state.loginStartup || {};
    login.checked=loginState.registered===true;login.indeterminate=loginState.status==='unknown';
    login.disabled=pending || state.phase==='closed' || loginState.available!==true;
    loginStatus.textContent=({enabled:'已开启：下次登录 Mac 后，ClipRelay 会在菜单栏运行。',
      'requires-approval':'等待系统批准。请前往“系统设置 → 通用 → 登录项与扩展”允许 ClipRelay；目前尚未生效。',
      'not-registered':'登录启动已关闭。此开关只打开应用；自动允许远程连接请使用下方设置。',
      'not-found':'系统尚未提供登录启动记录。可以尝试开启，设置后会再次核对状态。',
      unknown:'暂时无法确认登录启动状态，请检查系统设置中的登录项。'})[loginState.status] || '请使用已安装的 Mac 应用设置登录启动。';
    notice.textContent=noticeText || (state.error?(errors[state.error] || '无法完成操作，请检查权限后重试。'):'');
    requests.replaceChildren();const live=new Set();
    for(const request of state.requests || []){
      const key=request.id+':'+request.generation;live.add(key);
      const row=element('section'),name=element('h2',request.name),verification=element('strong',request.verification),label=element('label'),checkbox=element('input');
      checkbox.type='checkbox';checkbox.name='pair-confirmation';checkbox.checked=confirmations.get(key)===true;checkbox.disabled=pending || request.state!=='waiting';
      label.append(checkbox,element('span','我已确认两端验证码一致'));
      const approve=element('button',request.state==='approving'?'正在配对…':'允许连接'),reject=element('button','拒绝');
      approve.disabled=pending || request.state!=='waiting' || !checkbox.checked;reject.disabled=pending || request.state!=='waiting';
      checkbox.onchange=()=>{confirmations.set(key,checkbox.checked);approve.disabled=pending || request.state!=='waiting' || !checkbox.checked;};
      const data={id:request.id,generation:request.generation,verification:request.verification};
      approve.onclick=()=>{if(!approve.disabled)return perform('host-pair-approve',data);};reject.onclick=()=>{if(!reject.disabled)return perform('host-pair-reject',data);};
      row.append(name,verification,element('p','请求将在 '+new Date(request.expires*1000).toLocaleTimeString()+' 过期'),label,approve,reject);requests.append(row);
    }
    for(const key of confirmations.keys())if(!live.has(key))confirmations.delete(key);
    if(state.phase==='running' && !live.size)requests.append(element('p','等待设备发起配对请求。'));
    renderClients();
  }
  function renderClients(){
    clients.replaceChildren();clients.append(element('h2','已配对设备'));
    const saved=state.clients || {phase:'unavailable',devices:[]};
    if(revocation && (revocation.viewId!==saved.viewId || !saved.devices.some(device=>device.uuid===revocation.uuid)))revocation=null;
    if(saved.phase==='unavailable'){clients.append(element('p','启动远程访问后可管理已配对设备。'));return;}
    if(saved.phase==='loading'){clients.append(element('p','正在读取设备…'));return;}
    if(saved.error)clients.append(element('p',saved.error==='HOST_CLIENTS_UNCONFIRMED'?'尚未确认撤销完成。请核对设备状态后重试；已停用的设备不会自动恢复权限。':'暂时无法读取设备，请稍后刷新。'));
    if(!saved.devices.length && saved.phase==='ready')clients.append(element('p','还没有已配对设备。'));
    for(const device of saved.devices){
      const row=element('section'),revoke=element('button',saved.revoking===device.uuid?'正在撤销…':'撤销访问权限');
      row.append(element('h3',device.name || '未命名设备'),element('p',(device.enabled?'允许连接':'已停用')+' · 设备标识 '+device.uuid.slice(-8)));
      revoke.disabled=pending || saved.phase!=='ready';
      const data={viewId:saved.viewId,uuid:device.uuid};
      revoke.onclick=()=>{if(!revoke.disabled){revocation=data;render();}};
      if(revocation?.uuid===device.uuid && revocation.viewId===saved.viewId){
        const confirm=element('button','确认撤销'),back=element('button','取消');
        confirm.disabled=pending || saved.phase!=='ready';back.disabled=pending;
        row.append(element('p','撤销后将结束该设备的连接，再次连接需要重新配对。'),confirm,back);
        confirm.onclick=()=>{if(!confirm.disabled)return perform('host-client-revoke',data);};
        back.onclick=()=>{if(!back.disabled){revocation=null;render();}};
      }else row.append(revoke);
      clients.append(row);
    }
  }
  async function refresh(){
    if(disposed || refreshing || pending)return;refreshing=true;const current=generation;
    try{const result=await api.request('host-status');if(!disposed && current===generation){state=result;render();}}
    catch{if(!disposed && current===generation){state={...state,requests:[],error:'HOST_PAIR_UNAVAILABLE',clients:{phase:'failed',devices:[],error:'HOST_CLIENTS_UNAVAILABLE'}};render();}}
    finally{refreshing=false;}
  }
  async function perform(action,data){
    if(disposed || pending)return;generation++;pending=true;noticeText='';render();
    try{
      const result=await api.request(action,data);if(disposed)return;state=result;
      if(action==='host-pair-approve')noticeText='已允许这次请求，请在对方设备完成连接。';
      if(action==='host-pair-reject')noticeText='已拒绝这次请求。';
      if(action==='host-client-revoke'){revocation=null;noticeText='已撤销该设备的访问权限，再次连接需要重新配对。';}
      if(action==='host-set-auto-start')noticeText=data.enabled?'已保存，下次打开 ClipRelay 时会自动启动远程访问。':'已关闭自动启动。';
    }catch{if(!disposed){noticeText=action==='host-set-login-startup'?'登录启动设置尚未确认，请核对系统状态。':action==='host-set-auto-start'?'设置未能保存，请重试。':action==='host-client-revoke'?'尚未确认撤销完成，请核对设备状态后重试。':'操作未完成，请刷新并核对当前请求。';await refreshAfterAction();}}
    finally{if(!disposed){pending=false;render();}}
  }
  async function refreshAfterAction(){try{state=await api.request('host-status');}catch{state={...state,requests:[],error:'HOST_PAIR_UNAVAILABLE',clients:{phase:'failed',devices:[],error:'HOST_CLIENTS_UNAVAILABLE'}};}}
  start.onclick=()=>{if(!start.disabled)return perform('host-start');};stop.onclick=()=>{if(!stop.disabled)return perform('host-stop');};
  startup.onchange=()=>{if(!startup.disabled)return perform('host-set-auto-start',{enabled:startup.checked});};
  login.onchange=()=>{if(!login.disabled)return perform('host-set-login-startup',{enabled:login.checked});};
  permissions.onclick=()=>api.request('host-open-permissions');close.onclick=cancel;
  const dispose=()=>{disposed=true;generation++;clearInterval(timer);window.removeEventListener('focus',refresh);};
  window.addEventListener('focus',refresh);window.addEventListener('beforeunload',dispose,{once:true});
  render();const ready=refresh();timer=setInterval(()=>{void refresh();},1500);
  return {ready,refresh,close:dispose};
}
