export function mount(root,api,cancel,initial){
  root.className='host-settings';let state=initial,disposed=false,pending=false,refreshing=false,timer=null,noticeText='',generation=0;
  const confirmations=new Map();
  const element=(tag,text='')=>{const node=document.createElement(tag);node.textContent=text;return node;};
  const title=element('h1','本机远程访问'),status=element('p'),controls=element('div'),start=element('button','启动远程访问'),stop=element('button','停止远程访问');
  const permissions=element('button','检查系统权限'),close=element('button','关闭'),notice=element('p'),requests=element('div');
  status.setAttribute('role','status');notice.setAttribute('aria-live','polite');controls.className='host-actions';
  controls.append(start,stop,permissions,close);root.append(title,status,controls,
    element('p','启动后，可在同一局域网的另一台设备中添加这台 Mac，再在此处核对验证码。关闭此窗口后仍允许连接，点击“停止远程访问”可结束连接。'),
    element('p','当前支持远程画面与键鼠控制。本机作为被控端时，文件、剪贴板同步、远程终端、语音及隐私控制暂不可用。'),notice,requests);
  const errors={HOST_UNAVAILABLE:'此安装包未包含完整的本机远程访问组件。',HOST_PERMISSION_REQUIRED:'请先允许屏幕录制和键鼠控制。',HOST_KEYCHAIN_UNAVAILABLE:'系统钥匙串不可用，请稍后重试。',HOST_PAIR_STALE:'这次请求已过期或已处理，请核对当前请求。',HOST_PAIR_CLOSED:'远程访问已停止。',HOST_PAIR_TIMEOUT:'读取配对请求超时，请重试。',HOST_PAIR_UNAVAILABLE:'暂时无法读取配对请求，请重试。',HOST_ENGINE_EXITED:'远程画面组件已退出。',HOST_COMPANION_EXITED:'远程连接组件已退出。'};
  function render(){
    status.textContent=({stopped:'远程访问已停止',starting:'正在启动远程访问…',running:'远程访问已启动',stopping:'正在停止远程访问…',failed:'远程访问未能运行',closed:'应用正在退出'})[state.phase] || '无法确认远程访问状态';
    start.disabled=pending || !state.available || !['stopped','failed'].includes(state.phase);
    stop.disabled=pending || !state.available || !['starting','running'].includes(state.phase);
    notice.textContent=noticeText || (state.error?(errors[state.error] || '无法完成操作，请检查权限后重试。'):'');
    requests.replaceChildren();const live=new Set();
    for(const request of state.requests || []){
      const key=request.id+':'+request.generation;live.add(key);
      const row=element('section'),name=element('h2',request.name),verification=element('strong',request.verification),label=element('label'),checkbox=element('input');
      checkbox.type='checkbox';checkbox.checked=confirmations.get(key)===true;checkbox.disabled=pending || request.state!=='waiting';
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
  }
  async function refresh(){
    if(disposed || refreshing || pending)return;refreshing=true;const current=generation;
    try{const result=await api.request('host-status');if(!disposed && current===generation){state=result;render();}}
    catch{if(!disposed && current===generation){state={...state,requests:[],error:'HOST_PAIR_UNAVAILABLE'};render();}}
    finally{refreshing=false;}
  }
  async function perform(action,data){
    if(disposed || pending)return;generation++;pending=true;noticeText='';render();
    try{
      const result=await api.request(action,data);if(disposed)return;state=result;
      if(action==='host-pair-approve')noticeText='已允许这次请求，请在对方设备完成连接。';
      if(action==='host-pair-reject')noticeText='已拒绝这次请求。';
    }catch{if(!disposed){noticeText='操作未完成，请刷新并核对当前请求。';await refreshAfterAction();}}
    finally{if(!disposed){pending=false;render();}}
  }
  async function refreshAfterAction(){try{state=await api.request('host-status');}catch{state={...state,requests:[],error:'HOST_PAIR_UNAVAILABLE'};}}
  start.onclick=()=>{if(!start.disabled)return perform('host-start');};stop.onclick=()=>{if(!stop.disabled)return perform('host-stop');};
  permissions.onclick=()=>api.request('host-open-permissions');close.onclick=cancel;
  const dispose=()=>{disposed=true;generation++;clearInterval(timer);window.removeEventListener('focus',refresh);};
  window.addEventListener('focus',refresh);window.addEventListener('beforeunload',dispose,{once:true});
  render();const ready=refresh();timer=setInterval(()=>{void refresh();},1500);
  return {ready,refresh,close:dispose};
}
