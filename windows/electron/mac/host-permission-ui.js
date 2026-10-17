export function mount(root,api,cancel,initial){
  root.className='host-permissions';let state=initial,pending=false,disposed=false,generation=0;
  const element=(tag,text)=>{const item=document.createElement(tag);item.textContent=text;return item;};
  root.append(element('h1','本机远程访问权限'),element('p','屏幕录制用于传输本机画面，键鼠控制用于接收远程操作。可通过下方按钮分别授权。'));
  const rows={};
  for(const [key,label,detail] of [['screenRecording','屏幕录制','允许读取本机屏幕画面'],['inputControl','键鼠控制','允许在本机执行远程鼠标和键盘操作']]){
    const row=element('section',''),title=element('h2',label),description=element('p',detail),status=element('span','未检查'),button=element('button','前往授权');
    status.setAttribute('aria-live','polite');button.type='button';button.onclick=()=>{if(!button.disabled)return perform('host-permissions-request',{permission:key});};
    row.append(title,description,status,button);root.append(row);rows[key]={status,button};
  }
  root.append(element('p','首次传输这台 Mac 的声音时，macOS 会单独请求录制系统声音，请在系统弹窗中确认。未允许时可能有画面但无声音；此窗口的检查结果仅包含屏幕录制与键鼠控制。'));
  const notice=element('p',''),actions=element('div',''),refresh=element('button','重新检查'),close=element('button','关闭');
  notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');actions.className='permission-actions';
  refresh.onclick=()=>{if(!refresh.disabled)return perform('host-permissions-check');};close.onclick=cancel;actions.append(refresh,close);root.append(notice,actions);
  const errors={HOST_ENGINE_UNAVAILABLE:'此安装包未包含本机远程访问组件。',HOST_ENGINE_INVALID:'本机远程访问组件校验失败，请重新安装完整应用。',HOST_PLATFORM_UNSUPPORTED:'此设备不支持本机远程访问组件。',HOST_PERMISSION_TIMEOUT:'等待超时，请重新检查。',HOST_PERMISSION_CANCELLED:'操作已取消。',HOST_PERMISSIONS_CLOSED:'应用正在退出。'};
  function render(){
    const busy=pending || state.busy || state.checking;
    for(const [key,row] of Object.entries(rows)){
      const value=busy?null:state[key];
      row.status.textContent=value===true?'已允许':value===false?'未允许':'未确认';
      row.button.disabled=!state.available || busy || state.checkedAt==null || value===true;
    }
    refresh.disabled=!state.available || busy;
    notice.textContent=busy?'正在读取权限或等待系统确认…':state.error?(errors[state.error] || '无法确认系统权限，请重新检查。'):state.checkedAt!=null?'已读取当前系统状态。在系统设置中修改后，请重新检查。':'打开此窗口只检查权限。';
  }
  async function perform(action,data){
    if(disposed || pending || !state.available)return;
    const current=++generation;pending=true;render();
    try{
      const result=await api.request(action,data);
      if(disposed || current!==generation)return;
      state=result;
    }catch{
      if(disposed || current!==generation)return;
      state={...state,checking:false,busy:false,screenRecording:null,inputControl:null,checkedAt:null,error:'HOST_PERMISSION_COMMAND_FAILED'};
    }finally{if(!disposed && current===generation){pending=false;render();}}
  }
  const focus=()=>{if(!pending && !state.busy)void perform('host-permissions-check');};
  const stop=()=>{disposed=true;generation++;window.removeEventListener('focus',focus);};
  window.addEventListener('focus',focus);window.addEventListener('beforeunload',stop,{once:true});
  render();const ready=perform('host-permissions-check');
  return {ready,refresh:focus,close:stop};
}
