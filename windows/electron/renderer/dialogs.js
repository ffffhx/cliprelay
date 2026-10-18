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
    if ((existing?.pairedOwner || !existing || params.get('paired')==='1') && params.get('legacy')!=='1') {
      const peer=existing || {id:crypto.randomUUID().replaceAll('-',''),name:'',enabled:true};
      const card=document.createElement('div');card.className='dialog-card';card.style.cssText='left:24px;top:82px;width:452px;height:286px';root.append(card);
      const name=field(card,'peer-name','设备名称',18,14,416,peer.name);
      const label=document.createElement('label');label.textContent='已配对的接收设备';label.htmlFor='paired-receiver';label.className='field-label';label.style.cssText='left:18px;top:78px';card.append(label);
      const select=document.createElement('select');select.id='paired-receiver';select.className='field';select.style.cssText='left:18px;top:98px;width:416px;height:34px';card.append(select);
      const explanation=document.createElement('div');explanation.textContent='通过配对加密连接发送文本和截图。手机开启接收后可跨网使用，收到确认才显示送达。';explanation.style.cssText='position:absolute;left:18px;right:18px;top:150px;color:#94a3b8;font-size:12px;line-height:20px';card.append(explanation);
      const enabled=document.createElement('input');enabled.type='checkbox';enabled.id='paired-enabled';enabled.checked=peer.enabled;enabled.style.cssText='position:absolute;left:18px;top:211px';card.append(enabled);
      const enabledLabel=document.createElement('label');enabledLabel.textContent='加入广播';enabledLabel.htmlFor=enabled.id;enabledLabel.style.cssText='position:absolute;left:44px;top:214px;font-size:12px';card.append(enabledLabel);
      let peers=[];
      try {const result=await api.request('paired-peers');if(!result.ok)throw new Error('配对设备暂不可用');peers=result.peers || [];}
      catch {setStatus('请先开启电脑的“手机远控”并完成配对。',true);}
      if(peer.pairedOwner && !peers.some(p=>p.owner===peer.pairedOwner))peers.push({owner:peer.pairedOwner,name:peer.name,online:false});
      if(!peers.length){const option=document.createElement('option');option.value='';option.textContent='暂无已配对设备';select.append(option);}
      for(const item of peers){const option=document.createElement('option');option.value=item.owner;option.textContent=`${item.name} · ${item.online?'接收已开启':'等待手机开启接收'}`;select.append(option);}
      if(peer.pairedOwner)select.value=peer.pairedOwner;
      const rename=()=>{if(!existing || !name.value)name.value=(peers.find(p=>p.owner===select.value)?.name || '').slice(0,32);};select.onchange=rename;rename();
      const candidate=()=>{if(!/^[0-9a-f]{64}$/.test(select.value))throw new Error('请先在手机上完成远控配对并开启接收。');return {...peer,name:name.value,transport:'paired',pairedOwner:select.value,address:'',port:config.port,accessToken:'',enabled:enabled.checked,requiresAuth:true,platform:'android'};};
      status.style.cssText='position:absolute;left:42px;top:330px;width:266px;height:28px;color:#94a3b8;font-size:10.67px';
      const probe=button('检测设备',350,324,108,async()=>{probe.disabled=true;try{const normalized=await api.request('normalize-peer',candidate());const values=await api.request('probe',{peers:[{...normalized,enabled:true}]});const delivery=Array.isArray(values)?values[0]:values;if(!delivery.Success)throw new Error(delivery.ErrorMessage || '尚未收到接收确认');setStatus('加密连接和接收确认正常');}finally{probe.disabled=false;}});probe.style.height='34px';
      button('手机远控',26,390,92,async()=>{await api.window('open',{name:'remote-desktop'});close();});
      if(!existing)button('旧版兼容',128,390,92,()=>api.window('peer-mode',{mode:'legacy'}));
      button('取消',282,390,92,close);
      button('保存设备',384,390,92,async()=>{const normalized=await api.request('normalize-peer',candidate());const current=await api.request('snapshot');const list=current.config.peers;const index=list.findIndex(p=>p.id===peer.id);if(index>=0)list[index]=normalized;else{if(list.length>=16)throw new Error('最多可添加 16 台设备。');list.push(normalized);}await api.request('patch',{peers:list,expectedRevision:current.revision});close();},true);
      return result;
    }
    const peer=existing || {id:crypto.randomUUID().replaceAll('-',''),name:'',address:'',port:config.port,accessToken:'',enabled:true,requiresAuth:false,platform:''};
    title.textContent='旧版局域网接收设备';
    const card=document.createElement('div');card.className='dialog-card';card.style.cssText='left:24px;top:82px;width:452px;height:286px';root.append(card);
    const name=field(card,'peer-name','设备名称',18,14,416,peer.name);
    const address=field(card,'peer-address','局域网地址',18,78,270,peer.address);
    const port=field(card,'peer-port','端口',306,78,128,peer.port);
    const token=field(card,'peer-token','访问密钥（这台目标设备）',18,142,318,peer.accessToken,true);
    const reveal=button('显示',370,244,88,()=>{token.type=token.type==='password'?'text':'password';reveal.textContent=token.type==='password'?'显示':'隐藏';});reveal.style.cssText+=';height:34px;--button-fill:#202534;font-size:11.33px';
    const label=document.createElement('span');label.textContent='加入广播';label.style.cssText='position:absolute;left:18px;top:214px;font-weight:bold;font-size:12px';card.append(label);
    const enabled=document.createElement('button');enabled.className='toggle';enabled.setAttribute('role','switch');enabled.ariaLabel='加入广播';enabled.setAttribute('aria-checked',String(peer.enabled));enabled.style.cssText='position:absolute;left:125px;top:214px;width:44px;height:24px;--height:24px';enabled.onclick=()=>enabled.setAttribute('aria-checked',String(enabled.getAttribute('aria-checked')!=='true'));card.append(enabled);
    const legacy=document.createElement('input');legacy.type='checkbox';legacy.id='legacy-allowed';legacy.checked=peer.legacyAllowed===true;legacy.style.cssText='position:absolute;left:210px;top:214px';card.append(legacy);
    const legacyLabel=document.createElement('label');legacyLabel.htmlFor=legacy.id;legacyLabel.textContent='允许旧版未加密发送';legacyLabel.style.cssText='position:absolute;left:234px;top:214px;font-size:11px;color:#fbbf24';card.append(legacyLabel);
    status.style.cssText='position:absolute;left:42px;top:330px;width:266px;height:28px;color:#94a3b8;font-size:10.67px';setStatus('旧版 HTTP 兼容连接不加密，仅用于可信局域网。');
    const candidate=()=>{
      if(!/^\d+$/.test(port.value.trim()))throw new Error('设备端口必须是整数。');
      return {...peer,name:name.value,address:address.value,port:Number(port.value),accessToken:token.value,enabled:enabled.getAttribute('aria-checked')==='true',transport:'legacy',pairedOwner:'',legacyAllowed:legacy.checked};
    };
    const probe=button('检测设备',350,324,108,async()=>{
      const data=candidate();probe.disabled=true;probe.textContent='检测中';
      try{const normalized=await api.request('normalize-peer',data);const results=await api.request('probe',{peers:[{...normalized,enabled:true}]});const delivery=Array.isArray(results)?results[0]:results;if(!delivery.Success)throw new Error(delivery.ErrorMessage || '发送失败');setStatus('链路可用 · '+new Date().toLocaleTimeString('zh-CN',{hour12:false}));status.style.color='#10b981';}
      finally{probe.disabled=false;probe.textContent='检测设备';}
    });probe.style.cssText+=';height:34px;--button-fill:#202534;color:#60a5fa;font-size:11.33px';
    button('取消',282,390,92,close);
    button('配对加密',26,390,108,()=>api.window('peer-mode',{mode:'paired'}));
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
