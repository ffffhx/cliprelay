'use strict';
const crypto=require('node:crypto');
const {fault}=require('./mac/paired-transport.cjs');
const validToken=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
class AiCliLeases{
  constructor(controller,now=Date.now){this.controller=controller;this.now=now;this.entries=new Map();this.maintaining=false;}
  seconds(value=300){if(!Number.isInteger(value)||value<60||value>1800)throw fault('AUTOMATION_BAD_REQUEST');return value;}
  create(owner,connected,seconds){
    const entry={session:connected.session,owner,token:crypto.randomBytes(32).toString('hex'),seconds,expiresAt:0,lastHeartbeat:this.now()};
    this.touch(entry);this.entries.set(entry.session,entry);return entry;
  }
  attach(session,token){
    const entry=this.entries.get(session);
    if(!entry||entry.expiresAt<=this.now()||!validToken(token)||!crypto.timingSafeEqual(Buffer.from(token),Buffer.from(entry.token)))throw fault('AUTOMATION_CLI_SESSION_ENDED');
    return entry;
  }
  current(entry){if(!entry||this.entries.get(entry.session)!==entry||entry.expiresAt<=this.now())throw fault('AUTOMATION_CLI_SESSION_ENDED');return entry;}
  touch(entry){entry.expiresAt=this.now()+entry.seconds*1000;}
  forget(entry){if(entry)this.entries.delete(entry.session);}
  async maintain(){
    if(this.maintaining)return;this.maintaining=true;
    try{await Promise.all([...this.entries.values()].map(async entry=>{
      if(entry.expiresAt<=this.now()){this.forget(entry);await this.controller.release(entry.owner);}
      else if(this.now()-entry.lastHeartbeat>=20000){entry.lastHeartbeat=this.now();if(await this.controller.heartbeat(entry.owner)===false)entry.lastHeartbeat=this.now()-20000;}
    }));}finally{this.maintaining=false;}
  }
}
module.exports={AiCliLeases};
