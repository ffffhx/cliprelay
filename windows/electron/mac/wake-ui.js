export function mountWake(root,request){
  const node=(tag,text)=>{const item=document.createElement(tag);if(text)item.textContent=text;return item;};
  const section=node('section'),prepare=node('button','设置 / 刷新唤醒'),send=node('button','唤醒电脑'),retry=node('button','重试同一请求'),stop=node('button','停止等待'),forget=node('button','清除唤醒设置'),status=node('p'),summary=node('p');
  status.setAttribute('aria-live','polite');
  section.append(node('h3','远程唤醒'),node('p','先在目标电脑在线时设置网卡和同一局域网内的在线助手。配置有效期为 30 天，不会更改 BIOS 或网卡电源设置。'),prepare,send,retry,stop,forget,summary);
  const form=node('div'),adapter=node('select'),helper=node('select'),adapterLabel=node('label','目标网卡'),helperLabel=node('label','局域网助手'),consent=node('input'),consentLabel=node('label'),save=node('button','保存唤醒设置');
  consent.type='checkbox';adapter.setAttribute('aria-label','目标网卡');helper.setAttribute('aria-label','局域网助手');
  adapterLabel.append(adapter);helperLabel.append(helper);consentLabel.append(consent,node('span','我确认助手与目标电脑位于同一个局域网；相同网段地址不能证明这一点。'));
  form.append(adapterLabel,helperLabel,consentLabel,save);section.append(form,status,node('p','“已发送”表示助手已发出唤醒包，仍需等待目标响应。停止等待无法撤回已发出的唤醒包。'));root.append(section);
  let state={},viewId='',busy=false,error='',choices='';
  const capability={configured:'网卡已配置，硬件唤醒尚未验证',unknown:'唤醒能力待确认',disabled:'网卡唤醒未启用',unsupported:'网卡报告不支持唤醒'};
  const messages={WAKE_CONFIRM_LAN:'请确认助手与目标电脑确实在同一局域网。',WAKE_NOT_ON_LAN:'助手当前没有连接所选局域网。',WAKE_NO_ADAPTER:'目标没有可用于设置的已连接物理网卡。',WAKE_PAIRING_REQUIRED:'电脑配对已失效，请重新配对后设置唤醒。',WAKE_PAIRING_CHANGED:'配对已改变，请重新设置唤醒。',WAKE_UPDATE_REQUIRED:'请更新目标电脑或局域网助手。',WAKE_INVALID_STORAGE:'无法读取唤醒配置。',WAKE_STORAGE_UNAVAILABLE:'无法保存唤醒配置，请检查本机存储。',WAKE_TARGET_CHANGED:'目标网卡已改变，请重新设置唤醒。',WAKE_RATE_LIMITED:'唤醒请求过于频繁，请稍后重试。',WAKE_BUSY:'助手正在处理请求，请稍后重试。',WAKE_INVALID_RESPONSE:'电脑返回的唤醒信息无效。',WAKE_STALE:'电脑或连接已改变，请刷新唤醒设置。'};
  function render(next){
    state=next.wake||{phase:'idle'};
    if(viewId!==state.viewId){viewId=state.viewId||'';consent.checked=false;error='';choices='';}
    const key=JSON.stringify([state.adapters,state.helpers]);if(choices!==key){choices=key;consent.checked=false;
      adapter.replaceChildren();helper.replaceChildren();
      for(const item of state.adapters||[]){const option=node('option',item.label+' · '+(capability[item.configuration]||'能力待确认'));option.value=item.id;adapter.append(option);}
      for(const item of state.helpers||[]){const option=node('option',item.label);option.value=item.id;helper.append(option);}
    }
    prepare.disabled=busy||!state.canPrepare;send.disabled=busy||!state.canSend;retry.disabled=busy||!state.canRetry;stop.disabled=busy||!state.canStop;forget.disabled=busy||!state.canForget;
    form.hidden=!['choosing','saving'].includes(state.phase);adapter.disabled=busy||!state.canSave;helper.disabled=busy||!state.canSave;consent.disabled=busy||!state.canSave;
    save.disabled=busy||!state.canSave||!adapter.value||!helper.value||!consent.checked;
    summary.textContent=state.configured?'已保存：通过 '+state.helper+' 发送到 '+state.network+'。'+(state.helperReady?'':'助手尚未连接。'):'尚无有效的唤醒配置。';
    const phases={idle:'请选择已配对且启用的目标电脑。',reading:'正在读取目标网卡…',choosing:(state.helpers||[]).length?'请选择网卡和局域网助手。':'没有可连接的助手，请先添加同一局域网内的另一台电脑。',saving:'正在核对目标与助手，保存配置…',checking:'正在检查目标和助手连接…',sending:'正在请求助手发送唤醒包…',waiting:'助手已发送唤醒包，正在等待目标电脑响应…',online:'已确认目标电脑响应；可以尝试连接远程桌面。',sent:'助手已发送唤醒包，已停止等待目标响应。',stopped:'已停止，尚未发送唤醒包。',ready:state.configured?'唤醒设置已保存。':'请在目标电脑在线时设置唤醒。'};
    status.textContent=error||(state.phase==='unconfirmed'?(state.packetSent?'助手已确认发送，但尚未确认目标上线。':'发送结果未确认，唤醒包可能已经发出。')+(state.error?' '+(messages[state.error]||'请检查连接。'):''):state.error?messages[state.error]||'操作未完成，请检查连接。':phases[state.phase]||'唤醒状态未确认。');
  }
  async function action(name,allowed,extra={}){
    if(busy||!allowed)return;const expected=viewId;busy=true;error='';render({wake:state});
    try{const next=await request(name,{viewId:expected,...extra});if(expected===viewId)render(next);}
    catch(failure){if(expected===viewId)error=failure.message;}
    finally{busy=false;render({wake:state});}
  }
  prepare.onclick=()=>action('wake-prepare',state.canPrepare);send.onclick=()=>action('wake-send',state.canSend);retry.onclick=()=>action('wake-retry',state.canRetry);stop.onclick=()=>action('wake-stop',state.canStop);forget.onclick=()=>action('wake-forget',state.canForget);
  save.onclick=()=>action('wake-save',state.canSave&&!!adapter.value&&!!helper.value&&consent.checked,{adapter:adapter.value,helper:helper.value,sameLan:consent.checked===true});
  consent.onchange=()=>render({wake:state});adapter.onchange=helper.onchange=()=>{consent.checked=false;render({wake:state});};return {render};
}
