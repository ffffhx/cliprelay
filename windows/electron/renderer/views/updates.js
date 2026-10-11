import {element} from './elements.js';
export async function mount({root,api,title,status,setStatus,button,close}){
  root.querySelector('.dialog-brand').style.top='18px';
  root.querySelector('.dialog-close').remove();button('×',498,12,36,close);
  title.textContent='版本更新';title.style.cssText='left:24px;top:47px;font-size:28px';
  const version=element(root,'div','',26,96,508,24,'color:#94a3b8');
  element(root,'div','本次更新',26,140,400,24,'font-size:13.33px;font-weight:bold');
  const notes=element(root,'div','',26,174,508,164,'background:#171a24;font-size:13.33px;overflow:auto;white-space:pre-wrap;user-select:text');
  status.style.cssText='position:absolute;left:26px;top:352px;width:508px;height:42px;color:#94a3b8;white-space:pre-wrap';
  element(root,'div','发现新版时通知我',26,405,400,24,'color:#94a3b8');
  const notify=element(root,'button','',490,402,44,24,'--height:24px');notify.className='toggle';notify.setAttribute('role','switch');notify.ariaLabel='发现新版时通知我';
  let state,initialized=false;
  notify.onclick=async()=>{try{state.Notify=!state.Notify;notify.setAttribute('aria-checked',String(state.Notify));await api.request('update-notify',{enabled:state.Notify});}catch(error){setStatus(error.message,true);}};
  const check=button('检查更新',24,456,124,()=>api.request('update-check'));
  button('稍后',282,456,90,close);
  const download=button('下载新版',384,456,152,()=>api.request(state.FilePath?'update-open':'update-download'),true);
  return {update(snapshot){
    state=snapshot.update;const available=state.Release;
    if(!initialized){initialized=true;if(!state.Checked && !state.Operation)api.request('update-check').catch(error=>setStatus(error.message,true));}
    title.textContent=available?'有新版本可以下载':'版本更新';
    version.textContent=available?`v${state.CurrentVersion}  →  v${available.versionName}    ·    Windows`:`当前版本 v${state.CurrentVersion}    ·    Windows`;
    const content=available?.releaseNotes || '发布新版本后，这里会显示更新内容。';if(notes.textContent!==content)notes.textContent=content;
    check.disabled=!!state.Operation;download.disabled=!available || !!state.Operation;
    download.textContent=state.FilePath?'打开下载位置':state.Operation==='download'?'正在下载…':'下载新版';
    notify.setAttribute('aria-checked',String(state.Notify));
    setStatus(state.Error || (state.Operation==='download'?`正在下载 ${(state.Received/1048576).toFixed(1)} / ${(available.sizeBytes/1048576).toFixed(1)} MB，关闭窗口后仍会继续。`:state.Operation==='check'?'正在检查更新…':state.FilePath?'下载完成并已校验。解压后双击 Install.cmd，保留现有设备设置。':available?`安装包 ${(available.sizeBytes/1048576).toFixed(1)} MB · 下载后由你选择安装时间。`:state.Checked?'已是最新版本。运行期间每 15 分钟自动检查。':'运行期间每 15 分钟自动检查，也可以立即检查。'),!!state.Error);
  },error:error=>setStatus(error.message,true)};
}
