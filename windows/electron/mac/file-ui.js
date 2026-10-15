const sizes=value=>{if(value<1024)return value+' B';const unit=Math.min(4,Math.floor(Math.log(value)/Math.log(1024)));return (value/1024**unit).toFixed(1)+' '+['B','KB','MB','GB','TB'][unit];};
export function mountFiles(root,request){
  const make=(tag,text)=>{const node=document.createElement(tag);if(text)node.textContent=text;return node;};
  const section=make('section');section.className='file-panel';section.append(make('h2','文件传输'),make('p','选择远程目录后，可上传文件或批量下载。关闭此窗口后继续传输；退出应用或切换电脑后暂停，需要手动继续。'));
  const controls=make('div');controls.className='file-controls';const roots=make('select');roots.ariaLabel='远程文件位置';
  const refresh=make('button','浏览文件'),up=make('button','上一级'),upload=make('button','上传文件…'),download=make('button','下载所选…');controls.append(roots,refresh,up,upload,download);
  const breadcrumb=make('p'),notice=make('p');notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
  const listing=make('div');listing.className='file-list';listing.setAttribute('aria-label','远程文件');const more=make('button','加载更多');
  const folderForm=make('form'),folder=make('input'),create=make('button','新建文件夹');folder.placeholder='文件夹名称';folder.ariaLabel=folder.placeholder;folder.maxLength=200;folderForm.append(folder,create);
  const queue=make('div');queue.className='file-queue';queue.setAttribute('aria-label','文件传输队列');section.append(controls,breadcrumb,notice,listing,more,folderForm,queue);root.append(section);
  let state,working=false,listingKey='',rootsKey='',error='',selection=new Set();const rows=new Map();
  const current=()=>state?.hosts.find(host=>host.selected),browser=()=>state?.files?.browser || {roots:[],entries:[],root:'',path:''};
  const ready=()=>!!current()?.enabled && current()?.routeReady!==false;
  async function run(action,data){if(working)return;working=true;error='';render(state);try{const next=await request(action,data);render(next);}catch(failure){error=failure.message;}finally{working=false;render(state);}}
  const browse=(root,path,more=false)=>run('files-browse',{root,path,more});
  refresh.onclick=()=>browse(browser().root,browser().path);roots.onchange=()=>browse(roots.value,'');up.onclick=()=>browse(browser().root,browser().path.split('/').slice(0,-1).join('/'));
  more.onclick=()=>browse(browser().root,browser().path,true);upload.onclick=()=>run('files-upload');download.onclick=()=>run('files-download',{names:[...selection]});
  folderForm.onsubmit=event=>{event.preventDefault();run('files-mkdir',{name:folder.value}).then(()=>{if(!error)folder.value='';});};
  const phases={queued:'等待传输',hashing:'校验源文件',uploading:'上传中',preparing:'准备下载',downloading:'下载中',verifying:'校验完整文件',publishing:'保存文件',paused:'已暂停',cancelling:'正在取消', 'cancel-pending':'等待电脑确认取消',complete:'已完成',cancelled:'已取消'};
  function render(next){
    if(!next)return;state=next;section.hidden=!state.files;if(!state.files)return;
    const b=browser(),disabled=working || !ready();
    refresh.disabled=disabled;refresh.textContent=b.loaded?'刷新':'浏览文件';roots.disabled=disabled;up.disabled=disabled || !b.path;
    upload.disabled=disabled || !b.root || !b.roots.find(root=>root.id===b.root)?.writable;download.disabled=disabled || !selection.size;
    create.disabled=upload.disabled;folder.disabled=create.disabled;more.disabled=disabled;more.hidden=!b.next;
    const newRoots=JSON.stringify(b.roots);if(newRoots!==rootsKey){rootsKey=newRoots;roots.replaceChildren();for(const item of b.roots){const option=make('option',({home:'用户目录',desktop:'桌面',documents:'文稿',downloads:'下载'})[item.id] || item.name);option.value=item.id;roots.append(option);}}roots.value=b.root;
    breadcrumb.textContent=b.root?(current()?.name || '')+' / '+b.root+(b.path?'/'+b.path:''):ready()?'点击“浏览文件”打开所选电脑的文件':'请选择并启用一台配对电脑';
    notice.textContent=error || state.files.error || (working?'正在处理…':'');
    const key=JSON.stringify([current()?.id,b.root,b.path,b.entries]);
    if(key!==listingKey){listingKey=key;selection=new Set();listing.replaceChildren();
      for(const entry of b.entries){
        const row=make('div');row.className='file-entry';const label=make('span',entry.name);label.title=entry.name;
        if(entry.directory){const open=make('button','打开');open.disabled=entry.blocked;open.onclick=()=>browse(b.root,[b.path,entry.name].filter(Boolean).join('/'));row.append(label,make('small',entry.blocked?'目录不可访问':'文件夹'),open);}
        else{const choose=make('input');choose.type='checkbox';choose.disabled=entry.blocked;choose.ariaLabel='选择 '+entry.name;choose.onchange=()=>{if(choose.checked)selection.add(entry.name);else selection.delete(entry.name);download.disabled=working || !ready() || !selection.size || selection.size>128;};row.append(choose,label,make('small',entry.blocked?'不可传输':sizes(entry.size)));}
        listing.append(row);
      }
      if(b.loaded && !b.entries.length)listing.append(make('p','此目录为空'));download.disabled=true;
    }
    for(const [id,row] of rows)if(!state.files.tasks.some(task=>task.id===id)){row.element.remove();rows.delete(id);}
    for(const task of state.files.tasks){
      let row=rows.get(task.id);if(!row){
        const element=make('article'),title=make('strong'),detail=make('p'),progress=make('progress'),buttons=make('div');element.className='file-task';buttons.className='file-controls';progress.max=100;progress.ariaLabel='文件传输进度';element.append(title,progress,detail,buttons);queue.append(element);
        const actions={};for(const [action,label] of [['pause','暂停'],['resume','继续'],['cancel','取消'],['reveal','在文件夹中显示'],['forget','清除记录']]){const button=make('button',label);button.onclick=()=>run('files-'+action,{id:task.id});actions[action]=button;buttons.append(button);}row={element,title,detail,progress,actions};rows.set(task.id,row);
      }
      const done=['complete','cancelled'].includes(task.state),paused=['paused','cancel-pending'].includes(task.state);
      row.title.textContent=task.direction==='upload'?'上传 · '+task.name+' → '+task.hostName:'下载 · '+task.hostName+' → '+task.name;
      const amount=['hashing','verifying','preparing'].includes(task.state)?task.verified:task.offset;row.progress.value=task.state==='complete'?100:task.size?Math.min(100,amount/task.size*100):0;
      row.detail.textContent=(phases[task.state] || task.state)+' · '+sizes(amount)+' / '+sizes(task.size)+(task.error?' · '+task.error:'')+(task.state==='complete'?' · '+(task.destination?task.destination+'/':'')+(task.finalName || task.name):'');
      row.actions.pause.hidden=done || paused || task.state==='cancelling';row.actions.resume.hidden=!paused;row.actions.cancel.hidden=done || ['cancelling','cancel-pending'].includes(task.state);
      row.actions.resume.textContent=task.state==='cancel-pending'?'重试取消':'继续';row.actions.reveal.hidden=task.state!=='complete' || task.direction!=='download';row.actions.forget.hidden=!done;
      for(const button of Object.values(row.actions))button.disabled=working;row.actions.resume.disabled=working || !ready() || task.hostId!==current()?.id;
    }
  }
  return {render};
}
