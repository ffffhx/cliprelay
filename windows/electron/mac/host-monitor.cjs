'use strict';
// Background reads belong to the current native host session, not a window.
class HostMonitor{
  constructor({session,read,version=()=>0,onRequests=()=>{},onError=()=>{},onNotice=()=>{},
    wallNow=()=>Date.now(),now=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout,pollMs=1500}){
    Object.assign(this,{session,read,version,onRequests,onError,onNotice,wallNow,now,setTimer,clearTimer,pollMs});
    this.tasks=new Set();this.issued=[];this.closed=false;
  }
  current(r){return !this.closed && this.record===r && !r.abort.signal.aborted && this.session.current===r.session && this.session.snapshot().phase==='running';}
  reconcile(){
    if(this.record && this.current(this.record))return;
    if(this.record){this.clearTimer(this.record.timer);this.record.abort.abort();this.record=null;}
    if(!this.closed && this.session.current && this.session.snapshot().phase==='running'){
      const r=this.record={session:this.session.current,abort:new AbortController(),seen:new Map(),timer:null};this.schedule(r,0);
    }
  }
  schedule(r,delay=this.pollMs){
    if(!this.current(r))return;
    r.timer=this.setTimer(()=>{
      r.timer=null;const task=this.poll(r);this.tasks.add(task);task.then(()=>this.tasks.delete(task),()=>this.tasks.delete(task));
    },delay);r.timer?.unref?.();
  }
  async poll(r){
    const version=this.version();
    try{
      const result=await this.read(r.abort.signal);
      if(!this.current(r) || this.version()!==version)return;
      const wall=this.wallNow()/1000,waiting=result.requests.filter(request=>request.state==='waiting' && request.expires>wall);
      this.onRequests(result.requests);
      // A callback may stop/replace the host. Do not notify for its old result.
      if(!this.current(r) || this.version()!==version)return;
      for(const [key,expires] of r.seen)if(expires<=wall)r.seen.delete(key);
      const unseen=waiting.some(request=>!r.seen.has(request.id+':'+request.generation));
      const now=this.now();this.issued=this.issued.filter(at=>now-at<60000);
      if(unseen && this.issued.length<4){
        this.issued.push(now);
        for(const request of waiting)r.seen.set(request.id+':'+request.generation,request.expires);
        while(r.seen.size>128)r.seen.delete(r.seen.keys().next().value);
        try{this.onNotice({count:waiting.length});}catch{}
      }
    }catch(error){
      if(this.current(r) && this.version()===version && !['HOST_PAIR_CANCELLED','HOST_PAIR_CLOSED'].includes(error.code)){
        try{this.onError(error);}catch{}
      }
    }finally{this.schedule(r);}
  }
  join(){return Promise.allSettled([...this.tasks]);}
  close(){this.closed=true;this.reconcile();return this.join();}
}
module.exports={HostMonitor};
