export function mountPrivacy(root,request){
  const node=(tag,text)=>{const item=document.createElement(tag);if(text)item.textContent=text;return item;};
  const section=node('section'),enable=node('button','开启隐私屏'),disable=node('button','恢复本机显示'),status=node('p');
  status.setAttribute('aria-live','polite');
  section.append(node('h3','隐私屏'),node('p','遮住被控电脑的本机屏幕，远程画面保持可见。连接中断后自动恢复；重新连接需再次开启。电脑前可按 Ctrl+Alt+Shift+P 恢复显示。'),enable,disable,status);root.append(section);
  let state={},viewId='',busy=false,error='';
  const messages={PRIVACY_UNSUPPORTED:'当前电脑不支持隐私屏，请检查电脑端版本。',PRIVACY_DESKTOP_UNAVAILABLE:'电脑桌面暂时无法开启隐私屏。',PRIVACY_NO_EXCLUSIVE_STREAM:'隐私屏需要这台电脑只有一个远控连接。',PRIVACY_BUSY:'隐私屏正在使用或处理中。',PRIVACY_NOT_READY:'请等远程画面恢复后再开启隐私屏。',PRIVACY_EXPIRED:'隐私屏已到期，请确认画面后重新开启。',PRIVACY_INVALID_RESPONSE:'电脑返回的隐私屏状态无效。'};
  function render(next){
    state=next.privacy||{phase:'idle'};
    if(state.viewId!==viewId){viewId=state.viewId||'';error='';}
    enable.disabled=busy||!state.canEnable;disable.disabled=busy||!state.canDisable;
    status.textContent=error||(state.phase==='idle'?'连接远程桌面后可开启隐私屏。':state.phase==='loading'?'正在检查隐私屏…':state.phase==='starting'?'正在开启，等待电脑确认…':state.phase==='restoring'?'正在请求恢复本机显示；断线时电脑会在授权到期后自动恢复。':state.active?'电脑已确认隐私屏开启。':state.phase==='off'?'隐私屏未开启。':messages[state.error]||'隐私屏状态未确认，请检查连接。');
  }
  async function change(enabled){
    if(busy||!(enabled?state.canEnable:state.canDisable))return;
    const expected=viewId;busy=true;error='';render({privacy:state});
    try{const next=await request('privacy-set-enabled',{viewId:expected,enabled});if(expected===viewId)render(next);}
    catch(failure){if(expected===viewId)error=failure.message;}
    finally{busy=false;render({privacy:state});}
  }
  enable.onclick=()=>change(true);disable.onclick=()=>change(false);
  return {render};
}
