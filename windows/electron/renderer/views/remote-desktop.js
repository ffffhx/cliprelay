import {lightWindow,remoteQueue,listOptions} from './remote-controls.js';
export async function mount(context){
  const {api,close}=context;const {label,button,list,input}=lightWindow(context);
  label('手机远控',24,20,300,32,'font-size:24px;font-weight:bold');
  const status=label('正在连接后台服务…',24,62,315);
  let enabled=false,running=false,pairings=[],clients=[],pollIndex=0;
  const toggle=button('开启远控','RemoteDesktopToggle',510,45,140,()=>queue.submit({action:enabled?'disable':'enable'}));
  button('外网配对','RemoteNetworkOpen',354,45,140,()=>api.window('open',{name:'remote-network'}));
  label('手机打开“连接电脑”，会自动发现本机；下方地址仅供手动排查。',24,100,620,28);
  const addresses=input('RemoteDesktopAddresses',24,132,626,58);addresses.readOnly=true;
  const snapshot=await api.request('snapshot');addresses.value=snapshot.addresses.filter(item=>/^\d+\./.test(item.Address)).map(item=>item.Address+':48789').join('    ');
  label('首次配对 · 核对手机上的确认标识，再允许这台手机',24,210,620);
  const pending=list('RemoteDesktopPairings',24,244,420,70);
  const pin=input('RemoteDesktopPin',462,244,188,30);pin.maxLength=4;pin.ariaLabel='手机配对 PIN';
  const verification=label('',462,244,188,30,'font:700 16px Consolas');verification.hidden=true;
  const selection=()=>{const peer=pairings.find(item=>item.id===pending.value);pin.hidden=!!peer?.automatic;verification.hidden=!peer?.automatic;verification.textContent=peer?.verification || '';};pending.onchange=selection;
  const pair=button('授权这台手机','RemoteDesktopPair',462,282,188,()=>{
    const peer=pairings.find(item=>item.id===pending.value);
    if(!peer){message.textContent='请先在手机上点选这台电脑，等待配对请求出现。';return;}
    if(peer.automatic){message.textContent='正在允许这台手机…';queue.submit({action:'lanPairApprove',id:peer.id});return;}
    if(!/^\d{4}$/.test(pin.value)){message.textContent='旧版手机需要输入手机显示的四位 PIN。';return;}
    message.textContent='正在确认配对…';queue.submit({action:'pair',id:peer.id,pin:pin.value,name:peer.name});
  });
  label('已授权的手机',24,337,600);const authorized=list('RemoteDesktopClients',24,370,420,96);
  const revoke=button('撤销选中授权','RemoteDesktopRevoke',462,370,188,()=>{if(authorized.value)queue.submit({action:'unpair',uuid:authorized.value});});
  const disconnect=button('断开当前远控','RemoteDesktopDisconnect',462,422,188,()=>queue.submit({action:'disconnect'}));
  const message=label('配对授权后，手机下次可直接连接。关闭远控会停止接收连接。',24,486,626,50);
  label('内置 Sunshine 远控引擎 · GPLv3 开源组件',24,562,465,26,'color:#696969');button('完成','RemoteDesktopClose',550,554,100,close);
  const queue=remoteQueue(api,(action,data)=>{
    if(action==='status'){enabled=data.enabled;running=data.ready;toggle.textContent=enabled?'关闭远控':'开启远控';status.textContent=running?'远控已开启 · 等待手机连接或正在串流':enabled?'引擎正在启动…':'远控已关闭';}
    else if(action==='pairings'){pairings=data.pairings || [];listOptions(pending,pairings,'id',peer=>(peer.name || 'ClipRelay 手机')+' · '+peer.address);selection();}
    else if(action==='clients'){clients=data.named_certs || [];listOptions(authorized,clients,'uuid',peer=>peer.name);}
    else if(action==='pair'){if(!data.status){message.textContent='配对未完成，请确认 PIN 后重新发起。';return;}pin.value='';message.textContent='配对成功。现在可以在手机上打开电脑桌面。';}
    else message.textContent=({lanPairApprove:'已允许这台手机，正在自动完成配对；以后无需输入地址或 PIN。',unpair:'已撤销选中的手机授权。',disconnect:'已请求断开当前远控。',enable:'正在准备远控。就绪后，在手机“连接电脑”列表中点选本机即可。',disable:'远控已关闭。'})[action] || '';
  },(error,action)=>{message.textContent='操作未完成：'+error.message;if(action==='status')status.textContent='后台服务未就绪，请重新运行 ClipRelay 安装程序。';},busy=>{toggle.disabled=busy;for(const node of [pair,revoke,disconnect])node.disabled=busy || !running;});
  const timer=setInterval(()=>{if(queue.due){pollIndex=(pollIndex+1)%3;queue.submit({action:!running || pollIndex===0?'status':pollIndex===1?'pairings':'clients'});}},150);
  return {dispose(){clearInterval(timer);queue.dispose();},error:error=>{message.textContent=error.message;}};
}
