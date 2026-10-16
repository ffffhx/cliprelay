'use strict';
(async()=>{
  const api=window.cliprelayMac;const root=document.getElementById('app');const kind=new URLSearchParams(location.search).get('kind');const data=await api.request('initial');
  const cancel=()=>api.request('cancel');
  if(kind==='alert'){root.className='alert';root.textContent=data.message;return;}
  document.addEventListener('keydown',event=>{if(event.key==='Escape')cancel();});
  if(kind==='host-permissions'){
    const {mount}=await import('./host-permission-ui.js');mount(root,api,cancel,data);return;
  }
  if(kind==='paired'){
    const {mount}=await import('./paired-ui.js');await mount(root,api,cancel,data);return;
  }
  if(kind==='token' || kind==='receiver-token'){
    root.className='token';const title=document.createElement('h1');title.textContent='ClipRelay 访问密钥';
    const message=document.createElement('p');message.textContent=kind==='receiver-token'?'用于旧版局域网接收。密钥不提供加密；留空则不校验发送方。':data.peer.text+' 要求访问密钥，请填写对方设备设置中的密钥。';
    const input=document.createElement('input');input.type='password';input.ariaLabel='访问密钥';input.value=data.token;input.maxLength=4096;
    const actions=document.createElement('div');actions.className='actions';const back=document.createElement('button');back.textContent='取消';back.onclick=cancel;
    const save=document.createElement('button');save.textContent='保存';save.onclick=()=>api.request('save',{token:input.value});actions.append(back,save);root.append(title,message,input,actions);
    document.addEventListener('keydown',event=>{if(event.key==='Enter')save.click();});input.focus();input.select();return;
  }
  const query=document.createElement('input');query.id='query';query.placeholder='选择 ClipRelay 接收设备';query.ariaLabel=query.placeholder;
  const list=document.createElement('div');list.id='choices';list.setAttribute('role','listbox');root.append(query,list);
  let selected=0,visible=[];
  function choose(index){if(visible[index])api.request('select',{id:visible[index].id});}
  function render(){
    const search=query.value.toLocaleLowerCase();visible=data.peers.filter(peer=>peer.text.toLocaleLowerCase().includes(search));selected=Math.min(selected,Math.max(0,visible.length-1));list.replaceChildren();
    visible.forEach((peer,index)=>{const row=document.createElement('button');row.className='choice';row.setAttribute('role','option');row.setAttribute('aria-selected',String(index===selected));row.onclick=()=>choose(index);
      const title=document.createElement('strong');title.textContent=peer.text;const subtitle=document.createElement('small');subtitle.textContent=peer.subText;row.append(title,subtitle);
      if(index<10){const shortcut=document.createElement('span');shortcut.className='shortcut';shortcut.textContent='⌘'+((index+1)%10);row.append(shortcut);}list.append(row);
    });
  }
  query.oninput=()=>{selected=0;render();};
  document.addEventListener('keydown',event=>{
    if(['ArrowDown','ArrowUp','PageDown','PageUp'].includes(event.key)||(event.ctrlKey && ['n','p','v'].includes(event.key))){
      event.preventDefault();const backwards=event.key==='ArrowUp'||event.key==='PageUp'||event.key==='p';
      const page=event.key==='PageDown'||event.key==='PageUp'||event.key==='v';
      if(visible.length)selected=page?Math.max(0,Math.min(visible.length-1,selected+(backwards?-10:10))):(selected+(backwards?-1:1)+visible.length)%visible.length;
      render();list.children[selected]?.scrollIntoView({block:'nearest'});
    }
    else if(event.key==='Enter')choose(selected);
    else if(event.metaKey && /^[0-9]$/.test(event.key)){event.preventDefault();choose(event.key==='0'?9:Number(event.key)-1);}
  });render();query.focus();
})();
