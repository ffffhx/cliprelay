import {lightWindow,remoteQueue,listOptions} from './remote-controls.js';
export async function mount(context){
  const {api}=context;const {label,button,list,input}=lightWindow(context);
  label('手机或电脑在外面，也能连接本机',24,22,530,32,'font-size:18.67px;font-weight:bold');
  label('只需在 ClipRelay 内配对，无需注册账号。',24,64,520);
  const status=label('正在读取连接状态…',24,105,350,44);
  let enabled=false,ready=false;
  const toggle=button('开启外网连接','RemoteNetworkToggle',410,101,166,()=>queue.submit({action:enabled?'networkDisable':'networkEnable'}));
  label('在对方 ClipRelay 的“外网配对”中输入配对码',24,156,540);
  const code=input('RemoteNetworkCode',24,190,330,48);code.readOnly=true;code.style.font='700 29.33px Consolas';code.style.textAlign='center';
  const makeCode=button('生成配对码','RemoteNetworkNewCode',376,192,200,()=>queue.submit({action:'networkCode'}));
  const expiry=label('配对码五分钟内有效，只能使用一次。',24,244,540,24);
  label('等待确认的设备',24,281,350,24);const pending=list('RemoteNetworkPending',24,311,330,65);
  const approve=button('允许这台设备','RemoteNetworkApprove',376,311,200,()=>{if(pending.value)queue.submit({action:'networkApprove',id:pending.value});});
  label('已允许的外网设备',24,390,350,24);const peers=list('RemoteNetworkPeers',24,421,330,65);
  const revoke=button('撤销外网连接','RemoteNetworkRevoke',376,421,200,()=>{if(peers.value)queue.submit({action:'networkRevoke',id:peers.value});});
  const message=label('开启后随 ClipRelay 后台运行。首次连接仍需核对两端的远控配对标识。',24,506,552,54);
  const queue=remoteQueue(api,(action,data)=>{
    if(action==='networkStatus'){
      enabled=data.state!=='disabled';ready=!!data.ready;toggle.textContent=enabled?'关闭外网连接':'开启外网连接';status.textContent=ready?'外网连接已就绪':!enabled?'外网连接已关闭':data.error?'正在恢复外网连接…':'正在连接服务…';
      listOptions(pending,data.pending || [],'id',item=>item.name+' · '+item.id.slice(0,6).toUpperCase());listOptions(peers,data.peers || [],'id',item=>item.name);
    }else if(action==='networkCode'){code.value=data.value;expiry.textContent='有效至 '+new Date(data.expires).toLocaleTimeString('zh-CN',{hour12:false});message.textContent='输入配对码后，请核对两端显示的六位标识，再允许连接。';}
    else{
      if(action==='networkApprove' || action==='networkDisable')code.value='';
      message.textContent=({networkApprove:'已允许这台设备。请回到对方设备完成远控配对。',networkRevoke:'已撤销该设备的外网连接。局域网远控授权可在上一页管理。',networkEnable:'正在准备外网连接，就绪后可以生成配对码。',networkDisable:'外网连接已关闭。'})[action] || '';
    }
  },error=>{message.textContent='操作未完成：'+error.message;},busy=>{toggle.disabled=busy;for(const node of [makeCode,approve,revoke])node.disabled=busy || !ready;});
  const timer=setInterval(()=>{if(queue.due)queue.submit({action:'networkStatus'});},200);
  return {dispose(){clearInterval(timer);queue.dispose();},error:error=>{message.textContent=error.message;}};
}
