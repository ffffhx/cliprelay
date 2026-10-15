export function mountDisplays(root,request){
  const node=(tag,text)=>{const item=document.createElement(tag);if(text)item.textContent=text;return item;};
  const section=node('section'),label=node('label','显示器'),select=node('select'),apply=node('button','切换显示器'),status=node('p');
  select.ariaLabel='远程显示器';label.append(select);status.setAttribute('aria-live','polite');
  section.append(node('h3','显示器'),node('p','切换时会暂停输入，并保留你的手动暂停设置。'),label,apply,status);root.append(section);
  let state={},viewId='',roster='',busy=false,error='',dirty=false;
  select.onchange=()=>{dirty=true;error='';};
  function render(next){
    state=next.displays||{phase:'idle',canSelect:false,displays:[]};
    if(state.viewId!==viewId){viewId=state.viewId||'';dirty=false;error='';roster='';}
    const names=state.displays||[],key=JSON.stringify(names),draft=select.value;
    if(key!==roster){roster=key;select.replaceChildren();names.forEach((value,index)=>{const option=node('option','显示器 '+(index+1)+' · '+value);option.value=value;select.append(option);});}
    select.value=dirty&&names.includes(draft)?draft:state.capture||names[0]||'';
    select.disabled=busy||!state.canSelect;apply.disabled=busy||!state.canSelect||!select.value;
    status.textContent=error||(state.phase==='idle'?'连接远程桌面后可选择显示器。':state.phase==='loading'?'正在读取显示器…':state.phase==='switching'?'正在切换显示器，等待新画面确认…':state.phase==='unavailable'?(state.error==='DISPLAY_UNSUPPORTED'?'请更新两端组件后使用显示器切换。':'显示器状态暂不可用，请等待连接恢复。'):state.result?.kind==='applied'?(state.input?.manualPaused?'新画面已确认，输入保持暂停。':!state.input||state.input.phase==='active'?'新画面已确认，输入已恢复。':'新画面已确认，正在确认输入状态。'):!state.canSelect?'等待远程画面和输入恢复后可切换。':'请选择要控制的显示器。');
  }
  apply.onclick=async()=>{
    if(busy||!state.canSelect||!state.displays.includes(select.value))return;
    busy=true;error='';const expected=viewId,display=select.value;render({displays:state});
    try{const next=await request('display-select',{viewId:expected,display});if(expected===viewId)render(next);}
    catch(failure){if(expected===viewId)error=failure.message;}
    finally{busy=false;render({displays:state});}
  };
  return {render};
}
