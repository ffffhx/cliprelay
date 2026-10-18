export function mountInput(root,request){
  const node=(tag,text)=>{const item=document.createElement(tag);if(text)item.textContent=text;return item;};
  const section=node('section'),pause=node('button','暂停输入'),resume=node('button','恢复输入'),status=node('p');
  status.setAttribute('aria-live','polite');section.append(node('h3','输入控制'),node('p','暂停后可继续观看画面。切换显示器或断线重连后仍保持暂停，点击恢复输入才继续控制。'),pause,resume,status);root.append(section);
  let state={},viewId='',busy=false,error='';
  function render(next){
    state=next.displays||{};const input=state.input||{phase:'unavailable'};
    if(state.viewId!==viewId){viewId=state.viewId||'';error='';}
    pause.disabled=busy||!input.canPause;resume.disabled=busy||!input.canResume;
    status.textContent=error||(input.phase==='unavailable'?'连接支持此功能的远程电脑后可暂停输入。':input.phase==='pausing'?'正在暂停并释放输入…':input.phase==='resuming'?'正在确认新画面，等待恢复输入…':
      input.manualPaused?'输入保持暂停，画面继续播放。':input.phase==='active'?'输入已开启。':input.phase==='closed'?'远控已结束。':'正在确认画面和输入状态…');
  }
  async function set(paused){
    if(busy||!(paused?state.input?.canPause:state.input?.canResume))return;
    busy=true;error='';const expected=viewId;render({displays:state});
    try{const next=await request('input-set-paused',{viewId:expected,paused});if(expected===viewId)render(next);}
    catch(failure){if(expected===viewId)error=failure.message;}
    finally{busy=false;render({displays:state});}
  }
  pause.onclick=()=>set(true);resume.onclick=()=>set(false);return {render};
}
