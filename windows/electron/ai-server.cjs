'use strict';
const net=require('node:net'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {fault}=require('./mac/paired-transport.cjs');
const {AiCliLeases}=require('./ai-cli-leases.cjs');
class AiServer{
  constructor({directory,controller,now}){this.directory=directory;this.controller=controller;this.file=path.join(directory,'ai-endpoint.json');this.connections=new Set();this.cli=new AiCliLeases(controller,now);}
  async start(){
    if(this.server?.listening)return;
    this.token=crypto.randomBytes(32).toString('hex');
    this.address=process.platform==='win32'?'\\\\.\\pipe\\ClipRelay-AI-'+crypto.randomBytes(16).toString('hex'):path.join(this.directory,'ai-'+crypto.randomBytes(8).toString('hex')+'.sock');
    this.server=net.createServer(socket=>this.accept(socket));
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.address,resolve);});
    const temporary=this.file+'.'+crypto.randomBytes(8).toString('hex');
    fs.writeFileSync(temporary,JSON.stringify({protocol:1,address:this.address,token:this.token,pid:process.pid}),{mode:0o600,flag:'wx'});fs.renameSync(temporary,this.file);
    this.leaseTimer=setInterval(()=>{void this.cli.maintain().catch(()=>{});},5000);this.leaseTimer.unref();
  }
  accept(socket){
    let owner=crypto.randomBytes(16).toString('hex'),authenticated=false,buffer='',running=false,closing=false,cliMode=false,lease;
    socket.setEncoding('utf8');this.connections.add(socket);
    const timer=setInterval(()=>{if(authenticated&&!cliMode&&!running&&!closing)void this.controller.heartbeat(owner);},20000);timer.unref();
    const release=()=>{if(!lease||this.cli.entries.get(lease.session)!==lease)void this.controller.release(owner);};
    const stop=()=>{closing=true;clearInterval(timer);this.connections.delete(socket);release();};
    socket.on('error',()=>{});socket.on('close',stop);
    socket.on('data',chunk=>{
      buffer+=chunk;if(Buffer.byteLength(buffer)>65536){socket.destroy();return;}
      let offset;while((offset=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,offset);buffer=buffer.slice(offset+1);let message;
        try{message=JSON.parse(line);if(!message||typeof message!=='object'||Array.isArray(message)||!Number.isSafeInteger(message.id))throw new Error();}catch{socket.destroy();return;}
        if(!authenticated){
          if(typeof message.token!=='string'||!/^[a-f0-9]{64}$/.test(message.token)||!crypto.timingSafeEqual(Buffer.from(message.token),Buffer.from(this.token))){socket.destroy();return;}
          cliMode=message.client==='cli';
          if(message.client!==undefined&&!cliMode){socket.destroy();return;}
          if(cliMode&&(message.session!==undefined||message.leaseToken!==undefined)){
            try{lease=this.cli.attach(message.session,message.leaseToken);owner=lease.owner;}
            catch(error){socket.end(JSON.stringify({id:message.id,ok:false,code:error.code})+'\n');return;}
          }
          authenticated=true;socket.write(JSON.stringify({id:message.id,ok:true,result:{protocol:1,cliLeaseProtocol:1}})+'\n');continue;
        }
        if(running){socket.write(JSON.stringify({id:message.id,ok:false,code:'AUTOMATION_BUSY'})+'\n');continue;}
        running=true;
        Promise.resolve().then(async()=>{
          if(cliMode&&lease){this.cli.current(lease);this.cli.touch(lease);}
          if(message.method==='devices')return this.controller.devices();
          if(cliMode){
            if(message.method==='connect'){
              if(lease)throw fault('AUTOMATION_BAD_REQUEST');
              const seconds=this.cli.seconds(message.params?.leaseSeconds);
              const connected=await this.controller.connect(owner,message.params?.deviceId);
              // If the caller disappeared during pairing, do not leave an orphan lease.
              if(closing){await this.controller.release(owner);throw fault('CANCELLED');}
              lease=this.cli.create(owner,connected,seconds);
              return {...connected,leaseToken:lease.token,expiresAt:lease.expiresAt,leaseSeconds:seconds};
            }
            this.cli.current(lease);
            if(message.params?.session!==lease.session)throw fault('AUTOMATION_SESSION_NOT_FOUND');
            if(message.method==='execute'){
              const result=await this.controller.execute(owner,message.params||{});this.cli.touch(lease);return {...result,expiresAt:lease.expiresAt};
            }
            if(message.method==='disconnect'){try{return await this.controller.disconnect(owner,lease.session);}finally{this.cli.forget(lease);}}
            throw fault('AUTOMATION_BAD_REQUEST');
          }
          if(message.method==='connect')return this.controller.connect(owner,message.params?.deviceId);
          if(message.method==='execute')return this.controller.execute(owner,message.params||{});
          if(message.method==='disconnect')return this.controller.disconnect(owner,message.params?.session);
          throw fault('AUTOMATION_BAD_REQUEST');
        }).then(result=>{if(!closing)socket.write(JSON.stringify({id:message.id,ok:true,result})+'\n');},error=>{if(!closing)socket.write(JSON.stringify({id:message.id,ok:false,code:error.code||'AUTOMATION_FAILED',requestId:error.requestId})+'\n');}).finally(()=>{running=false;if(closing)release();});
      }
    });
    const authTimer=setTimeout(()=>{if(!authenticated)socket.destroy();},5000);authTimer.unref();socket.once('close',()=>clearTimeout(authTimer));
  }
  async close(){
    clearInterval(this.leaseTimer);this.cli.entries.clear();
    for(const socket of this.connections)socket.destroy();
    this.server?.close();
    try{const current=JSON.parse(fs.readFileSync(this.file,'utf8'));if(current.token===this.token)fs.unlinkSync(this.file);}catch{}
    await this.controller.close();
  }
}
module.exports={AiServer};
