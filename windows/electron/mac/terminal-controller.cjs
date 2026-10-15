'use strict';
const crypto=require('node:crypto'),protocol=require('./terminal-protocol.cjs');
const {performance}=require('node:perf_hooks'),{MouseState,enabled:mouseEnabled}=require('./terminal-mouse.cjs');
const {fault}=require('./paired-transport.cjs'),{sameRoute}=require('./routed-store.cjs'),{message:pairedMessage}=require('./paired-controller.cjs');
const {requireValue,InputState}=protocol;
const digest=identity=>crypto.createHash('sha256').update(new crypto.X509Certificate(identity.cert).raw).digest('hex');
const binding=(a,b)=>!!a && !!b && ['id','clientId','certificate','networkId'].every(key=>a[key]===b[key]);
const denied=new Set(['UNPAIRED','RELAY_UNPAIRED','HOST_CERT_CHANGED','KEYCHAIN_UNAVAILABLE','NETWORK_REVOKED','NETWORK_PEER_CHANGED']);
const fatal=new Set(['TERMINAL_UNPAIRED','TERMINAL_UNSUPPORTED','TERMINAL_USER_REQUIRED','TERMINAL_STALE','TERMINAL_NOT_FOUND','TERMINAL_OFFSET','TERMINAL_SEQUENCE','TERMINAL_ID_CONFLICT','TERMINAL_INPUT_CONFLICT','TERMINAL_MOUSE_SEQUENCE','TERMINAL_MOUSE_CONFLICT','TERMINAL_INVALID_RESPONSE','TERMINAL_BAD_REQUEST']);
const messages={TERMINAL_BUSY:'电脑正在处理终端请求',TERMINAL_CAPACITY:'运行中的终端已达上限，请先结束一个会话',TERMINAL_UNPAIRED:'电脑已撤销终端授权，请重新配对',TERMINAL_STALE:'电脑终端服务已重启，请重新选择会话',TERMINAL_NOT_FOUND:'会话已结束或记录已过期',TERMINAL_CLOSED:'此终端已经结束',TERMINAL_OFFSET:'终端输出位置不一致，请重新连接会话',TERMINAL_SEQUENCE:'输入确认顺序不一致，已停止发送',TERMINAL_ID_CONFLICT:'终端会话身份不一致，已停止发送',TERMINAL_INPUT_CONFLICT:'未确认输入与电脑记录不一致，已停止发送',TERMINAL_USER_REQUIRED:'电脑需要有已登录的普通用户',TERMINAL_UNSUPPORTED:'电脑端暂不支持终端，请更新 ClipRelay',TERMINAL_UNAVAILABLE:'暂时无法连接电脑终端',TERMINAL_INVALID_RESPONSE:'电脑返回的终端数据无效，已停止连接',TERMINAL_BAD_REQUEST:'终端请求无效',TERMINAL_INPUT_FULL:'输入队列已满，请等待确认后继续',TERMINAL_TARGET_CHANGED:'请选择原配对电脑后继续',TERMINAL_VIEW_CHANGED:'会话已切换，旧输入已丢弃',TERMINAL_PAUSED:'终端连接已暂停',TERMINAL_RETRY_EXHAUSTED:'暂时无法恢复终端，请检查连接后手动继续'};
function message(error){return messages[error?.code] || pairedMessage(error);}
Object.assign(messages,{TERMINAL_PASTE_LIMIT:'一次最多粘贴 16 KB 文本，请分次确认发送',TERMINAL_PASTE_EMPTY:'没有可粘贴的文本',TERMINAL_PASTE_HOST:'这台电脑暂不支持长粘贴，请更新电脑端 ClipRelay 后重试',TERMINAL_PASTE_CHANGED:'粘贴预览已失效，请重新粘贴并确认'});
Object.assign(messages,{TERMINAL_MOUSE_HOST:'请更新电脑端 ClipRelay 后使用终端鼠标',TERMINAL_MOUSE_WAIT:'画面和尺寸正在同步，请稍后重新按下',TERMINAL_MOUSE_MODE:'程序的鼠标模式已改变，请重新按下',TERMINAL_MOUSE_GESTURE:'拖动已停止，请重新按下',TERMINAL_MOUSE_FULL:'鼠标请求过多，已停止本次拖动',TERMINAL_MOUSE_SEQUENCE:'鼠标确认顺序不一致，已停止发送',TERMINAL_MOUSE_CONFLICT:'鼠标请求与电脑记录不一致，已停止发送'});
class TerminalController{
  constructor({store,request=protocol.request,now=()=>performance.now()}){
    Object.assign(this,{store,request,now});this.phase='idle';this.view=crypto.randomBytes(16).toString('hex');this.states=new Map();this.sessions=[];this.selected='';this.instance='';this.nextOpen=0;this.pendingAction=null;this.status='';this.error='';this.notice='';this.desired={columns:100,rows:30};this.needList=true;this.retryAt=0;this.failures=0;this.retryStarted=0;
    this.mice=new Map();this.mouseProtocol=0;this.shownOffset=0;this.shownDimensions=null;this.frameReceipt=null;this.lastRead=-Infinity;this.lastKeyboard=-Infinity;this.nonMouse=0;this.lastInputOp='';
  }
  snapshot(){const current=this.states.get(this.selected),mouse=this.mice.get(this.selected);return {phase:this.phase,hostName:this.bound?.name || '',hostId:this.bound?.id || '',view:this.view,screen:this.screen || '',selected:this.selected,sessions:this.sessions.map(s=>({...s})),error:this.error?message({code:this.error}):'',notice:this.notice,queuedBytes:current?.queuedBytes || 0,uncertain:!!current?.pending || !!this.pendingAction,accepted:current?.snapshot.acceptedSequence || 0,written:current?.snapshot.writtenSequence || 0,busy:!!this.operation,mouse:{supported:this.mouseProtocol===1,ready:this.mouseReady(),available:mouseEnabled(current?.snapshot.mouse),revision:mouse?.revision || 0,buttons:mouse?.buttons || 0,busy:mouse?.busy() || false}};}
  mouseReady(){const s=this.states.get(this.selected)?.snapshot;return !!(this.mouseProtocol===1 && this.phase==='ready' && s?.state==='running' && mouseEnabled(s.mouse) && !this.pasteDraft && this.shownOffset>=s.mouse.offset && this.shownOffset>=(this.replayUntil || 0) && ['columns','rows'].every(key=>s[key]===this.desired[key] && s[key]===this.shownDimensions?.[key]));}
  mouseUpdate(session){requireValue(this.mouseProtocol!==1 || session.mouse);if(!session.mouse){this.mice.get(session.id)?.stop();this.mice.delete(session.id);return;}const state=this.mice.get(session.id);if(state)state.refresh(session.mouse);else this.mice.set(session.id,new MouseState(session.mouse,this.now));}
  parsed(data){const receipt=this.frameReceipt;this.checkView(data);requireValue(receipt && receipt.token===data.token && receipt.view===data.view && receipt.id===data.id,'TERMINAL_VIEW_CHANGED');this.shownOffset=receipt.next;this.shownDimensions={columns:receipt.columns,rows:receipt.rows};this.frameReceipt=null;return this.snapshot();}
  mouse(data){
    this.checkView(data);const state=this.mice.get(this.selected);requireValue(this.mouseProtocol===1 && state,'TERMINAL_MOUSE_HOST');
    requireValue(data.revision===state.revision && data.epoch===state.snapshot?.epoch,'TERMINAL_MOUSE_GESTURE');
    if(data.action==='cancel'){state.stop();return this.snapshot();}
    try{requireValue(this.mouseReady(),'TERMINAL_MOUSE_WAIT');if(data.action==='heartbeat')state.heartbeat();else{const s=this.states.get(this.selected).snapshot,m=s.mouse;requireValue(m.format===1016 || data.column<=s.columns && data.row<=s.rows,'TERMINAL_BAD_REQUEST');requireValue(m.format!==0 || data.column<=223 && data.row<=223,'TERMINAL_BAD_REQUEST');state.enqueue(data);}}catch(error){state.stop();throw error;}
    return this.snapshot();
  }
  target(){
    const host=this.store.selected();requireValue(!this.closed && host?.enabled && !this.store.data.legacySelected,'PAIRING_REQUIRED');if(denied.has(this.status))throw fault(this.status);
    if(this.bound)requireValue(binding(host,this.bound),'TERMINAL_TARGET_CHANGED');if(host.routeBlocked)throw fault(host.routeBlocked);requireValue(host.routeReady!==false,'NETWORK_NOT_READY');return {...host};
  }
  guard(operation){requireValue(this.operation===operation && !operation.abort.signal.aborted && operation.view===this.view,'CANCELLED');requireValue(sameRoute(this.target(),operation.host),'NETWORK_NOT_READY');}
  async call(command){
    requireValue(!this.operation,'TERMINAL_BUSY');const operation={host:this.target(),abort:new AbortController(),view:this.view};this.operation=operation;
    try{
      const identity=await this.store.identity();this.guard(operation);const identityHash=digest(identity);requireValue(!this.identityHash || this.identityHash===identityHash,'TERMINAL_UNPAIRED');
      this.identityHash=identityHash;if(!this.bound)this.bound={...operation.host};const reply=await this.request(operation.host,identity,command,operation.abort.signal);this.guard(operation);return reply;
    }finally{if(this.operation===operation)this.operation=null;}
  }
  bind(){
    requireValue(!this.bound,'TERMINAL_BUSY');this.bound=this.target();this.route={...this.bound};this.phase='connecting';return this.snapshot();
  }
  invalidate(){this.pasteDraft=null;this.operation?.abort.abort();this.view=crypto.randomBytes(16).toString('hex');this.shownOffset=0;this.shownDimensions=null;this.frameReceipt=null;for(const mouse of this.mice.values())mouse.stop();for(const state of this.states.values())if(state.discardUnsent())this.notice='未发送的输入已丢弃；未确认的输入保留原序号等待核对。';}
  pause(){this.invalidate();this.phase='paused';this.error='';}
  resume(){this.target();this.invalidate();this.error='';this.phase='connecting';this.needList=true;this.retryAt=0;this.retryStarted=0;this.failures=0;return this.snapshot();}
  reconcile(status){
    if(status!==undefined)this.status=status;if(!this.bound || this.closed)return;
    const host=this.store.selected();
    if(!host?.enabled || !binding(host,this.bound) || this.store.data.legacySelected || denied.has(this.status) || host.routeBlocked){this.pause();this.error=denied.has(this.status)?this.status:host?.routeBlocked || 'TERMINAL_TARGET_CHANGED';return;}
    if(!sameRoute(host,this.route)){this.route={...host};this.invalidate();this.needList=true;if(!['paused','error','idle'].includes(this.phase)){this.phase='recovering';this.retryAt=0;}}
  }
  initializeView(){
    this.invalidate();const state=this.states.get(this.selected);this.offset=0;this.replayUntil=state?.snapshot.end || 0;this.screen=this.view;return this.snapshot();
  }
  select(id){
    requireValue(this.states.has(id),'TERMINAL_NOT_FOUND');requireValue(!this.pendingAction,'TERMINAL_BUSY');this.invalidate();this.selected=id;this.offset=0;this.replayUntil=this.states.get(id).snapshot.end;this.screen=this.view;this.error='';return this.snapshot();
  }
  checkView(data){this.reconcile();requireValue(data?.view===this.view && data?.id===this.selected,'TERMINAL_VIEW_CHANGED');requireValue(this.phase==='ready','TERMINAL_PAUSED');this.target();const state=this.states.get(this.selected);requireValue(state,'TERMINAL_NOT_FOUND');return state;}
  input(data){
    const state=this.checkView(data);let bytes;
    if(data.binary===true)bytes=protocol.bytes(data.data,16384);else{requireValue(typeof data.text==='string' && data.text.length<=16384,'TERMINAL_BAD_REQUEST');bytes=Buffer.from(data.text,'utf8');}
    state.enqueue(bytes);return this.snapshot();
  }
  checkPaste(data){const state=this.checkView(data);requireValue(state.snapshot.state==='running','TERMINAL_CLOSED');return state;}
  beginPaste(data,text){
    this.checkPaste(data);
    this.mice.get(this.selected)?.stop();
    const prepared=protocol.preparePaste(text);this.pasteDraft={token:crypto.randomBytes(16).toString('hex'),view:this.view,id:this.selected};
    return {...this.pasteDraft,...prepared,limit:16384,hostLimit:this.pasteLimit || 4096};
  }
  cancelPaste(data){if(data?.token===this.pasteDraft?.token)this.pasteDraft=null;}
  submitPaste(data){
    const state=this.checkView(data),draft=this.pasteDraft;requireValue(draft && data.token===draft.token && data.view===draft.view && data.id===draft.id,'TERMINAL_PASTE_CHANGED');
    const prepared=protocol.preparePaste(data.text);
    if(prepared.changed)return {...draft,...prepared,review:true};
    state.enqueuePaste(protocol.pasteBytes(prepared.text,data.bracketed),this.pasteLimit || 0);this.pasteDraft=null;
    return {sent:true,state:this.snapshot()};
  }
  resize(data){this.checkView(data);const dimensions=protocol.dimensions(data.columns,data.rows);if(dimensions.columns!==this.desired.columns || dimensions.rows!==this.desired.rows){this.mice.get(this.selected)?.stop();this.shownDimensions=null;}this.desired=dimensions;return this.snapshot();}
  open(shell){
    requireValue(this.phase==='ready' && !this.pendingAction && !!this.instance,'TERMINAL_BUSY');requireValue(['cmd','powershell'].includes(shell),'TERMINAL_BAD_REQUEST');this.target();this.invalidate();
    this.pendingAction={op:'open',instance:this.instance,id:crypto.randomBytes(16).toString('hex'),shell,...this.desired,sequence:this.nextOpen};return this.snapshot();
  }
  end(data){
    const state=this.checkView(data);requireValue(!this.pendingAction,'TERMINAL_BUSY');this.invalidate();state.discardUnsent();this.pendingAction={op:'close',instance:this.instance,id:this.selected};return this.snapshot();
  }
  async refresh(){
    const reply=await this.call({op:'list'}),restarted=this.instance && this.instance!==reply.instance;
    if(restarted){this.invalidate();this.screen=this.view;this.states.clear();this.mice.clear();this.selected='';this.pendingAction=null;this.notice='电脑终端服务已重启，旧输入已停止。请选择或新建会话。';}
    if(this.mouseProtocol!==(reply.mouseProtocol || 0)){this.invalidate();this.mouseProtocol=reply.mouseProtocol || 0;}
    if(this.pasteLimit!==(reply.pasteLimit || 0))this.pasteDraft=null;this.pasteLimit=reply.pasteLimit || 0;
    this.instance=reply.instance;this.nextOpen=reply.nextOpen;const known=new Set();
    for(const item of reply.sessions){known.add(item.id);const state=this.states.get(item.id);if(state)state.refresh(item);else this.states.set(item.id,new InputState(item));this.mouseUpdate(item);}
    for(const id of this.states.keys())if(!known.has(id)){this.states.delete(id);this.mice.delete(id);if(id===this.selected){this.invalidate();this.selected='';this.notice='原会话已结束或记录过期。';}}
    this.sessions=reply.sessions;this.needList=false;this.listedAt=this.now();this.phase='ready';this.error='';return reply;
  }
  update(reply){const state=this.states.get(reply.session.id);if(state)state.refresh(reply.session);else this.states.set(reply.session.id,new InputState(reply.session));this.mouseUpdate(reply.session);this.sessions=this.sessions.filter(s=>s.id!==reply.session.id).concat([{...reply.session}]).sort((a,b)=>a.openSequence-b.openSequence);}
  failure(error){
    if(error?.code==='CANCELLED')return;
    const code=error?.code || 'TERMINAL_UNAVAILABLE';this.error=messages[code] || denied.has(code) || ['NETWORK_NOT_READY','NETWORK_PAUSED','NETWORK_REVOKED','NETWORK_PEER_CHANGED','PAIRING_REQUIRED','UPDATE_HOST','TIMEOUT'].includes(code)?code:'TERMINAL_UNAVAILABLE';
    this.pasteDraft=null;this.needList=true;this.healthySince=0;for(const mouse of this.mice.values())mouse.stop();for(const state of this.states.values())state.discardUnsent();
    if(code==='TERMINAL_CAPACITY'){this.pendingAction=null;this.phase='ready';return;}
    if(fatal.has(code) || denied.has(code) || ['UPDATE_HOST','TERMINAL_TARGET_CHANGED','NETWORK_REVOKED','NETWORK_PEER_CHANGED','PAIRING_REQUIRED','NETWORK_PAUSED'].includes(code)){this.phase='error';return;}
    if(!this.retryStarted)this.retryStarted=this.now();this.failures++;if(this.failures>=12 || this.now()-this.retryStarted>90000){this.phase='error';this.error='TERMINAL_RETRY_EXHAUSTED';return;}
    this.phase='recovering';this.retryAt=this.now()+Math.min(5000,500*this.failures);
  }
  async readFrame(){
    const reply=await this.call({op:'read',instance:this.instance,id:this.selected,offset:this.offset});this.update(reply);
    if(reply.gap){this.mice.get(this.selected)?.stop();this.shownOffset=0;this.shownDimensions=null;this.replayUntil=reply.session.end;this.notice='较早的输出已超出电脑保留范围，已重置画面并显示现有输出。';}
    const replay=reply.offset<this.replayUntil,data=replay?reply.data.subarray(0,this.replayUntil-reply.offset):reply.data;this.offset=reply.offset+data.length;
    const frame={view:this.view,token:crypto.randomBytes(16).toString('hex'),next:this.offset,data:data.toString('base64'),gap:reply.gap,replay,columns:reply.session.columns,rows:reply.session.rows};
    this.lastRead=this.now();this.nonMouse=Math.min(2,this.nonMouse+1);this.lastInputOp='read';this.frameReceipt={...frame,id:this.selected};delete this.frameReceipt.data;return frame;
  }
  async sendMouse(mouse,command){try{const reply=await this.call(command);mouse.acknowledge(reply);this.update(reply);this.nonMouse=0;this.lastInputOp='mouse';}catch(error){if(mouse.rejected(error.code)){this.needList=true;this.notice=message(error);}else throw error;}}
  async sendKeys(state){const reply=await this.call(state.command(this.instance));state.acknowledge(reply);this.update(reply);this.lastKeyboard=this.now();this.nonMouse=Math.min(2,this.nonMouse+1);this.lastInputOp='write';}
  async poll(){
    this.reconcile();
    if(this.polling || this.operation || this.closed || ['paused','error','idle'].includes(this.phase) || this.now()<this.retryAt)return {state:this.snapshot()};
    this.polling=true;const generation=this.view;let frame;
    try{
      if(this.needList || !this.instance || this.now()-(this.listedAt || 0)>3000)await this.refresh();
      else if(this.pendingAction){
        const command=this.pendingAction,reply=await this.call(command);this.pendingAction=null;this.update(reply);this.needList=true;
        if(command.op==='open'){this.invalidate();this.screen=this.view;this.selected=reply.session.id;this.offset=0;this.replayUntil=0;}
        else if(command.op==='close'){const state=this.states.get(command.id);state.queue=[];state.queuedBytes=0;state.pending=null;this.notice='会话已结束。';}
      }else{
        const state=this.states.get(this.selected);if(state){
          const mouse=this.mice.get(this.selected),resizing=state.snapshot.state==='running' && this.offset>=this.replayUntil && (state.snapshot.columns!==this.desired.columns || state.snapshot.rows!==this.desired.rows);
          const cancel=mouse?.cancelWanted?mouse.command(this.instance,this.selected):null;
          const mouseTurn=!cancel && mouse?.busy() && this.nonMouse>=2?mouse.command(this.instance,this.selected):null;
          // Cleanup has priority; live movement cannot starve output or keys.
          if(cancel)await this.sendMouse(mouse,cancel);
          else if(mouseTurn)await this.sendMouse(mouse,mouseTurn);
          else if(state.queuedBytes && this.lastInputOp==='read' && this.now()-this.lastKeyboard>=100)await this.sendKeys(state);
          else if(mouse?.busy() && this.now()-this.lastRead>=75)frame=await this.readFrame();
          else if(state.queuedBytes && this.now()-this.lastKeyboard>=100)await this.sendKeys(state);
          else{
            const mouseCommand=mouse?.command(this.instance,this.selected);
            if(mouseCommand)await this.sendMouse(mouse,mouseCommand);
            else if(state.queuedBytes)await this.sendKeys(state);
            else if(resizing)this.update(await this.call({op:'resize',instance:this.instance,id:this.selected,...this.desired}));
            else if(state.snapshot.state==='running' || this.offset<state.snapshot.end)frame=await this.readFrame();
          }
        }
      }
      if(this.phase==='ready'){if(!this.healthySince)this.healthySince=this.now();if(this.now()-this.healthySince>=15000){this.retryStarted=0;this.failures=0;}}
    }catch(error){if(this.view===generation)this.failure(error);}
    finally{this.polling=false;}
    return {state:this.snapshot(),...(frame && frame.view===this.view?{frame}:{})};
  }
  close(){this.closed=true;this.invalidate();this.phase='idle';this.states.clear();this.mice.clear();this.sessions=[];this.pendingAction=null;}
}
module.exports={TerminalController,message};
