// Each window is migrated against the corresponding native layout and event
// contract. Shared controls keep fonts, dimensions, focus and keyboard behavior.
export async function openDialog(view,root,api,params){
  const close=()=>api.window('close');
  const title=document.createElement('div');title.className='dialog-title drag';
  const brand=document.createElement('div');brand.className='dialog-brand drag';brand.textContent='CLIP / RELAY';
  const exit=document.createElement('button');exit.className='dialog-close';exit.textContent='×';exit.ariaLabel='关闭';exit.onclick=close;
  root.append(brand,title,exit);
  function field(parent,name,label,x,y,w,value='',password=false){
    const caption=document.createElement('label');caption.className='field-label';caption.textContent=label;caption.htmlFor=name;caption.style.cssText=`left:${x}px;top:${y}px`;
    const input=document.createElement('input');input.id=name;input.className='field';input.value=value;input.type=password?'password':'text';input.style.cssText=`left:${x}px;top:${y+20}px;width:${w}px;height:34px`;parent.append(caption,input);return input;
  }
  function button(label,x,y,w,action,primary=false){const b=document.createElement('button');b.textContent=label;b.className='standard-button'+(primary?' primary':'');b.style.cssText=`left:${x}px;top:${y}px;width:${w}px`;b.onclick=()=>Promise.resolve(action()).catch(error=>setStatus(error.message,true));root.append(b);return b;}
  const status=document.createElement('div');status.className='dialog-status';status.style.cssText='position:absolute;left:26px;right:26px;top:352px;color:#94a3b8;white-space:pre-wrap';root.append(status);
  const setStatus=(value,error=false)=>{status.textContent=value;status.style.color=error?'#f43f5e':'#94a3b8';};
  const result={error:error=>setStatus(error.message,true)};
  document.addEventListener('keydown',event=>{if(event.key==='Escape')close();});
  if(view==='peer-editor'){
    title.textContent='接收设备';brand.textContent='RELAY DESTINATION';
    const {config}=await api.request('snapshot');
    const existing=config.peers.find(peer=>peer.id===params.get('peerId'));
    const peer=existing || {id:crypto.randomUUID().replaceAll('-',''),name:'',address:'',port:config.port,accessToken:'',enabled:true,requiresAuth:false,platform:''};
    const card=document.createElement('div');card.className='dialog-card';card.style.cssText='left:24px;top:82px;width:452px;height:286px';root.append(card);
    const name=field(card,'peer-name','设备名称',18,14,416,peer.name);
    const address=field(card,'peer-address','局域网地址',18,78,270,peer.address);
    const port=field(card,'peer-port','端口',306,78,128,peer.port);
    const token=field(card,'peer-token','访问密钥（这台目标设备）',18,142,318,peer.accessToken,true);
    const reveal=button('显示',370,244,88,()=>{token.type=token.type==='password'?'text':'password';reveal.textContent=token.type==='password'?'显示':'隐藏';});reveal.style.cssText+=';height:34px;--button-fill:#202534;font-size:11.33px';
    const label=document.createElement('span');label.textContent='加入广播';label.style.cssText='position:absolute;left:18px;top:214px;font-weight:bold;font-size:12px';card.append(label);
    const enabled=document.createElement('button');enabled.className='toggle';enabled.setAttribute('role','switch');enabled.ariaLabel='加入广播';enabled.setAttribute('aria-checked',String(peer.enabled));enabled.style.cssText='position:absolute;left:125px;top:214px;width:44px;height:24px;--height:24px';enabled.onclick=()=>enabled.setAttribute('aria-checked',String(enabled.getAttribute('aria-checked')!=='true'));card.append(enabled);
    status.style.cssText='position:absolute;left:42px;top:330px;width:266px;height:22px;color:#94a3b8;font-size:10.67px';setStatus('保存前可先检测该设备');
    const candidate=()=>{
      if(!/^\d+$/.test(port.value.trim()))throw new Error('设备端口必须是整数。');
      return {...peer,name:name.value,address:address.value,port:Number(port.value),accessToken:token.value,enabled:enabled.getAttribute('aria-checked')==='true'};
    };
    const probe=button('检测设备',350,324,108,async()=>{
      const data=candidate();probe.disabled=true;probe.textContent='检测中';
      try{const normalized=await api.request('normalize-peer',data);const results=await api.request('probe',{peers:[{...normalized,enabled:true}]});const delivery=Array.isArray(results)?results[0]:results;if(!delivery.Success)throw new Error(delivery.ErrorMessage || '发送失败');setStatus('链路可用 · '+new Date().toLocaleTimeString('zh-CN',{hour12:false}));status.style.color='#10b981';}
      finally{probe.disabled=false;probe.textContent='检测设备';}
    });probe.style.cssText+=';height:34px;--button-fill:#202534;color:#60a5fa;font-size:11.33px';
    button('取消',282,390,92,close);
    const save=button('保存设备',384,390,92,async()=>{
      const normalized=await api.request('normalize-peer',candidate());const current=await api.request('snapshot');
      const peers=current.config.peers;const index=peers.findIndex(item=>item.id===peer.id);
      if(index>=0)peers[index]=normalized;else{if(peers.length>=16)throw new Error('最多可添加 16 台设备。');peers.push(normalized);}
      await api.request('patch',{peers,expectedRevision:current.revision});close();
    },true);
    save.style.fontSize='12.67px';
    root.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();save.click();}});
    return result;
  }
  // Additional windows use the same native RPC transport; their renderers are
  // kept in independent modules so lifecycle and polling remain window-scoped.
  const module=await import('./views/'+view+'.js');
  return module.mount({root,api,title,brand,status,setStatus,button,field,close});
}
