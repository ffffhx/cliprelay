export function mountClipboard(root,request){
  const node=(tag,text)=>{const item=document.createElement(tag);if(text)item.textContent=text;return item;};
  const section=node('section'),label=node('label','与这台电脑自动同步剪贴板'),enabled=node('input'),receive=node('button','取回电脑剪贴板'),resume=node('button','继续同步'),status=node('p');
  section.className='clipboard-panel';label.className='clipboard-toggle';
  enabled.type='checkbox';label.prepend(enabled);status.setAttribute('aria-live','polite');
  section.append(node('h2','剪贴板'),label,node('p','开启后，只在远控连接期间同步新复制的文字和图片。开启或重连时保留两端原有内容；文件和清空操作不自动同步。'),receive,resume,status);root.append(section);
  let state={},viewId='',busy=false,error='',notice='';
  function render(next){
    if(next.clipboardSync?.phase!==state.phase)notice='';
    state=next.clipboardSync || {};if(state.viewId!==viewId){viewId=state.viewId||'';error='';notice='';}
    enabled.checked=state.enabled===true;enabled.disabled=busy || !state.canConfigure;
    receive.disabled=busy || !state.canReceive;resume.disabled=busy || !state.canResume;
    status.textContent=error || state.message || notice || ({off:'自动同步未开启。仍可手动发送或取回剪贴板。',waiting:'等待远控连接、画面和输入恢复后开始同步。',starting:'正在记录两端当前内容，新复制的内容随后自动同步。',active:'自动同步已开启。两端内容同时变化时会暂停并提示。',receiving:'正在取回电脑剪贴板…',conflict:'两端内容同时变化，已暂停同步。',paused:'自动同步已暂停。'})[state.phase] || '选择一台已配对电脑。';
  }
  async function action(name,data={}){
    if(busy || !(name==='clipboard-set-enabled'?state.canConfigure:name==='clipboard-resume'?state.canResume:state.canReceive))return;
    busy=true;error='';notice='';const expected=viewId;render({clipboardSync:state});
    try{const next=await request(name,{viewId:expected,...data});if(expected===viewId){if(name==='clipboard-receive')notice='已取回电脑剪贴板，可手动粘贴。';render(next);}}
    catch(failure){if(expected===viewId)error=failure.message;}
    finally{busy=false;render({clipboardSync:state});}
  }
  enabled.onchange=()=>action('clipboard-set-enabled',{enabled:enabled.checked});receive.onclick=()=>action('clipboard-receive');resume.onclick=()=>action('clipboard-resume');
  return {render};
}
