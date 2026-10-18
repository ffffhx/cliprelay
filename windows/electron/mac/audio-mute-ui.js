export function mountAudioMute(root,request){
  const node=(tag,text)=>{const item=document.createElement(tag);if(text)item.textContent=text;return item;};
  const section=node('section'),enable=node('button','静音电脑扬声器'),disable=node('button','结束远程静音'),status=node('p');
  status.setAttribute('aria-live','polite');
  section.append(node('h3','电脑扬声器静音'),node('p','保留远程声音，静音被控电脑的扬声器；结束后恢复原静音状态，不调整音量。断线或音频连接变化后需重新开启。'),enable,disable,status);root.append(section);
  let state={},viewId='',busy=false,error='';
  const messages={AUDIO_UNSUPPORTED:'当前连接无法在保留远程声音的同时静音电脑扬声器。',AUDIO_NO_SAFE_STREAM:'当前连接不具备保留远程声音的静音条件。',AUDIO_NO_EXCLUSIVE_STREAM:'静音需要这台电脑只有一个远控连接。',AUDIO_BUSY:'静音正在使用或处理中。',AUDIO_NOT_READY:'请等远程画面恢复后再开启静音。',AUDIO_EXPIRED:'远程静音已到期，请确认连接后重新开启。',AUDIO_INVALID_RESPONSE:'电脑返回的静音状态无效。'};
  function render(next){
    state=next.audioMute||{phase:'idle'};
    if(state.viewId!==viewId){viewId=state.viewId||'';error='';}
    enable.disabled=busy||!state.canEnable;disable.disabled=busy||!state.canDisable;
    status.textContent=error||(state.phase==='idle'?'连接远程桌面后可查看静音能力。':state.phase==='loading'?'正在检查电脑音频…':state.phase==='starting'?'正在开启静音，等待电脑确认…':state.phase==='restoring'?'电脑仍在恢复原静音状态，请稍候；连接中断时由电脑继续恢复。':state.active?'电脑已确认扬声器静音。':state.phase==='off'?'未启用远程静音。':messages[state.error]||'电脑静音状态未确认，请检查连接。');
  }
  async function change(enabled){
    if(busy||!(enabled?state.canEnable:state.canDisable))return;
    const expected=viewId;busy=true;error='';render({audioMute:state});
    try{const next=await request('audio-mute-set-enabled',{viewId:expected,enabled});if(expected===viewId)render(next);}
    catch(failure){if(expected===viewId)error=failure.message;}
    finally{busy=false;render({audioMute:state});}
  }
  enable.onclick=()=>change(true);disable.onclick=()=>change(false);
  return {render};
}
