'use strict';
const protocol=require('./input-protocol.cjs');
const presentation=require('./bitrate-protocol.cjs');
const {fault}=require('./paired-transport.cjs');
const transient=new Set(['HTTP_429','HTTP_503','TIMEOUT','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH']);
const integer=(value,min=0,max=0xffffffff)=>Number.isSafeInteger(value)&&value>=min&&value<=max;

// Owned by one native viewer record. Renderer IPC never reaches these methods.
// A transition needs local submission, authenticated host state, then local ACK.
class InputSession {
  constructor({host,identity,instance,write,current,progress,onChange=()=>{},onFailure=()=>{},
    readInput=protocol.request,readDisplay=(h,i,s)=>presentation.request(h,i,'displays',null,s),pollMs=100,timeoutMs=15000}) {
    Object.assign(this,{host,identity,instance,write,current,progress,onChange,onFailure,readInput,readDisplay,pollMs,timeoutMs});
    this.abort=new AbortController();this.phase='starting';this.epoch=0;this.stream=0;this.busy=false;this.error='';
  }
  snapshot(){return {phase:this.phase,epoch:this.epoch,error:this.error};}
  check(){if(this.closed||!this.current())throw fault(this.error||'CANCELLED');}
  change(phase){this.phase=phase;this.onChange();}
  close(code='CANCELLED',notify=false){
    if(this.closed)return;
    this.closed=true;this.error=code;this.phase='closed';clearTimeout(this.deadline);this.abort.abort();
    const waiter=this.waiter;this.waiter=null;waiter?.reject(fault(code));
    this.identity=null;
    if(notify)this.onFailure(code);
  }
  fail(error){this.close(error.code||'INPUT_UNAVAILABLE',true);}
  async operation(action){
    this.check();if(this.busy)throw fault('INPUT_BUSY');this.busy=true;
    this.deadline=setTimeout(()=>this.close('INPUT_TIMEOUT',true),this.timeoutMs);this.deadline.unref?.();
    try{return await action();}
    catch(error){this.fail(error);throw fault(this.error||error.code||'INPUT_UNAVAILABLE');}
    finally{this.busy=false;clearTimeout(this.deadline);}
  }
  async delay(){
    this.check();
    await new Promise((resolve,reject)=>{
      const abort=()=>{clearTimeout(timer);this.abort.signal.removeEventListener('abort',abort);reject(fault(this.error||'CANCELLED'));};
      const timer=setTimeout(()=>{this.abort.signal.removeEventListener('abort',abort);resolve();},this.pollMs);
      this.abort.signal.addEventListener('abort',abort,{once:true});
    });
    this.check();
  }
  async read(reader){
    for(;;){
      this.check();
      try{const value=await reader(this.host,this.identity,this.abort.signal);this.check();return value;}
      catch(error){this.check();if(!transient.has(error.code))throw error;await this.delay();}
    }
  }
  async bind(){
    for(;;){
      const state=await this.read(this.readInput);
      if(!state.supported||state.instance!==this.instance)throw fault('INPUT_CHANGED');
      if(state.streams.length>1)throw fault('INPUT_NOT_EXCLUSIVE');
      if(state.streams.length){
        const stream=state.streams[0];
        if(!stream.exclusive)throw fault('INPUT_NOT_EXCLUSIVE');
        if(stream.enabled||stream.closed||stream.failed)throw fault('INPUT_CHANGED');
        this.stream=stream.id;return;
      }
      await this.delay();
    }
  }
  wire(epoch,operation,stage){
    this.check();if(this.waiter)throw fault('INPUT_BUSY');
    return new Promise((resolve,reject)=>{
      this.waiter={epoch,stage,resolve,reject};
      try{this.write(protocol.command(epoch,operation),error=>{if(error)this.fail(error);});}
      catch(error){this.fail(error);}
    });
  }
  receive(value){
    if(this.closed)return;
    try{
      this.check();const event=protocol.event(value),waiter=this.waiter;
      if(!waiter||event.epoch!==waiter.epoch||event.stage!==waiter.stage)throw fault('INPUT_INVALID_EVENT');
      this.waiter=null;waiter.resolve();
    }catch(error){this.fail(error);}
  }
  async hostAcknowledgment(epoch){
    for(;;){
      const state=await this.read(this.readInput);
      if(!state.supported||state.instance!==this.instance||state.streams.length!==1||state.streams[0].id!==this.stream)throw fault('INPUT_CHANGED');
      const stream=state.streams[0];
      if(!stream.exclusive)throw fault('INPUT_NOT_EXCLUSIVE');
      if(stream.closed||stream.failed||stream.epoch>epoch||stream.epoch<this.epoch)throw fault('INPUT_CHANGED');
      if(protocol.acknowledged(state,this.instance,this.stream,epoch))return;
      await this.delay();
    }
  }
  async presented(proof=null){
    if(proof&&(!integer(proof.generation,1,Number.MAX_SAFE_INTEGER)||typeof proof.capture!=='string'||!proof.capture||proof.capture.length>256||
      !integer(proof.firstFrame,1)||!integer(proof.afterFrame)||!integer(proof.width,1,65536)||!integer(proof.height,1,65536)))throw fault('INPUT_INVALID_PRESENTATION');
    for(;;){
      const display=await this.read(this.readDisplay);
      if(!display.supported||display.instance!==this.instance||display.stream?.id!==this.stream)throw fault('INPUT_CHANGED');
      if(proof&&(display.generation!==proof.generation||display.capture!==proof.capture||display.stream.firstFrame!==proof.firstFrame||
        display.stream.width!==proof.width||display.stream.height!==proof.height))throw fault('INPUT_DISPLAY_CHANGED');
      const progress=this.progress();
      if(presentation.presented(display,progress)&&progress.rendered>(proof?.afterFrame||0))return Object.freeze({
        generation:display.generation,capture:display.capture,firstFrame:display.stream.firstFrame,
        afterFrame:proof?.afterFrame||0,width:display.stream.width,height:display.stream.height});
      await this.delay();
    }
  }
  async transition(paused,proof=null){
    this.check();const epoch=this.epoch+1;
    if(epoch>0xffffffff||Boolean(epoch&1)!==paused)throw fault('INPUT_INVALID_COMMAND');
    this.change(paused?'pausing':'resuming');
    await this.wire(epoch,paused?'pause':'resume','submitted');
    await this.hostAcknowledgment(epoch);
    // The host may have resumed, but the native producer remains closed until
    // this last presentation check and its owner acknowledgment both succeed.
    if(!paused)await this.presented(proof);
    await this.wire(epoch,'acknowledge','acknowledged');
    this.check();this.epoch=epoch;this.change(paused?'paused':'active');
    return {instance:this.instance,stream:this.stream,epoch};
  }
  initialize(){
    if(this.phase!=='starting')return Promise.reject(fault('INPUT_BUSY'));
    return this.operation(async()=>{await this.bind();await this.transition(true);const proof=await this.presented();return this.transition(false,proof);});
  }
  pause(){
    if(this.phase!=='active')return Promise.reject(fault('INPUT_BUSY'));
    return this.operation(()=>this.transition(true));
  }
  resume(proof){
    if(this.phase!=='paused'||!proof)return Promise.reject(fault('INPUT_BUSY'));
    return this.operation(async()=>{await this.presented(proof);return this.transition(false,proof);});
  }
}
module.exports={InputSession};
