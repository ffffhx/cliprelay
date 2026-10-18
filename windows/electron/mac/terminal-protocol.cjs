'use strict';
const {jsonRequest,endpoint,fault}=require('./paired-transport.cjs');
const MAX=Number.MAX_SAFE_INTEGER;
const codes=new Set('BUSY CAPACITY UNPAIRED STALE NOT_FOUND CLOSED OFFSET SEQUENCE ID_CONFLICT INPUT_CONFLICT MOUSE_MODE MOUSE_GESTURE MOUSE_SEQUENCE MOUSE_CONFLICT USER_REQUIRED UNSUPPORTED UNAVAILABLE INVALID_RESPONSE BAD_REQUEST'.split(' ').map(value=>'TERMINAL_'+value));
const id=value=>typeof value==='string' && /^[a-f0-9]{32}$/.test(value);
const number=(value,min=0,max=MAX)=>Number.isSafeInteger(value) && value>=min && value<=max;
const knownShells=['powershell','cmd','zsh','bash'];
function shells(value){
  if(value===undefined)return ['powershell','cmd'];
  requireValue(Array.isArray(value) && value.length>0 && value.length<=4 && new Set(value).size===value.length && value.every(shell=>knownShells.includes(shell)));
  return [...value];
}
function requireValue(value,code='TERMINAL_INVALID_RESPONSE'){if(!value)throw fault(code);}
function dimensions(columns,rows){requireValue(number(columns,20,240) && number(rows,5,120),'TERMINAL_BAD_REQUEST');return {columns,rows};}
function bytes(data,max){requireValue(typeof data==='string' && data.length<=Math.ceil(max/3)*4);const value=Buffer.from(data,'base64');requireValue(value.length<=max && value.toString('base64')===data);return value;}
function preparePaste(value){
  requireValue(typeof value==='string' && value.length<=32768,'TERMINAL_PASTE_LIMIT');
  // Reject malformed UTF-16 instead of silently replacing a command character.
  for(const char of value){const code=char.codePointAt(0);requireValue(code<0xd800 || code>0xdfff,'TERMINAL_BAD_REQUEST');}
  const text=value.replace(/\r\n?/g,'\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'');
  requireValue(Buffer.byteLength(text)<=16384,'TERMINAL_PASTE_LIMIT');requireValue(text.length>0,'TERMINAL_PASTE_EMPTY');
  return {text,changed:text!==value};
}
function pasteBytes(text,bracketed){requireValue(typeof bracketed==='boolean','TERMINAL_BAD_REQUEST');return Buffer.from((bracketed?'\x1b[200~':'')+text.replace(/\n/g,'\r')+(bracketed?'\x1b[201~':''),'utf8');}
function mouse(value,end){
  if(value===undefined || value===null)return null;
  requireValue(value && [-1,0,9,1000,1001,1002,1003].includes(value.mode) && [-1,0,1005,1006,1015,1016].includes(value.format));
  requireValue(number(value.epoch,1) && number(value.offset,0,end) && number(value.buttons,0,7) && number(value.remainingMs,0,1500) && number(value.gesture) && number(value.nextGesture,value.gesture+1) && number(value.acceptedSequence) && number(value.writtenSequence,0,value.acceptedSequence));
  requireValue(['idle','pending','held','expired','cancelled','mode-changed','closed'].includes(value.phase) && ['none','queued','written','renewed','cancelled','expired','mode-changed'].includes(value.outcome));
  requireValue(value.phase!=='closed' || value.buttons===0 && value.remainingMs===0);
  return Object.fromEntries(['mode','format','epoch','offset','buttons','remainingMs','gesture','nextGesture','acceptedSequence','writtenSequence','phase','outcome'].map(key=>[key,value[key]]));
}
function session(value){
  requireValue(value && id(value.id) && knownShells.includes(value.shell) && ['running','closed','exited','expired','revoked','failed'].includes(value.state));
  requireValue(number(value.columns,20,240) && number(value.rows,5,120) && number(value.exitCode,-2147483648,2147483647) && number(value.openSequence,1) && number(value.acceptedSequence) && number(value.writtenSequence,0,value.acceptedSequence) && number(value.start) && number(value.end,value.start) && value.end-value.start<=1048576 && number(value.remainingMs,0,1800000));
  return {...Object.fromEntries(['id','shell','state','columns','rows','exitCode','openSequence','acceptedSequence','writtenSequence','start','end','remainingMs'].map(key=>[key,value[key]])),mouse:mouse(value.mouse,value.end)};
}
function validate(command,value){
  requireValue(value && typeof value==='object' && !Array.isArray(value) && typeof value.ok==='boolean');
  if(!value.ok)throw fault(codes.has(value.code)?value.code:'TERMINAL_UNAVAILABLE');requireValue(id(value.instance));
  if(command.op==='list'){
    const supported=shells(value.shells);
    requireValue(number(value.nextOpen,1) && (!value.sessions || Array.isArray(value.sessions) && value.sessions.length<=32) && !value.session && !value.data);
    const ids=new Set(),sequences=new Set(),sessions=(value.sessions || []).map(item=>{
      const s=session(item);requireValue(supported.includes(s.shell) && !ids.has(s.id) && !sequences.has(s.openSequence) && s.openSequence<value.nextOpen);ids.add(s.id);sequences.add(s.openSequence);return s;
    });requireValue(value.pasteLimit===undefined || value.pasteLimit===0 || value.pasteLimit===16396);
    requireValue(value.mouseProtocol===undefined || value.mouseProtocol===0 || value.mouseProtocol===1);requireValue(value.mouseProtocol!==1 || sessions.every(s=>s.mouse));
    return {instance:value.instance,nextOpen:value.nextOpen,pasteLimit:value.pasteLimit || 0,mouseProtocol:value.mouseProtocol || 0,shells:supported,sessions};
  }
  requireValue(value.instance===command.instance && !value.sessions?.length && value.shells===undefined);const current=session(value.session);requireValue(current.id===command.id);
  if(command.op==='open')requireValue(current.openSequence===command.sequence && current.shell===command.shell);
  if(command.op==='write' || command.op==='paste')requireValue(current.acceptedSequence===command.sequence);
  if(command.op==='mouse')requireValue(current.mouse && current.mouse.acceptedSequence===command.sequence);
  if(command.op==='resize')requireValue(current.columns===command.columns && current.rows===command.rows);
  const result={instance:value.instance,session:current};
  if(command.op==='read'){
    const data=bytes(value.data || '',32768);requireValue(number(value.offset,command.offset) && number(value.next,value.offset,current.end) && value.next-value.offset===data.length && typeof value.gap==='boolean' && value.gap===(value.offset!==command.offset));
    return {...result,offset:value.offset,next:value.next,gap:value.gap,data};
  }requireValue(!value.data);return result;
}
async function request(host,identity,command,signal){
  const target=endpoint(host.address,host.port),reply=await jsonRequest({address:target.address,port:target.port+2,path:'/v1/terminal',body:command,identity,trust:{cert:host.certificate},signal,timeout:17000,limit:65536,acceptStatuses:[200,409,429,503]});
  return validate(command,reply);
}
class InputState{
  constructor(snapshot){this.snapshot=snapshot;this.queue=[];this.queuedBytes=0;this.pending=null;}
  enqueue(data){
    requireValue(this.snapshot.state==='running','TERMINAL_CLOSED');requireValue(Buffer.isBuffer(data) && data.length>0 && data.length<=16384 && this.queuedBytes+data.length<=32768,'TERMINAL_INPUT_FULL');
    for(let offset=0;offset<data.length;offset+=4096)this.queue.push({op:'write',bytes:Buffer.from(data.subarray(offset,offset+4096))});this.queuedBytes+=data.length;
  }
  enqueuePaste(data,limit){
    requireValue(this.snapshot.state==='running','TERMINAL_CLOSED');requireValue(Buffer.isBuffer(data) && data.length>0 && data.length<=16396,'TERMINAL_BAD_REQUEST');
    requireValue(limit===16396 || limit===0,'TERMINAL_INVALID_RESPONSE');requireValue(data.length<=(limit || 4096),'TERMINAL_PASTE_HOST');
    requireValue(this.queuedBytes+data.length<=32768,'TERMINAL_INPUT_FULL');
    this.queue.push({op:limit?'paste':'write',bytes:Buffer.from(data)});this.queuedBytes+=data.length;
  }
  command(instance){
    if(!this.pending && this.queue.length){requireValue(this.snapshot.acceptedSequence<MAX,'TERMINAL_SEQUENCE');this.pending={op:this.queue[0].op,instance,id:this.snapshot.id,sequence:this.snapshot.acceptedSequence+1,data:this.queue[0].bytes.toString('base64')};}
    return this.pending?{...this.pending}:null;
  }
  refresh(snapshot){
    requireValue(snapshot.id===this.snapshot.id && snapshot.openSequence===this.snapshot.openSequence && snapshot.shell===this.snapshot.shell && snapshot.acceptedSequence>=this.snapshot.acceptedSequence && snapshot.writtenSequence>=this.snapshot.writtenSequence && snapshot.end>=this.snapshot.end);
    if(this.pending)requireValue([this.pending.sequence-1,this.pending.sequence].includes(snapshot.acceptedSequence),'TERMINAL_SEQUENCE');this.snapshot=snapshot;
  }
  acknowledge(reply){requireValue(this.pending && reply.instance===this.pending.instance && reply.session.id===this.pending.id && reply.session.acceptedSequence===this.pending.sequence);this.refresh(reply.session);this.queuedBytes-=this.queue.shift().bytes.length;this.pending=null;}
  discardUnsent(){const keep=this.pending?this.queue[0]:null,discarded=this.queue.length>(keep?1:0);this.queue=keep?[keep]:[];this.queuedBytes=keep?keep.bytes.length:0;return discarded;}
}
module.exports={MAX,codes,id,number,requireValue,dimensions,bytes,preparePaste,pasteBytes,shells,session,validate,request,InputState};
