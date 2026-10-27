export async function mount({root,api,title,brand,status,setStatus}){
  title.textContent='远程桌面';brand.textContent='REMOTE DESKTOP';
  status.style.cssText='position:static;margin:0 2px;white-space:pre-wrap';
  const content=document.createElement('div');content.className='remote-home-content';root.append(content);
  const intro=document.createElement('p');intro.className='remote-home-intro';intro.textContent='连接另一台电脑，或让其他设备查看和操作这台电脑。';content.append(intro);
  let alive=true,sharing={Active:false},busy=false;
  function card(heading,description,label,id,action){
    const section=document.createElement('section');section.className='remote-home-card';
    const body=document.createElement('div'),h=document.createElement('h2'),p=document.createElement('p');
    h.textContent=heading;p.textContent=description;body.append(h,p);
    const button=document.createElement('button');button.className='remote-home-action';button.id=id;button.textContent=label;
    button.onclick=async()=>{if(button.disabled || !alive)return;button.disabled=true;setStatus('');try{await action();}catch(error){if(alive)setStatus(error.message,true);}finally{if(alive)button.disabled=false;}};
    section.append(body,button);content.append(section);return {body,button};
  }
  card('控制其他电脑','查看对方桌面、操作键盘鼠标，也可传文件和同步剪贴板。','连接电脑','RemoteHomeClient',()=>api.window('desktop-client'));
  card('允许设备连接','允许手机或电脑连接本机；在这里开启远控、确认配对和管理授权。','连接设置','RemoteHomeHost',()=>api.window('open',{name:'remote-desktop'}));
  const share=card('共享本机屏幕 · 仅观看','邀请局域网内的 Windows 电脑观看主屏幕。对方不能操作键盘鼠标。','选择接收电脑','RemoteHomeShare',async()=>{
    if(!sharing.Active){await api.window('open',{name:'screen-share-picker'});return;}
    busy=true;
    try{await api.request('stop-sharing');update(await api.request('snapshot'));}finally{busy=false;}
  });
  const sharingStatus=document.createElement('p');sharingStatus.id='RemoteHomeSharingStatus';sharingStatus.setAttribute('role','status');share.body.append(sharingStatus);
  content.append(status);
  function update(snapshot){
    if(!alive)return;
    sharing=snapshot.sharing || {Active:false};
    sharingStatus.textContent=sharing.Stage && sharing.Stage!=='idle'?[sharing.Title,sharing.Detail].filter(Boolean).join(' · '):'当前没有共享';
    share.button.textContent=sharing.Active?(sharing.Action || '结束共享'):'选择接收电脑';
    share.button.disabled=busy;share.button.classList.toggle('stop',!!sharing.Active);
  }
  return {update,dispose(){alive=false;},error:error=>setStatus(error.message,true)};
}
