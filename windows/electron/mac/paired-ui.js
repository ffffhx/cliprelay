import {mountFiles} from './file-ui.js';
import {mountBitrate} from './bitrate-ui.js';
import {mountDisplays} from './display-ui.js';
import {mountInput} from './input-ui.js';
import {mountPrivacy} from './privacy-ui.js';
import {mountAudioMute} from './audio-mute-ui.js';
import {mountSessionLock} from './session-lock-ui.js';
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
  const bitrate=mountBitrate(remote,async(action,data)=>{state=await api.request(action,data);render();return state;});
  const displays=mountDisplays(remote,async(action,data)=>{state=await api.request(action,data);render();return state;});
  const input=mountInput(remote,async(action,data)=>{state=await api.request(action,data);render();return state;});
  const privacy=mountPrivacy(remote,async(action,data)=>{state=await api.request(action,data);render();return state;});
  const audioMute=mountAudioMute(remote,async(action,data)=>{state=await api.request(action,data);render();return state;});
  const sessionLock=mountSessionLock(remote,async(action,data)=>{state=await api.request(action,data);render();return state;});
  const files=mountFiles(root,async(action,data)=>{state=await api.request(action,data);render();return state;});
  const terminalSection=element('section'),terminalOpen=element('button','打开远程终端');terminalOpen.onclick=()=>change('terminal-open');terminalSection.append(element('h2','终端'),element('p','在独立窗口中使用电脑的 PowerShell 或 CMD，支持多会话与断线续接。'),terminalOpen);root.append(terminalSection);
  const form=element('form');form.append(element('h2','添加电脑'));
  function field(title,placeholder,value=''){const label=element('label',title),input=element('input');input.placeholder=placeholder;input.value=value;label.append(input);form.append(label);return input;}
  const address=field('电脑地址','IP 或主机名');address.autocomplete='off';address.maxLength=253;
  const port=field('远控端口','48789','48789');port.inputMode='numeric';port.maxLength=5;
  const name=field('电脑名称（可选）','例如：家里的电脑');name.maxLength=128;
  const pair=element('button','发起配对'),cancelPair=element('button','取消配对');cancelPair.type='button';cancelPair.onclick=()=>run(async()=>{state=await api.request('pair-cancel');render();});
  form.append(pair,cancelPair);form.onsubmit=event=>{event.preventDefault();run(async()=>{state=await api.request('pair-start',{address:address.value,port:Number(port.value),label:name.value});render();});};root.append(form);
  const code=element('strong'),message=element('p');code.className='verification';code.setAttribute('aria-live','polite');message.setAttribute('aria-live','polite');root.append(code,message);
  const networkSection=element('section');networkSection.append(element('h2','外网配对'),element('p','在被控电脑的“手机远控 → 外网配对”中生成 8 位配对码。先允许这台电脑接入，再核对远控安全标识。'));
  const networkForm=element('form'),networkCode=element('input');networkCode.placeholder='8 位数字配对码';networkCode.ariaLabel=networkCode.placeholder;networkCode.inputMode='numeric';networkCode.maxLength=8;networkCode.autocomplete='off';
  const networkPair=element('button','连接电脑'),networkCancel=element('button','取消确认');networkCancel.type='button';networkCancel.onclick=()=>change('network-cancel');
  networkForm.append(networkCode,networkPair,networkCancel);networkForm.onsubmit=event=>{event.preventDefault();change('network-claim',{code:networkCode.value.trim()});};
  const networkVerification=element('strong'),networkMessage=element('p'),networkList=element('div');networkVerification.className='verification';networkVerification.setAttribute('aria-live','polite');networkMessage.setAttribute('aria-live','polite');
  networkSection.append(networkForm,networkVerification,networkMessage,networkList);root.append(networkSection);
  const footer=element('div');footer.className='actions';const done=element('button','关闭');done.onclick=close;footer.append(done);root.append(footer);
  let roster='',networkRoster='';
  function render(){
    bitrate.render(state);
    displays.render(state);
    input.render(state);
    privacy.render(state);
    audioMute.render(state);
    sessionLock.render(state);
    files.render(state);
    const key=JSON.stringify(state.hosts);if(key!==roster){roster=key;list.replaceChildren();
      if(!state.hosts.length)list.append(element('p','尚无配对电脑。发起配对后，在电脑端核对验证码并确认。'));
      for(const host of state.hosts){
        const row=element('div');row.className='paired-host';const info=element('div');info.append(element('strong',host.name),element('small',host.overlay?'内置加密网络':host.routeReady===false?'正在等待网络连接':host.address+':'+host.port));
        const choose=element('button',host.selected?'已选择':'选择');choose.disabled=host.selected;choose.onclick=()=>change('paired-select',{id:host.id});
        const toggle=element('button',host.enabled?'暂停收发':'恢复收发');toggle.onclick=()=>change('paired-enable',{id:host.id,enabled:!host.enabled});
        const remove=element('button','移除');remove.title='仅在本机移除；撤销电脑端授权请在电脑的设备列表中操作';remove.onclick=()=>change('paired-remove',{id:host.id});row.append(info,choose,toggle,remove);list.append(row);
      }
    }
    const current=state.hosts.find(host=>host.selected),labels={connected:'加密连接正常',connecting:'正在连接电脑',offline:'电脑离线，正在重连',paused:'收发已暂停',HOST_CERT_CHANGED:'电脑证书已改变，已停止连接，请核实后重新配对',UNPAIRED:'电脑已撤销授权，请重新配对',RELAY_UNPAIRED:'电脑已撤销授权，请重新配对',KEYCHAIN_UNAVAILABLE:'系统钥匙串不可用'};
    if(!busy)status.textContent=Date.now()<feedbackUntil?feedbackText:(current?current.name+' · '+(labels[state.status] || '等待连接'):(state.legacySelected?'当前选择了旧版未加密目标':'请选择配对电脑'));
    send.disabled=busy || !current?.enabled || current?.routeReady===false;
    terminalOpen.disabled=busy || !current?.enabled || current?.routeReady===false;
    const phase=state.viewer?.phase || 'idle',active=['starting','running','recovering','closing'].includes(phase);
    openRemote.disabled=busy || !current?.enabled || current?.routeReady===false || !state.viewer?.available || active;
    stopRemote.disabled=busy || !active || phase==='closing';resolution.disabled=active;
    const viewerErrors={VIEWER_RECOVERY_EXHAUSTED:'暂时无法恢复连接，请检查电脑和网络后重新打开。',UNPAIRED:'电脑已撤销配对，请重新配对。',HOST_CERT_CHANGED:'电脑身份发生变化，请核实后重新配对。',RELAY_UNPAIRED:'电脑已撤销配对，请重新配对。',KEYCHAIN_UNAVAILABLE:'无法解锁配对身份，请检查系统钥匙串。',VIEWER_DECODER_ERROR:'画面解码失败，请调整画质或更新显卡驱动后重新打开。',VIEWER_HOST_ERROR:'电脑结束了远控，请检查电脑状态后重新打开。'};
    const inputError=/^(INPUT_|DISPLAY_)/.test(state.viewer?.error||'')?'画面或输入状态未能确认，远控已结束；请检查电脑后重新打开。':'';
    remoteStatus.textContent=!state.viewer?.available?'请安装包含最新桌面控制组件的 ClipRelay':phase==='error'?(viewerErrors[state.viewer?.error] || inputError || '远控已结束，请检查电脑连接和配对状态。'):({idle:'选择电脑后即可打开桌面。',starting:'正在连接远程桌面…',running:'远控已连接；关闭窗口可结束本次远控。',recovering:'连接中断，正在恢复；可随时结束远控。',closing:'正在结束远控…'})[phase];
    const network=state.network || {available:false,computers:[],pairing:{state:'idle'}},external=network.pairing;
    const networkBusy=['preparing','approval','connecting','waiting'].includes(external.state);
    const pairing=['preparing','waiting'].includes(state.pairing.state);pair.disabled=busy || pairing || networkBusy;cancelPair.disabled=!pairing;
    code.textContent=state.pairing.verification || '';message.textContent=state.pairing.message || '';
    networkPair.disabled=busy || pairing || networkBusy || !network.available;networkCancel.disabled=!networkBusy;networkCode.disabled=networkBusy;
    networkVerification.textContent=external.verification || '';
    const networkErrors={NETWORK_REVOKED:'电脑已撤销外网授权，请重新配对。',NETWORK_PEER_CHANGED:'电脑身份改变，连接已停止。',CANCELLED:'确认已取消；已保存的电脑仍保留。',TIMEOUT:'等待确认超时，请重试。',NETWORK_NOT_READY:'电脑尚未连通，上线后可继续安全配对。',PAIRING_CODE_EXPIRED:'配对码已失效，请在电脑重新生成。',HOST_CERT_CHANGED:'电脑证书改变，请核实身份后重新配对。',KEYCHAIN_UNAVAILABLE:'系统无法解锁配对信息。'};
    networkMessage.textContent=!network.available?'当前安装尚未包含外网连接组件':external.state==='error'?(networkErrors[external.error] || '配对未完成，请检查网络和电脑端版本后重试。'):({idle:'外网配对后，无需填写电脑 IP。',preparing:'正在发送配对请求…',approval:'核对上方 6 位标识，在电脑端允许接入。',connecting:'正在连接电脑…',waiting:'核对上方安全标识，在电脑端确认远控配对。',paired:'配对完成，可在上方选择电脑打开远程桌面。'})[external.state];
    const networkKey=JSON.stringify([network.computers,networkBusy,pairing,busy]);if(networkKey!==networkRoster){networkRoster=networkKey;networkList.replaceChildren();
      for(const computer of network.computers){
        const row=element('div');row.className='paired-host';const info=element('div');
        info.append(element('strong',computer.name),element('small',({ready:computer.path==='connecting'?'等待电脑响应':computer.path==='relay'?'网络已就绪 · 中继':'网络已就绪 · 直连',connecting:'正在连接',waiting:'等待电脑上线',paused:'外网连接已暂停',error:networkErrors[computer.error] || '连接需要处理'})[computer.phase] || '等待连接'));
        const toggle=element('button',computer.enabled?'暂停外网':'恢复外网');toggle.onclick=()=>change('network-enable',{id:computer.id,enabled:!computer.enabled});row.append(info,toggle);
        if(!computer.paired){const finish=element('button','完成安全配对');finish.disabled=networkBusy || pairing || !computer.enabled;finish.onclick=()=>change('network-pair',{id:computer.id});row.append(finish);}
        const remove=element('button','移除');remove.title='移除本机记录；撤销授权请在被控电脑操作';remove.onclick=()=>change('network-remove',{id:computer.id});row.append(remove);networkList.append(row);
      }
    }
  }
  async function run(action){if(busy)return;busy=true;send.disabled=true;pair.disabled=true;try{await action();}catch(error){feedback(error.message);}finally{busy=false;render();}}
  function change(action,data){return run(async()=>{state=await api.request(action,data);render();});}
  let polling=false;const timer=setInterval(async()=>{if(closed || polling || busy)return;polling=true;try{state=await api.request('paired-status');render();}catch{}finally{polling=false;}},750);
  window.addEventListener('beforeunload',()=>{closed=true;clearInterval(timer);},{once:true});render();
}
