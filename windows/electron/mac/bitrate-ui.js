export function mountBitrate(root,request){
  const node=(tag,text)=>{const item=document.createElement(tag);if(text)item.textContent=text;return item;};
  const section=node('section'),label=node('label','总码率（Mbps）'),input=node('input'),apply=node('button','调整码率'),current=node('p'),status=node('p');
  input.type='number';input.min='1';input.max='100';input.step='0.5';input.value='12';input.ariaLabel='总码率（Mbps）';label.append(input);
  status.setAttribute('aria-live','polite');section.append(node('h3','实时码率'),node('p','降低码率可节省带宽，画质可能下降。调整无需重新连接。'),label,apply,current,status);root.append(section);
  let state={},viewId='',busy=false,error='',dirty=false;
  input.oninput=()=>{dirty=true;};
  const rate=value=>(value/1000).toLocaleString(undefined,{maximumFractionDigits:3});
  const messages={VIEWER_UPDATE_REQUIRED:'请更新桌面控制组件后使用实时码率。',BITRATE_UNSUPPORTED:'请更新被控电脑后使用实时码率。',BITRATE_ENCODER_UNSUPPORTED:'当前编码器不支持实时调整码率。',BITRATE_NO_EXCLUSIVE_STREAM:'同一配对身份有多个连接，暂时无法确定调整目标。',BITRATE_NOT_READY:'请等远程画面恢复后再调整。',BITRATE_INVALID_RESPONSE:'电脑返回的码率状态无效，请检查电脑端版本。'};
  function render(next){
    state=next.bitrate||{phase:'idle',canApply:false};
    if(state.viewId!==viewId){viewId=state.viewId||'';input.value=String((state.currentKbps||12000)/1000);error='';dirty=false;}
    if(!dirty&&state.currentKbps)input.value=String(state.currentKbps/1000);
    input.disabled=busy||!state.canApply;apply.disabled=busy||!state.canApply;
    current.textContent=state.videoKbps?'当前'+(state.currentKbps?'总码率 '+rate(state.currentKbps)+' Mbps · ':'')+'视频 '+rate(state.videoKbps)+' Mbps':'';
    const result=state.result;
    status.textContent=error||(state.phase==='idle'?'连接远程桌面后可调整码率。':state.phase==='loading'?'正在读取码率…':state.phase==='pending'?'正在调整到 '+rate(state.requestedKbps)+' Mbps，等待新画面确认…':state.phase==='unavailable'?(messages[state.error]||'暂时无法读取码率，请检查连接。'):
      result?.kind==='applied'?'已确认 '+rate(result.budgetKbps)+' Mbps 生效。':result?.kind==='unconfirmed'?'调整结果尚未确认，请查看当前码率后再决定是否重试。':result?.kind==='superseded'?'码率已被其他调整更新，请查看当前值。':result?.kind==='rejected'?'电脑未接受本次调整，可稍后重试。':!state.canApply?'等待远程画面恢复后可调整。':'可设置 1–100 Mbps。');
  }
  apply.onclick=async()=>{
    if(busy||!state.canApply)return;
    const value=Number(input.value),budgetKbps=Math.round(value*1000);
    if(!/^\d{1,3}(?:\.\d{1,3})?$/.test(input.value)||value<1||value>100){error='请输入 1–100 Mbps，最多三位小数。';render({bitrate:state});return;}
    busy=true;error='';const expected=viewId;render({bitrate:state});
    try{const next=await request('bitrate-apply',{viewId:expected,budgetKbps});if(expected===viewId)render(next);}
    catch(failure){if(expected===viewId)error=failure.message;}
    finally{busy=false;render({bitrate:state});}
  };
  return {render};
}
