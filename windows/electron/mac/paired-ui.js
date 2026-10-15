export async function mount(root,api,close,initial){
  root.className='paired';let state=initial,closed=false,busy=false,feedbackText='',feedbackUntil=0;
  const element=(tag,text)=>{const item=document.createElement(tag);if(text)item.textContent=text;return item;};
  root.append(element('h1',state.desktopOnly?'控制其他电脑':'配对电脑 · 加密收发'),element('p',state.desktopOnly?'选择电脑打开远程桌面，也可发送当前剪贴板中的文本或图片。':'选择一台电脑收发。Ctrl+Alt+G 发送选中文本；也可主动发送当前剪贴板中的文本或图片。'));
  const list=element('div');list.className='paired-hosts';list.setAttribute('aria-label','已配对电脑');root.append(list);
  const status=element('p'),send=element('button','发送当前剪贴板');send.onclick=()=>run(async()=>{const result=await api.request('paired-send');feedback(result.message);});root.append(send,status);
  function feedback(value){feedbackText=value;feedbackUntil=Date.now()+5000;status.textContent=value;}
  const remote=element('section');remote.append(element('h2','远程桌面'));
  const resolutionLabel=element('label','画面质量'),resolution=element('select');
  for(const [value,title] of [['720','流畅 · 720p / 30 帧'],['1080','清晰 · 1080p / 60 帧'],['2160','超清 · 4K / 60 帧']]){const option=element('option',title);option.value=value;resolution.append(option);}resolution.value='1080';resolutionLabel.append(resolution);remote.append(resolutionLabel);
  const openRemote=element('button','打开远程桌面'),stopRemote=element('button','结束远控'),remoteStatus=element('p');
  openRemote.onclick=()=>run(async()=>{const preset=resolution.value==='720'?{width:1280,height:720,fps:30,bitrate:6000}:resolution.value==='2160'?{width:3840,height:2160,fps:60,bitrate:35000}:{width:1920,height:1080,fps:60,bitrate:12000};state=await api.request('viewer-open',preset);render();});
  stopRemote.onclick=()=>change('viewer-stop');remote.append(openRemote,stopRemote,remoteStatus);root.append(remote);
  const form=element('form');form.append(element('h2','添加电脑'));
  function field(title,placeholder,value=''){const label=element('label',title),input=element('input');input.placeholder=placeholder;input.value=value;label.append(input);form.append(label);return input;}
  const address=field('电脑地址','IP 或主机名');address.autocomplete='off';address.maxLength=253;
  const port=field('远控端口','48789','48789');port.inputMode='numeric';port.maxLength=5;
  const name=field('电脑名称（可选）','例如：家里的电脑');name.maxLength=128;
  const pair=element('button','发起配对'),cancelPair=element('button','取消配对');cancelPair.type='button';cancelPair.onclick=()=>run(async()=>{state=await api.request('pair-cancel');render();});
  form.append(pair,cancelPair);form.onsubmit=event=>{event.preventDefault();run(async()=>{state=await api.request('pair-start',{address:address.value,port:Number(port.value),label:name.value});render();});};root.append(form);
  const code=element('strong'),message=element('p');code.className='verification';code.setAttribute('aria-live','polite');message.setAttribute('aria-live','polite');root.append(code,message);
  const footer=element('div');footer.className='actions';const done=element('button','关闭');done.onclick=close;footer.append(done);root.append(footer);
  let roster='';
  function render(){
    const key=JSON.stringify(state.hosts);if(key!==roster){roster=key;list.replaceChildren();
      if(!state.hosts.length)list.append(element('p','尚无配对电脑。发起配对后，在电脑端核对验证码并确认。'));
      for(const host of state.hosts){
        const row=element('div');row.className='paired-host';const info=element('div');info.append(element('strong',host.name),element('small',host.address+':'+host.port));
        const choose=element('button',host.selected?'已选择':'选择');choose.disabled=host.selected;choose.onclick=()=>change('paired-select',{id:host.id});
        const toggle=element('button',host.enabled?'暂停收发':'恢复收发');toggle.onclick=()=>change('paired-enable',{id:host.id,enabled:!host.enabled});
        const remove=element('button','移除');remove.title='仅在本机移除；撤销电脑端授权请在电脑的设备列表中操作';remove.onclick=()=>change('paired-remove',{id:host.id});row.append(info,choose,toggle,remove);list.append(row);
      }
    }
    const current=state.hosts.find(host=>host.selected),labels={connected:'加密连接正常',connecting:'正在连接电脑',offline:'电脑离线，正在重连',paused:'收发已暂停',HOST_CERT_CHANGED:'电脑证书已改变，已停止连接，请核实后重新配对',UNPAIRED:'电脑已撤销授权，请重新配对',RELAY_UNPAIRED:'电脑已撤销授权，请重新配对',KEYCHAIN_UNAVAILABLE:'系统钥匙串不可用'};
    if(!busy)status.textContent=Date.now()<feedbackUntil?feedbackText:(current?current.name+' · '+(labels[state.status] || '等待连接'):(state.legacySelected?'当前选择了旧版未加密目标':'请选择配对电脑'));
    send.disabled=busy || !current?.enabled;
    const phase=state.viewer?.phase || 'idle',active=['starting','running','closing'].includes(phase);
    openRemote.disabled=busy || !current?.enabled || !state.viewer?.available || active;
    stopRemote.disabled=busy || !active || phase==='closing';resolution.disabled=active;
    remoteStatus.textContent=!state.viewer?.available?'当前安装尚未包含桌面控制组件':({idle:'选择电脑后即可打开桌面。',starting:'正在打开远控窗口…',running:'远控窗口已打开；关闭窗口可结束本次远控。',closing:'正在结束远控…',error:'远控已结束，请检查电脑连接和配对状态。'})[phase];
    const pairing=['preparing','waiting'].includes(state.pairing.state);pair.disabled=busy || pairing;cancelPair.disabled=!pairing;
    code.textContent=state.pairing.verification || '';message.textContent=state.pairing.message || '';
  }
  async function run(action){if(busy)return;busy=true;send.disabled=true;pair.disabled=true;try{await action();}catch(error){feedback(error.message);}finally{busy=false;render();}}
  function change(action,data){return run(async()=>{state=await api.request(action,data);render();});}
  let polling=false;const timer=setInterval(async()=>{if(closed || polling || busy)return;polling=true;try{state=await api.request('paired-status');render();}catch{}finally{polling=false;}},750);
  window.addEventListener('beforeunload',()=>{closed=true;clearInterval(timer);},{once:true});render();
}
