'use strict';
const {jsonRequest,endpoint,fault}=require('./paired-transport.cjs');
const MAX=Number.MAX_SAFE_INTEGER;
const codes=new Set('BUSY CAPACITY UNPAIRED STALE NOT_FOUND CLOSED OFFSET SEQUENCE ID_CONFLICT INPUT_CONFLICT USER_REQUIRED UNSUPPORTED UNAVAILABLE INVALID_RESPONSE BAD_REQUEST'.split(' ').map(value=>'TERMINAL_'+value));
const id=value=>typeof value==='string' && /^[a-f0-9]{32}$/.test(value);
const number=(value,min=0,max=MAX)=>Number.isSafeInteger(value) && value>=min && value<=max;
function requireValue(value,code='TERMINAL_INVALID_RESPONSE'){if(!value)throw fault(code);}
function dimensions(columns,rows){requireValue(number(columns,20,240) && number(rows,5,120),'TERMINAL_BAD_REQUEST');return {columns,rows};}
function bytes(data,max){requireValue(typeof data==='string' && data.length<=Math.ceil(max/3)*4);const value=Buffer.from(data,'base64');requireValue(value.length<=max && value.toString('base64')===data);return value;}
function session(value){
  requireValue(value && id(value.id) && ['cmd','powershell'].includes(value.shell) && ['running','closed','exited','expired','revoked','failed'].includes(value.state));
  requireValue(number(value.columns,20,240) && number(value.rows,5,120) && number(value.exitCode,-2147483648,2147483647) && number(value.openSequence,1) && number(value.acceptedSequence) && number(value.writtenSequence,0,value.acceptedSequence) && number(value.start) && number(value.end,value.start) && value.end-value.start<=1048576 && number(value.remainingMs,0,1800000));
  return Object.fromEntries(['id','shell','state','columns','rows','exitCode','openSequence','acceptedSequence','writtenSequence','start','end','remainingMs'].map(key=>[key,value[key]]));
}
function validate(command,value){
  requireValue(value && typeof value==='object' && !Array.isArray(value) && typeof value.ok==='boolean');
  if(!value.ok)throw fault(codes.has(value.code)?value.code:'TERMINAL_UNAVAILABLE');requireValue(id(value.instance));
  if(command.op==='list'){
    requireValue(number(value.nextOpen,1) && (!value.sessions || Array.isArray(value.sessions) && value.sessions.length<=32) && !value.session && !value.data);
    const ids=new Set(),sequences=new Set(),sessions=(value.sessions || []).map(item=>{
      const s=session(item);requireValue(!ids.has(s.id) && !sequences.has(s.openSequence) && s.openSequence<value.nextOpen);ids.add(s.id);sequences.add(s.openSequence);return s;
    });return {instance:value.instance,nextOpen:value.nextOpen,sessions};
  }
  requireValue(value.instance===command.instance && !value.sessions?.length);const current=session(value.session);requireValue(current.id===command.id);
  if(command.op==='open')requireValue(current.openSequence===command.sequence && current.shell===command.shell);
  if(command.op==='write')requireValue(current.acceptedSequence===command.sequence);
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
    for(let offset=0;offset<data.length;offset+=4096)this.queue.push(Buffer.from(data.subarray(offset,offset+4096)));this.queuedBytes+=data.length;
  }
  command(instance){
    if(!this.pending && this.queue.length){requireValue(this.snapshot.acceptedSequence<MAX,'TERMINAL_SEQUENCE');this.pending={op:'write',instance,id:this.snapshot.id,sequence:this.snapshot.acceptedSequence+1,data:this.queue[0].toString('base64')};}
    return this.pending?{...this.pending}:null;
  }
  refresh(snapshot){
    requireValue(snapshot.id===this.snapshot.id && snapshot.openSequence===this.snapshot.openSequence && snapshot.shell===this.snapshot.shell && snapshot.acceptedSequence>=this.snapshot.acceptedSequence && snapshot.writtenSequence>=this.snapshot.writtenSequence && snapshot.end>=this.snapshot.end);
    if(this.pending)requireValue([this.pending.sequence-1,this.pending.sequence].includes(snapshot.acceptedSequence),'TERMINAL_SEQUENCE');this.snapshot=snapshot;
  }
  acknowledge(reply){requireValue(this.pending && reply.instance===this.pending.instance && reply.session.id===this.pending.id && reply.session.acceptedSequence===this.pending.sequence);this.refresh(reply.session);this.queuedBytes-=this.queue.shift().length;this.pending=null;}
  discardUnsent(){const keep=this.pending?this.queue[0]:null,discarded=this.queue.length>(keep?1:0);this.queue=keep?[keep]:[];this.queuedBytes=keep?keep.length:0;return discarded;}
}
module.exports={MAX,codes,id,number,requireValue,dimensions,bytes,session,validate,request,InputState};
