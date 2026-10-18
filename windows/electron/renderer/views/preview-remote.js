import {element} from './elements.js';
export async function mount({root,api,title,status,setStatus,button}){
  root.querySelector('.dialog-brand').style.cssText='left:24px;top:14px;font-weight:400';
  root.querySelector('.dialog-close').style.cssText='left:424px;right:auto;top:16px;width:32px;height:32px';
  title.textContent='手机翻页';title.style.cssText='left:22px;top:38px;font:26.67px "Segoe UI Variable Display"';
  element(root,'div','电脑遥控，页码与手机同步',24,77,410,22,'color:#94a3b8');
  const {config}=await api.request('snapshot');const devices=config.peers.filter(peer=>!['windows','mac','macos'].includes(peer.platform));
  const picker=element(root,'select','',24,112,432,30,'background:#202534;color:#f1f5f9;border:0;font:13.33px "Microsoft YaHei UI"');picker.ariaLabel='选择手机';
  for(const [index,device] of devices.entries()){const option=document.createElement('option');option.value=index;option.textContent=`${device.name} · ${device.pairedOwner?'加密配对':device.address}`;picker.append(option);}
  if(!devices.length){const option=document.createElement('option');option.textContent='尚未添加手机';picker.append(option);picker.disabled=true;}
  const card=element(root,'div','',24,154,432,96,'border:1px solid #262c3c;border-radius:10px;background:#171a24');
  const phase=element(card,'div','正在连接手机',14,6,404,24,'text-align:center;color:#94a3b8');
  const page=element(card,'div','— / —',14,29,404,57,'text-align:center;font:37.33px "Cascadia Mono"');
  status.style.cssText='position:absolute;left:24px;top:319px;width:432px;height:38px;color:#94a3b8';
  element(root,'div','← 上一页看更早内容 · 下一页看更新内容 →',24,367,432,20,'color:#94a3b8;font-size:10.67px');
  let alive=true,generation=0,command=false,polling=false,state=null,legacy=false,awaiting=false,nextPoll=0;
  const previous=button('← 上一页',24,264,210,()=>navigate('previous'));
  const next=button('下一页 →',246,264,210,()=>navigate('next'),true);previous.style.height=next.style.height='44px';
  previous.style.setProperty('--button-fill','#202534');previous.style.color='#f1f5f9';previous.style.fontSize=next.style.fontSize='13.33px';
  setStatus('正在读取手机当前页码…');
  function buttons(){const ready=!command && !awaiting;const active=state?.active && !state.moving;previous.disabled=!ready || !(legacy || active && state.page<state.pageCount);next.disabled=!ready || !(legacy || active && state.page>1);}
  function clear(title,detail,error=false){state=null;legacy=false;awaiting=false;page.textContent='— / —';phase.textContent=title;phase.style.color=error?'#f43f5e':'#94a3b8';setStatus(detail,error);buttons();}
  async function navigate(direction){
    if((direction==='previous'?previous:next).disabled || !alive)return;
    command=true;awaiting=true;generation++;picker.disabled=true;phase.textContent='正在翻页';setStatus('等待手机确认当前页码…');buttons();
    try{
      const response=await api.request('preview-navigate',{peer:devices[Number(picker.value)],direction});if(!alive)return;
      const result=Array.isArray(response)?response[0]:response;
      if(!result.Success)clear('未能翻页',({401:'访问密钥不匹配，请检查设备设置。',404:'请更新手机端 ClipRelay 后重试。',409:'请让手机停留在前台全屏预览，稍后重试。'})[result.StatusCode] || '手机暂时无法连接，正在尝试恢复…',true);
    }catch{if(alive)clear('未能翻页','手机暂时无法连接，正在尝试恢复…',true);}
    finally{command=false;generation++;picker.disabled=!devices.length;nextPoll=0;buttons();}
  }
  async function poll(){
    if(!alive || polling || command || !devices.length || document.hidden || Date.now()<nextPoll)return;
    if(devices[Number(picker.value)].pairedOwner){clear('暂不支持加密设备翻页','这台设备使用加密配对接收。当前请在设备上翻页。');nextPoll=Date.now()+2000;return;}
    polling=true;const version=generation;
    try{
      const result=await api.request('preview-state',{peer:devices[Number(picker.value)]});if(!alive || version!==generation)return;
      if(result.Success){
        const value=JSON.parse(result.ResponseBody);
        if(typeof value.active!=='boolean' || typeof value.moving!=='boolean')throw new Error('Invalid state');
        if(value.active){
          if(!Number.isInteger(value.page)||!Number.isInteger(value.pageCount)||value.page<1||value.page>value.pageCount||!['text','image'].includes(value.contentType))throw new Error('Invalid page');
          state=value;legacy=false;awaiting=false;page.textContent=`${value.page} / ${value.pageCount}`;page.ariaLabel=`第 ${value.page} 页，共 ${value.pageCount} 页`;
          phase.textContent=value.moving?'正在翻页':`手机正在阅读 · ${value.contentType==='image'?'图片':'文本'}`;phase.style.color='#38bdf8';
          setStatus(value.moving?'正在同步手机翻页位置…':value.pageCount===1?'只有这一页，收到新内容后会自动更新。':value.page===1?'已是最新内容 · 页码与手机实时同步':value.page===value.pageCount?'已是最早内容 · 页码与手机实时同步':'页码与手机实时同步');
        }else clear('等待手机打开预览','请在手机上点开一条文本或图片，并保持全屏预览。');
      }else if(result.StatusCode===404){clear('手机端需要更新','当前手机可继续翻页；更新手机端后可显示实时页码。');legacy=true;}
      else if(result.StatusCode===401)clear('访问密钥不匹配','请检查这台手机在设备设置中的访问密钥。',true);
      else clear('手机未连接','请确认手机已开始接收，且两端处于同一局域网。',true);
      nextPoll=Date.now()+600;buttons();
    }catch{if(alive && version===generation){clear('无法读取页码','手机返回的状态无法识别，请更新手机端后重试。',true);nextPoll=Date.now()+2000;}}
    finally{polling=false;}
  }
  picker.onchange=()=>{generation++;nextPoll=0;clear('正在连接手机','正在读取手机当前页码…');};
  document.addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();navigate(event.key==='ArrowLeft'?'previous':'next');}});
  buttons();const timer=setInterval(poll,100);poll();
  return {dispose(){alive=false;generation++;clearInterval(timer);},error:error=>setStatus(error.message,true)};
}
