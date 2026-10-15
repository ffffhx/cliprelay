export function mountSessionLock(root,request){
  const node=(tag,text)=>{const item=document.createElement(tag);if(text)item.textContent=text;return item;};
  const section=node('section'),enable=node('button','本次结束后锁屏'),disable=node('button','取消结束锁屏'),status=node('p');
  status.setAttribute('aria-live','polite');
  section.append(node('h3','结束远控后锁屏'),node('p','仅对本次连接生效。电脑确认远控结束后执行一次锁屏；关闭控制端仍会保留已确认的安排。如需取消，请先等待电脑确认取消。'),enable,disable,status);root.append(section);
  let state={},viewId='',busy=false,error='';
  const messages={LOCK_UPDATE_REQUIRED:'请更新被控电脑后设置结束锁屏。',LOCK_UNSUPPORTED:'当前电脑不支持结束锁屏。',LOCK_NO_EXCLUSIVE_STREAM:'结束锁屏需要这台电脑只有一个远控连接。',LOCK_BUSY:'电脑已有锁屏安排或正在处理请求。',LOCK_NOT_READY:'请等远程画面恢复后再设置结束锁屏。',LOCK_INVALID_RESPONSE:'电脑返回的锁屏状态无效。',LOCK_ALREADY_REQUESTED:'电脑已提交锁屏请求，无法再取消，请等待执行结果。'};
  function render(next){
    state=next.sessionLock||{phase:'idle'};
    if(state.viewId!==viewId){viewId=state.viewId||'';error='';}
    enable.disabled=busy||!state.canArm;disable.disabled=busy||!state.canDisarm;
    status.textContent=error||(state.phase==='idle'?'连接远程桌面后可设置结束锁屏。':state.phase==='loading'?'正在检查锁屏能力…':state.phase==='arming'?'正在安排结束锁屏，等待电脑确认…':state.phase==='cancelling'?'取消尚未确认，电脑仍可能按原安排锁屏。':state.error?messages[state.error]||'锁屏安排状态未确认，电脑仍可能执行已接收的安排。':state.armed?'电脑已确认本次远控结束后锁屏。':state.phase==='requested'?'电脑已提交锁屏请求，正在等待系统确认。':state.phase==='locked'?'系统曾确认本次锁屏已执行；之后手动解锁不会再次锁屏。':state.phase==='failed'?'本次锁屏未获得系统成功确认；请核对电脑状态。':state.phase==='cancelled'?'电脑已取消本次锁屏安排。':state.phase==='off'?'未安排本次结束锁屏。':'锁屏安排状态未确认，电脑仍可能执行已接收的安排。');
  }
  async function change(enabled){
    if(busy||!(enabled?state.canArm:state.canDisarm))return;
    const expected=viewId;busy=true;error='';render({sessionLock:state});
    try{const next=await request('session-lock-set-enabled',{viewId:expected,enabled});if(expected===viewId)render(next);}
    catch(failure){if(expected===viewId)error=failure.message;}
    finally{busy=false;render({sessionLock:state});}
  }
  enable.onclick=()=>change(true);disable.onclick=()=>change(false);
  return {render};
}
