import {element} from './elements.js';
export async function mount({root,api,title,status,setStatus,button,close}){
  root.querySelector('.dialog-brand').style.top='16px';
  root.querySelector('.dialog-close').style.cssText='left:502px;right:auto;top:16px;width:32px;height:32px';
  title.textContent='屏幕共享';title.style.cssText='left:24px;top:40px;font:700 26.67px "Segoe UI Variable Display"';
  element(root,'div','选择观看你屏幕的电脑',26,83,470,22,'color:#94a3b8;font-size:12.67px');
  element(root,'div','接收电脑',26,119,250,20,'color:#94a3b8;font-weight:bold');
  const {config}=await api.request('snapshot');
  const peers=config.peers.filter(peer=>!peer.platform || peer.platform==='windows');
  const height=Math.min(3,Math.max(1,peers.length))*84;
  await api.window('resize',{width:560,height:288+height});
  element(root,'div',`${peers.length} 台已添加`,394,119,140,20,'color:#94a3b8;text-align:right;font-size:10.67px');
  const list=element(root,'div',null,24,145,512,height,'overflow:auto');
  let selected=0;
  const rows=[];
  peers.forEach((peer,index)=>{
    const row=element(list,'button','',0,index*84,peers.length>3?490:512,76,'border:1px solid #262c3c;border-radius:10px;background:#171a24;color:#f1f5f9;text-align:left;cursor:pointer');
    row.ariaLabel=peer.name+'，'+peer.address;
    element(row,'span','\uE7F4',18,20,34,36,'font:28px "Segoe MDL2 Assets";color:#60a5fa');
    element(row,'span',peer.name,68,12,peers.length>3?316:338,25,'font:700 14.67px "Microsoft YaHei UI"');
    element(row,'span',peer.address,68,39,peers.length>3?316:338,23,'font:11.33px "Cascadia Mono";color:#94a3b8');
    const mark=element(row,'span','选择',peers.length>3?398:420,25,78,24,'text-align:right;color:#94a3b8;font-size:11.33px');rows.push({row,mark});
    row.onclick=()=>{selected=index;render();};
  });
  function render(){rows.forEach(({row,mark},index)=>{const active=index===selected;row.style.background=active?'#192740':'#171a24';row.style.borderColor=active?'#3b82f6':'#262c3c';row.ariaPressed=String(active);mark.style.color=active?'#60a5fa':'#94a3b8';mark.textContent=active?'✓ 已选择':'选择';});}
  render();
  if(!peers.length){element(list,'div','还没有可共享的电脑',14,6,470,30,'font-size:14.67px;font-weight:bold');element(list,'div','先回到控制中心，添加另一台 Windows 电脑。',14,39,470,25,'color:#94a3b8');}
  status.style.cssText=`position:absolute;left:26px;top:${157+height}px;width:508px;height:46px;white-space:pre-line;color:#94a3b8`;
  setStatus('对方接受后实时观看整个主屏幕，本机在后台共享。\n右键 ClipRelay 托盘图标可查看状态、结束共享。');
  element(root,'div','',24,216+height,512,1,'background:#262c3c');
  button('取消',264,232+height,90,close);
  const start=button('开始共享 →',366,232+height,170,async()=>{
    start.disabled=true;start.textContent='正在启动…';
    try{await api.request('share',{peer:peers[selected]});close();}
    finally{start.disabled=false;start.textContent='开始共享 →';}
  },true);start.disabled=!peers.length;
  root.addEventListener('keydown',event=>{if(event.key==='Enter')start.click();});
  return {error:error=>setStatus(error.message,true)};
}
