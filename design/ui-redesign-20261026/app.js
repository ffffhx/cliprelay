/* Standalone design prototype. All data and actions are simulated; no app APIs,
   system clipboard, network, permissions or saved preferences are accessed. */
const icons={
  devices:'<rect x="2" y="3" width="14" height="11" rx="2"/><path d="M9 14v4M5 18h7"/><rect x="16" y="8" width="6" height="13" rx="1.5"/><path d="M18 18h2"/>',
  monitor:'<rect x="2.5" y="3" width="19" height="13" rx="2"/><path d="M12 16v5M7 21h10"/>',
  laptop:'<path d="M5 16V5a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v11M2 17h20l-1.5 3h-17L2 17Z"/><path d="M10 17h4"/>',
  phone:'<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M10 5h4M10 19h4"/>',
  clipboard:'<rect x="5" y="4" width="14" height="17" rx="2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M9 11h6M9 15h6"/>',
  remote:'<rect x="2.5" y="3" width="19" height="13" rx="2"/><path d="M12 16v5M7 21h10M8 9h8m-3-3 3 3-3 3"/>',
  settings:'<path d="m9.5 3-.7 2-2 .9-2-.4-2.3 4 1.4 1.6v2.3l-1.4 1.5 2.3 4 2-.4 2 .9.7 2h4.8l.7-2 2-.9 2 .4 2.3-4-1.4-1.5v-2.3l1.4-1.6-2.3-4-2 .4-2-.9-.7-2Z"/><circle cx="12" cy="12" r="3"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
  down:'<path d="m7 10 5 5 5-5"/>',back:'<path d="M19 12H5m5-5-5 5 5 5"/>',
  more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  text:'<path d="M4 5h16M12 5v15M8 20h8M4 5v3M20 5v3"/>',
  send:'<path d="m21 3-6 18-4-8-8-4L21 3ZM11 13 21 3"/>',
  check:'<path d="m5 12 4 4L19 6"/>',checkCircle:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  screenshot:'<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/><rect x="7" y="7" width="10" height="10" rx="1"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',minus:'<path d="M5 12h14"/>',square:'<rect x="5" y="5" width="14" height="14"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2m-3-9-1 1M7 17l-1 1m0-12 1 1m10 10 1 1"/>',
  moon:'<path d="M20 14A9 9 0 0 1 10 3a9 9 0 1 0 10 11Z"/>',
  shield:'<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Z"/><path d="m8 12 3 3 5-6"/>',
  wifi:'<path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8.5 16a5.5 5.5 0 0 1 7 0"/><circle cx="12" cy="20" r=".7"/>',
  battery:'<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 10v4M5 10h10v4H5Z"/>',
  keyboard:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.1M10 9h.1M14 9h.1M18 9h.1M6 12h.1M10 12h.1M14 12h.1M18 12h.1M7 16h10"/>',
  copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-5 5 6"/>',
  terminal:'<path d="m4 6 6 6-6 6M13 18h7"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 4 3v2M13 17h.01"/>',
};
const icon=name=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name]||icons.devices}</svg>`;
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const params=new URLSearchParams(location.search);
const state={preview:params.get('preview')||'desktop',page:['devices','remote','settings'].includes(params.get('page'))?params.get('page'):'devices',dark:params.get('theme')==='dark',settingsTab:'general',mobileTab:'devices',live:false,remoteDevice:'MacBook Pro',empty:params.get('state')==='empty',added:false,targets:['MacBook Pro','OnePlus 12'],text:'明天 10:30 过一遍新版界面，先确认设备连接和传送这两个流程。',last:'14:32 已发送到 OnePlus 12',settings:{startup:true,notifications:true,preview:false},mobileCopied:false,probe:null,probeAttempt:0};
const stage=document.querySelector('#stage');
let modalReturnFocus=null,toastTimer,probeGeneration=0;
let probeTimers=[];
const btn=(label,action,kind='',glyph='')=>`<button class="btn ${kind}" data-action="${action}">${glyph?icon(glyph):''}${label}</button>`;
const sw=(label,key,value)=>`<button class="switch" role="switch" aria-label="${label}" aria-checked="${value}" data-switch="${key}"></button>`;
function heading(title,subtitle,action=''){return `<header class="page-head"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</header>`;}
function app(){return `<section class="app" aria-label="ClipRelay 电脑端设计稿"><aside class="sidebar"><div class="brand"><img src="../../assets/logo-64.png" alt="">ClipRelay</div><nav aria-label="应用导航">${[['devices','devices','我的设备'],['remote','remote','远程控制']].map(([id,glyph,label])=>`<button class="nav-item ${state.page===id?'active':''}" data-page="${id}" ${state.page===id?'aria-current="page"':''}>${icon(glyph)}${label}</button>`).join('')}</nav><div class="sidebar-bottom"><button class="nav-item ${state.page==='settings'?'active':''}" data-page="settings" ${state.page==='settings'?'aria-current="page"':''}>${icon('settings')}设置</button><div class="local-device">${icon('monitor')}<div>这台电脑<div class="muted"><span class="status-dot"></span>Windows · 后台运行中</div></div></div></div></aside><div class="workspace"><div class="window-bar"><span class="small">${state.page==='settings'?'偏好设置':'个人设备'}</span><div class="window-actions" aria-hidden="true">${icon('minus')}${icon('square')}${icon('close')}</div></div><div class="content">${({devices:devices,remote:remote,settings:settings}[state.page]||devices)()}</div></div></section><div class="design-caption"><span><b>01 / DESKTOP</b><strong>把空间留给设备和内容。</strong> 参数与诊断收进设置，异常按需出现。</span><span>可点击设备、连接与设置 · 仅演示</span></div>`;}
function deviceCard(name,type,system,action,label){return '<article class="device-card"><div class="device-top"><div class="device-art">'+icon(type)+'</div><button class="icon-button" aria-label="'+esc(name)+' 的设备详情" data-detail="'+esc(name)+'">'+icon('more')+'</button></div><h3>'+esc(name)+'</h3><div class="device-meta"><span>'+system+'</span><span class="online"><span class="status-dot"></span>在线</span>'+probeBadge(name)+'</div><div class="card-bottom"><button class="inline-action" data-action="'+action+'">'+label+icon('arrow')+'</button></div></article>';}
function probeBusy(){return state.probe && state.probe.phase!=='done';}
function probeButton(){return '<button class="btn probe-button" data-action="probe-all" '+(probeBusy()?'disabled':'')+'>'+icon('wifi')+(probeBusy()?'检测中…':'检测全链路连接')+'</button>';}
function probeBadge(name){
  const probe=state.probe;
  if(!probe || !probe.names.includes(name))return '';
  if(probe.phase!=='done')return '<span class="probe-badge checking">'+(probe.phase==='discover'?'更新地址中':'检测中')+'</span>';
  const passed=probe.results.find(row=>row.name===name)?.ok;
  return '<span class="probe-badge '+(passed?'passed':'failed')+'">'+icon(passed?'checkCircle':'help')+(passed?'检测通过':'接收未响应')+'</span>';
}
function probeSummary(){
  const probe=state.probe;
  if(!probe)return '';
  const busy=probeBusy(),success=probe.results.filter(row=>row.ok).length,failed=!busy&&success<probe.names.length;
  const title=probe.phase==='discover'?'正在更新设备地址':probe.phase==='probe'?'正在检测接收端响应':success+'/'+probe.names.length+' 台发送目标可用';
  const detail=busy?probe.names.length+' 台发送目标 · 演示检测':failed?'OnePlus 12 接收无响应 · 演示结果':'地址与接收响应正常 · 演示结果';
  return '<section class="probe-summary '+(failed?'has-failure':'')+'" aria-label="全链路检测结果"><div role="status" aria-live="polite" aria-atomic="true">'+icon(busy?'clock':failed?'help':'checkCircle')+'<span><strong>'+title+'</strong><span class="probe-description">'+detail+'</span></span></div><div class="probe-actions">'+(!busy?btn('查看详情','probe-details','text'):'')+(failed?btn('重试','probe-all','soft'):'')+'</div></section>';
}
function resetProbe(){probeGeneration++;probeTimers.forEach(clearTimeout);probeTimers=[];state.probe=null;state.probeAttempt=0;}
function paintProbe(){if(state.preview==='desktop'&&state.page==='devices'&&!document.querySelector('.modal'))render();}
function runProbe(){
  if(probeBusy())return;
  if(!state.targets.length){toast('请先选择发送目标，再检测连接');return;}
  closeModal();state.preview='desktop';state.page='devices';
  const generation=++probeGeneration,attempt=++state.probeAttempt;
  probeTimers.forEach(clearTimeout);probeTimers=[];
  state.probe={phase:'discover',names:[...state.targets],results:[]};render();
  // Illustration only: the first phone response times out; a retry succeeds.
  // Match the existing address-refresh + receiver-probe flow, without I/O.
  probeTimers.push(setTimeout(()=>{if(generation!==probeGeneration)return;state.probe.phase='probe';paintProbe();},900));
  probeTimers.push(setTimeout(()=>{
    if(generation!==probeGeneration)return;
    state.probe.results=state.probe.names.map(name=>({name,address:'已更新',ok:!(name==='OnePlus 12'&&attempt===1)}));
    state.probe.phase='done';paintProbe();
  },2100));
}
function probeDetails(){
  const probe=state.probe;if(!probe||probe.phase!=='done')return;
  modal('全链路检测详情','<p>检测范围：快捷键发送目标的地址与接收端响应。</p><p>以下为演示结果；本原型未访问实际网络。</p><div class="probe-detail-list">'+probe.results.map(row=>'<section><h3>'+esc(row.name)+'</h3><div><span>设备地址</span><span class="passed">'+icon('check')+row.address+'</span></div><div><span>接收端响应</span><span class="'+(row.ok?'passed':'failed')+'">'+icon(row.ok?'check':'help')+(row.ok?'正常':'超时')+'</span></div>'+(!row.ok?'<p>在该设备打开 ClipRelay，确认网络连接后重试。</p>':'')+'</section>').join('')+'</div>',btn('重新检测','probe-all')+btn('完成','close-modal','primary'));
}
function devices(){return heading('我的设备',state.empty?'添加一台设备，开始互传。':'设备都在这里，连接后接着用。',btn('添加设备','add','','plus'))+(state.empty?`<div class="empty-state">${icon('devices')}<h3>连接你的第一台设备</h3><p>在另一台设备打开 ClipRelay，选择设备即可连接。</p>${btn('添加设备','add','primary','plus')}</div><p class="hint">支持 Windows、Mac 和 Android。不同设备会显示各自支持的操作。</p>`:`<div class="section-heading"><h2>设备 <span>${state.added?'4':'3'}</span></h2><div class="device-toolbar"><span class="small muted"><span class="status-dot"></span>${state.added?'3':'2'} 台在线</span>${probeButton()}</div></div>${probeSummary()}<div class="devices-grid">${deviceCard('MacBook Pro','laptop','macOS','connect-mac','远程控制')}${deviceCard('OnePlus 12','phone','Android','connect-phone','远程控制')}</div><div class="offline-row">${icon('monitor')}<div class="row-detail"><span>Studio PC</span><span class="muted small"><span class="status-dot offline"></span>离线 · 上次在线 2 小时前</span></div><button class="icon-button" aria-label="Studio PC 的设备详情" data-detail="Studio PC">${icon('more')}</button></div>${state.added?`<div class="offline-row">${icon('phone')}<div class="row-detail"><span>我的平板</span><span class="online"><span class="status-dot"></span>在线</span></div><button class="icon-button" aria-label="我的平板的设备详情" data-detail="我的平板">${icon('more')}</button></div>`:''}<section class="shortcut-section" aria-label="快捷键发送"><div class="section-heading"><h2>快捷键</h2><button class="inline-action" data-action="targets">发送目标 · ${state.targets.length} 台设备${icon('down')}</button></div><div class="shortcut-row"><span>${icon('text')}发送文本</span><span class="key-combo"><kbd>Ctrl</kbd><span>+</span><kbd>C</kbd></span></div><div class="shortcut-row"><span>${icon('screenshot')}发送截图</span><span class="key-combo"><kbd>Ctrl</kbd><span>+</span><kbd>Alt</kbd><span>+</span><kbd>F12</kbd></span></div><div class="last-status">${icon('checkCircle')}<span>${esc(state.last)}</span></div></section>`);}

function targetChecks(){return `<div class="target-pills">${['MacBook Pro','OnePlus 12'].map(name=>`<label class="check-pill"><input type="checkbox" data-target="${name}" ${state.targets.includes(name)?'checked':''}>${icon(name==='OnePlus 12'?'phone':'laptop')}${name}</label>`).join('')}</div>`;}
function remote(){
  const device=esc(state.remoteDevice);
  return heading('远程控制',state.live?'已连接 · '+device+' · 演示会话':'选择设备，直接连接。',state.live?btn('断开连接','disconnect','danger'):btn('添加设备','add','','plus'))+
    (state.live?
      '<div class="live-screen"><div class="live-toolbar"><span>'+device+'</span><span>演示画面</span></div><div class="live-paper"><h3>项目笔记</h3><p>界面设计评审</p><div class="monitor-line"></div><div class="monitor-line"></div><div class="monitor-line"></div><p>保持远程画面完整，常用工具放在底部。</p></div></div><div class="toolbar">'+btn('传文件','demo-files','','copy')+btn('键盘','demo-keyboard','','keyboard')+btn('更多','remote-more','','more')+'</div>':
      '<div class="section-heading"><h2>可连接的设备</h2><span class="small muted"><span class="status-dot"></span>2 台在线</span></div><div class="remote-grid direct-devices">'+
      [['MacBook Pro','laptop','macOS','连接电脑'],['OnePlus 12','phone','Android','连接手机']].map(([name,glyph,platform,label])=>'<article class="remote-card"><div class="monitor-illustration"><div class="remote-device-art">'+icon(glyph)+'</div></div><div class="remote-card-body"><h3>'+name+'</h3><p><span class="status-dot"></span>在线 · '+platform+'</p><button class="btn '+(glyph==='laptop'?'primary':'soft')+'" data-action="start-remote" data-device="'+name+'">'+icon('remote')+label+'</button></div></article>').join('')+
      '</div><div class="offline-row">'+icon('monitor')+'<div class="row-detail"><span>Studio PC</span><span class="muted small"><span class="status-dot offline"></span>离线 · 上次在线 2 小时前</span></div></div>');
}
function settingRow(title,desc,control){return `<div class="setting-row"><div><h3>${title}</h3>${desc?`<p>${desc}</p>`:''}</div>${control}</div>`;}
function settings(){
  return heading('设置','常用偏好，集中在这里。')+'<div class="segmented" role="tablist" aria-label="设置分类">'+[['general','通用'],['advanced','高级']].map(([id,label])=>'<button role="tab" aria-selected="'+(state.settingsTab===id)+'" class="'+(state.settingsTab===id?'active':'')+'" data-settings-tab="'+id+'">'+label+'</button>').join('')+'</div>'+
    (state.settingsTab==='general'?
      '<section class="setting-group"><h2>日常使用</h2>'+settingRow('登录后启动 ClipRelay','在后台保持设备连接。',sw('登录后启动 ClipRelay','startup',state.settings.startup))+settingRow('接收通知','收到内容时显示系统通知。',sw('接收通知','notifications',state.settings.notifications))+settingRow('通知中显示文本预览','关闭后，通知只显示发送设备。',sw('通知中显示文本预览','preview',state.settings.preview))+'</section><section class="setting-group"><h2>个性化</h2>'+settingRow('设备名称','其他设备看到的本机名称。','<input type="text" aria-label="设备名称" value="我的 Windows">')+settingRow('外观','所有窗口使用同一套明暗主题。','<select aria-label="外观" id="appearance"><option value="light" '+(!state.dark?'selected':'')+'>浅色</option><option value="dark" '+(state.dark?'selected':'')+'>深色</option></select>')+'</section><div class="saved-hint">'+icon('check')+'设计稿中的更改仅在当前预览中生效</div>':
      settingRow('复制时发送文本','Windows 的 Ctrl + C 可发送到选中的设备。',btn('选择设备','targets'))+'<details class="accordion"><summary>快捷键</summary><p>Windows 文本发送：Ctrl + C<br>Windows 全屏截图：Ctrl + Alt + F12<br>Mac 发送选中文本：Ctrl + Alt + G</p></details><details class="accordion"><summary>连接诊断</summary><p>查看设备地址、连接状态与错误详情。</p>'+btn('运行诊断','diagnose')+'</details><details class="accordion"><summary>关于与更新</summary><p>ClipRelay · 设计提案 01<br>版本、更新与开源组件统一收纳于此。</p>'+btn('检查更新','update')+'</details>');
}
function phone(){return `<div class="mobile-stage"><aside class="mobile-context"><span class="eyebrow">02 / MOBILE COMPANION</span><h1>同一套秩序，<br>放进口袋里。</h1><p>电脑端负责连接与发送，手机端让接收、复制与远控更顺手。</p><ul><li><b>01</b><div><strong>设备优先</strong><p>选择设备，直接进入远程控制。</p></div></li><li><b>02</b><div><strong>收到的内容直接可用</strong><p>保留最近收到，一次点击即可复制。</p></div></li><li><b>03</b><div><strong>设置离开主页面</strong><p>通知、外观和更新独立收纳。</p></div></li></ul><span class="small muted">可点击底部导航体验 · Android 设计方向</span></aside><section class="phone-frame" aria-label="ClipRelay 手机端设计稿"><div class="phone-status"><span>9:41</span><span>${icon('wifi')}${icon('battery')}</span></div><div class="phone-body">${phoneBody()}</div><nav class="phone-tabs" aria-label="手机导航">${[['devices','devices','设备'],['settings','settings','设置']].map(([id,glyph,label])=>`<button class="${state.mobileTab===id?'active':''}" data-mobile-tab="${id}" ${state.mobileTab===id?'aria-current="page"':''}>${icon(glyph)}${label}</button>`).join('')}</nav><div class="phone-home-line"></div></section></div>`;}
function phoneBody(){
if(state.mobileTab==='settings')return '<div class="phone-header"><h1>设置</h1></div>'+settingRow('接收通知','收到内容时显示系统通知。',sw('接收通知','notifications',state.settings.notifications))+settingRow('通知预览','通知中显示收到的文本。',sw('通知预览','preview',state.settings.preview))+settingRow('深色外观','与电脑端保持相同视觉层级。',sw('深色外观','dark',state.dark))+'<details class="accordion"><summary>连接诊断</summary><p>查看设备地址、连接状态与错误详情。</p></details><details class="accordion"><summary>关于与更新</summary><p>ClipRelay · Android 设计提案<br>版本与更新在此显示。</p></details>';

return `<div class="phone-header"><h1>我的设备</h1><button class="icon-button" data-action="add" aria-label="添加设备">${icon('plus')}</button></div><div class="phone-subhead"><span class="muted">设备</span><span class="online"><span class="status-dot"></span>2 台在线</span></div>${[['我的 Windows','monitor','Windows'],['MacBook Pro','laptop','macOS']].map(([name,type,system])=>`<article class="phone-device"><div class="phone-device-top"><div class="device-art">${icon(type)}</div><div><h3>${name}</h3><div class="device-meta">${system}<span class="online"><span class="status-dot"></span>在线</span></div></div></div><div class="card-bottom"><button class="btn soft" data-action="mobile-remote" data-device="${name}">${icon('remote')}远程控制</button></div></article>`).join('')}<div class="phone-offline">${icon('monitor')}<span>Studio PC</span><span class="small" style="margin-left:auto">离线</span></div><section class="phone-section"><div class="section-heading"><h2>最近收到</h2><button class="inline-action" data-action="received">全部${icon('arrow')}</button></div><div class="received-clip"><p>${esc(state.text)}</p><div class="received-clip-footer"><span>来自我的 Windows · 刚刚</span><button data-action="mobile-copy">${state.mobileCopied?'已复制':'复制'}</button></div></div></section>`;}
function notes(){return `<article class="notes"><span class="eyebrow">CLIPRELAY / DESIGN PROPOSAL 01</span><h1>工具退后一步，事情更容易完成。</h1><p class="lead">以「设备」组织连接，文本与截图由快捷键发送。应用中只需管理目标、查看状态与进入远程控制。电脑端优先，手机端沿用同一套层级、图标和状态表达。</p><h2>这次具体减掉什么</h2><table><thead><tr><th>现有界面</th><th>设计稿中的处理</th></tr></thead><tbody><tr><td>网络统计、广播节点、链路工作区</td><td>取消概念化区块。首页直接显示设备名、在线状态与可执行操作。</td></tr><tr><td>权限、授权确认、密钥和加密选项</td><td>本轮按用户约定移出产品界面；双向连接与操作默认允许，加密默认关闭。无需手动设置。</td></tr><tr><td>端口、监听地址、mDNS</td><td>日常页面不展示。连接异常时提供诊断入口。</td></tr><tr><td>独立剪贴板页与手动发送</td><td>移除导航、编辑框、发送按钮和首页内容预览。文本与截图统一通过快捷键发送。</td></tr><tr><td>大面积快捷键说明</td><td>首页只显示快捷键和目标数量；详细配置放在设置中。</td></tr><tr><td>设置、更新和操作混排</td><td>常用操作留在主内容区。通知、开机启动、外观和更新在设置中集中管理。</td></tr><tr><td>深色控制中心与浅色原生弹窗混用</td><td>同一套字体、间距、色彩和控件覆盖主窗口、设备选择、远控与设置。</td></tr><tr><td>独立共享屏幕流程</td><td>移除本机屏幕共享入口与选择接收端流程，统一从设备卡片进入远程控制。</td></tr></tbody></table><h2>页面与交互</h2><table><thead><tr><th>页面</th><th>核心内容</th></tr></thead><tbody><tr><td>我的设备</td><td>在线设备优先；离线设备降为紧凑行。列表上方保留「检测全链路连接」：刷新已选目标地址，再验证接收端响应；就地展示进度、结果和重试。保留快捷键提示、发送目标配置和最近一次结果。</td></tr><tr><td>远程控制</td><td>选择设备直接进入会话；连接后显示键盘和文件工具，不再打开独立的文本发送面板。</td></tr><tr><td>设置</td><td>通用 / 高级。只保留日常偏好、快捷键、诊断与更新。</td></tr><tr><td>手机端</td><td>设备 / 设置两栏。首页保留最近收到，通过「全部」查看接收记录；只提供查看和复制，不提供消息编辑与发送。远控工具栏沿用已有横屏方案。</td></tr></tbody></table><h2>视觉规范</h2><div class="tokens">${[['#ffffff','内容底色'],['#f7f8fa','侧栏与次级底色'],['#202633','正文'],['#3f5ed7','主操作'],['#338267','在线 / 成功']].map(([color,name])=>`<div class="token"><span class="swatch" style="background:${color}"></span><span>${name}<br><span class="muted">${color}</span></span></div>`).join('')}</div><p>系统无衬线字体；标题 27 px，正文 13–14 px，辅助信息 11–12 px；8 px 间距基准，主要留白 24–42 px；卡片圆角 12 px，按钮 7 px；同一页面以一个主操作为重点。沿用现有 ClipRelay 图标，不额外进行品牌改造。状态同时用文字和符号表达。</p><h2>设计边界</h2><p>此目录为独立的交互设计稿，全部使用示例数据。按钮只改变预览状态，不读取系统剪贴板、不发送内容、不连接设备、不修改实际配置。窗口右上角的系统按钮仅表示窗口样式。</p><p>本轮交互约定覆盖电脑与手机的双向连接：所有连接和操作权限默认允许，加密默认关闭；产品界面不展示相关开关、授权列表、确认弹窗或提示文字。这是后续实现的设计要求，当前原型未修改真实应用的连接协议或系统设置。手机作为被控端同样属于设计目标，原型画面不代表该能力已经接入。</p><p>连接检测沿用原应用的地址更新与接收探测语义，不将远控和文件传输能力混为检测通过。此稿用「手机接收首轮超时、重试成功」展示失败与恢复状态，不执行实际网络检测。发送方式统一为系统快捷键；原型只展示快捷键绑定，不注册或拦截真实系统快捷键。手机现有接收记录继续保留；桌面最近结果只在会话中显示。字体缩放、读屏、键盘导航、原生窗口和后台服务的整体验收在正式实现时完成；此稿已提供焦点样式、开关语义与窄屏布局。</p><div class="modal-footer">${btn('查看首次使用','empty')}${btn('回到电脑端','desktop','primary','arrow')}</div></article>`;}
function render(){document.body.classList.toggle('dark',state.dark);document.querySelector('#theme-toggle').innerHTML=icon(state.dark?'sun':'moon');document.querySelectorAll('[data-preview]').forEach(el=>{el.classList.toggle('selected',el.dataset.preview===state.preview);el.setAttribute('aria-current',el.dataset.preview===state.preview?'page':'false');});stage.innerHTML=state.preview==='mobile'?phone():state.preview==='notes'?notes():app();}
function toast(message){clearTimeout(toastTimer);const el=document.querySelector('#toast');el.textContent=message;el.classList.add('visible');toastTimer=setTimeout(()=>el.classList.remove('visible'),3500);}
function closeModal(){document.querySelector('#modal-root').innerHTML='';stage.inert=false;document.querySelector('.review-bar').inert=false;modalReturnFocus?.focus();modalReturnFocus=null;}
function modal(title,body,footer=''){const root=document.querySelector('#modal-root');if(!root.firstChild)modalReturnFocus=document.activeElement;stage.inert=true;document.querySelector('.review-bar').inert=true;root.innerHTML=`<div class="modal-shade"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><h2 id="modal-title">${title}</h2><button class="icon-button" data-action="close-modal" aria-label="关闭弹窗">${icon('close')}</button></div>${body}${footer?`<div class="modal-footer">${footer}</div>`:''}</section></div>`;root.querySelector('input,button')?.focus();}
function addDevice(){modal('添加设备','<p>选择附近设备，或手动输入设备地址。</p><div class="found-device">'+icon('phone')+'<div><strong>我的平板</strong><p>Android · 在线 · 示例</p></div>'+btn('添加','add-finish','soft')+'</div><p>没有找到？<button class="inline-action" data-action="manual-address">手动输入地址</button></p>',btn('完成','close-modal'));}
function finishAdd(){state.empty=false;state.added=true;closeModal();render();toast('演示：设备已添加，可以直接连接');}

function received(){modal('收到的内容','<p>来自设备的接收记录 · 示例</p>'+[state.text,'https://example.com/project','设计稿评审：先确认信息层级，再调整视觉细节。'].map((text,i)=>'<div class="received-clip" style="margin-bottom:12px"><p>'+esc(text)+'</p><div class="received-clip-footer"><span>来自我的 Windows · '+(i===0?'刚刚':i===1?'12 分钟前':'今天 09:20')+'</span><button data-action="copy-record" data-record="'+i+'">复制</button></div></div>').join(''),btn('完成','close-modal','primary'));}

function detail(name){const offline=name==='Studio PC';modal(name,`<p>${offline?'离线 · 上次在线 2 小时前':'在线'} · 示例设备</p><dl class="detail-list"><div><dt>平台</dt><dd>${name==='OnePlus 12'||name==='我的平板'?'Android':name==='Studio PC'?'Windows':'macOS'}</dd></div><div><dt>快捷键目标</dt><dd>${offline?'等待设备上线':state.targets.includes(name)?'已选中':'未选中'}</dd></div><div><dt>远程控制</dt><dd>${offline?'当前离线':'可连接'}</dd></div></dl><details class="accordion"><summary>连接详情与诊断</summary><p>这里按需显示地址、连接路径及错误详情。示例不读取实际网络信息。</p>${btn('检测连接','diagnose')}</details>`,btn('完成','close-modal','primary'));}
const actions={
  add:addDevice,
  'add-finish':finishAdd,
  'manual-address':()=>modal('手动添加设备','<p>输入对方 ClipRelay 中显示的设备地址。</p><label for="address-input" class="small">设备地址</label><input id="address-input" class="modal-input" placeholder="例如 192.168.1.23" autocomplete="off">',btn('返回','add')+btn('添加','address-next','primary')),
  'address-next':()=>{const v=document.querySelector('#address-input').value.trim();if(!v){toast('请先输入设备地址');return;}finishAdd();},
  'close-modal':closeModal,
  targets:()=>modal('快捷键发送目标',`<p>按下发送快捷键时，内容会发送到选中的在线设备。</p>${targetChecks()}<p>Studio PC 当前离线。</p>`,btn('完成','targets-done','primary')),
  'targets-done':()=>{resetProbe();closeModal();render();},
  'probe-all':runProbe,
  'probe-details':probeDetails,

  'connect-mac':()=>{state.page='remote';state.remoteDevice='MacBook Pro';state.live=true;render();},
  'connect-phone':()=>{state.page='remote';state.remoteDevice='OnePlus 12';state.live=true;render();},
  'start-remote':()=>{state.remoteDevice=state.mobileTarget||'MacBook Pro';state.live=true;render();toast('演示会话已连接');},
  disconnect:()=>{state.live=false;render();toast('演示会话已断开');},

  diagnose:()=>{toast('演示：连接检查完成，未访问实际网络');},
  update:()=>toast('设计稿不连接更新服务'),
  'demo-files':()=>modal('传送文件','<p>文件传送入口位于远程会话中。连接后显示目标电脑及传输进度。</p><div class="empty-state" style="padding:28px">'+icon('copy')+'<p>将文件拖放到这里</p><span class="small muted">设计示意 · 不接收实际文件</span></div>',btn('完成','close-modal','primary')),
  'demo-keyboard':()=>toast('演示：显示远程键盘工具'),
  'remote-more':()=>modal('会话工具',`<div class="detail-list"><div><span>画质</span><span class="muted">自动</span></div><div><span>显示器</span><span class="muted">主显示器</span></div><div><span>输入模式</span><span class="muted">键盘与鼠标</span></div><div><span>终端</span>${btn('打开','demo-terminal')}</div></div>`,btn('完成','close-modal','primary')),
  'demo-terminal':()=>toast('演示：终端作为独立工具打开'),
  'mobile-copy':()=>{state.mobileCopied=true;render();toast('演示：文本已复制，不写入系统剪贴板');},
  received,
  'copy-record':()=>toast('演示：文本已复制，不写入系统剪贴板'),

  'mobile-remote':()=>modal('连接'+esc(state.mobileTarget||'我的 Windows'),'<p>进入远程控制后，切换为横屏工具栏。保留本机输入、电脑键盘、语音与图片入口。</p><p>已有手机与平板横屏工具栏设计继续作为详细交互依据。</p>',btn('完成','close-modal','primary')),
  desktop:()=>{state.preview='desktop';state.page='devices';state.empty=false;render();},
  empty:()=>{state.preview='desktop';state.page='devices';state.empty=true;render();}
};
document.addEventListener('click',event=>{const el=event.target.closest('button');if(!el||el.disabled)return;
  if(el.id==='theme-toggle'){state.dark=!state.dark;render();return;}
  if(el.dataset.preview){state.preview=el.dataset.preview;render();return;}
  if(el.dataset.page){state.page=el.dataset.page;render();return;}
  if(el.dataset.settingsTab){state.settingsTab=el.dataset.settingsTab;render();return;}
  if(el.dataset.mobileTab){state.mobileTab=el.dataset.mobileTab;render();return;}
  if(el.dataset.detail){detail(el.dataset.detail);return;}
  if(el.dataset.switch){const key=el.dataset.switch;const next=el.getAttribute('aria-checked')!=='true';el.setAttribute('aria-checked',next);if(key in state.settings)state.settings[key]=next;else if(key in state)state[key]=next;if(key==='dark')render();toast('仅更新设计稿中的状态');return;}
  if(el.dataset.device)state.mobileTarget=el.dataset.device;
  if(el.dataset.action==='copy-record')el.textContent='已复制';
  actions[el.dataset.action]?.();
});

document.addEventListener('change',event=>{if(event.target.dataset.target){const name=event.target.dataset.target;state.targets=event.target.checked?[...new Set([...state.targets,name])]:state.targets.filter(v=>v!==name);}if(event.target.id==='appearance'){state.dark=event.target.value==='dark';render();}});
document.addEventListener('keydown',event=>{const root=document.querySelector('#modal-root');if(!root.firstChild)return;if(event.key==='Escape')closeModal();if(event.key==='Tab'){const nodes=[...root.querySelectorAll('button:not(:disabled),input,textarea,select,summary,[tabindex="0"]')];const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}});
render();
