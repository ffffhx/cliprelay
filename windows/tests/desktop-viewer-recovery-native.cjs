'use strict';
// Test-only owner for the production supervisor and packaged native viewer.
// Credentials arrive on stdin; stdout contains lifecycle facts only.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),readline=require('node:readline');
const {spawn}=require('node:child_process');
const {StreamViewer}=require('../electron/mac/stream-viewer.cjs');
const {BitrateController}=require('../electron/mac/bitrate-controller.cjs');
const directory=process.argv[2],logs=process.argv[3];
const emit=value=>process.stdout.write(JSON.stringify({atMs:Math.round(performance.now()),...value})+'\n');
let viewer,state,bitrate,number=0,stopping=false;
function stop(){stopping=true;bitrate?.close();viewer?.stop();if(!viewer?.child)process.exit(0);}
const lines=readline.createInterface({input:process.stdin});
lines.on('close',stop);
lines.on('line',async line=>{
  try{
    const value=JSON.parse(line);
    if(!viewer){
      const identity={cert:value.certificate,key:value.privateKey};
      state={data:{legacySelected:false},host:{id:crypto.createHash('sha256').update(new crypto.X509Certificate(value.hostCertificate).raw).digest('hex'),
        name:'Recovery fixture',certificate:value.hostCertificate,clientId:value.clientId,enabled:true,networkId:'fixture',address:value.address,port:value.port,
        overlay:value.overlay,overlayPort:value.overlayPort,routeId:'initial',routeReady:true},selected(){return {...this.host};},async identity(){return identity;}};
      viewer=new StreamViewer({directory,store:state,onUpdate:snapshot=>{bitrate?.reconcile();emit({type:'state',...snapshot});if(stopping && !viewer?.child)process.exit(0);},
        spawnProcess:(file,args,options)=>{
          const log=fs.openSync(path.join(logs,'attempt-'+(++number)+'.log'),'w');
          const child=spawn(file,args,{...options,stdio:['pipe','pipe',log]});fs.closeSync(log);
          emit({type:'spawn',number,pid:child.pid});
          let buffer='';child.stdout.on('data',chunk=>{
            buffer+=chunk.toString();if(buffer.length>4096){buffer='';return;}
            while(buffer.includes('\n')){
              const index=buffer.indexOf('\n'),line=buffer.slice(0,index);buffer=buffer.slice(index+1);
              try{const event=JSON.parse(line);if(event.version===1 && ['connected','ended'].includes(event.event))emit({type:'native',number,event:event.event,reason:event.reason});}catch{}
            }
          });
          child.on('close',code=>emit({type:'closed',number,code,pid:child.pid}));return child;
        }});
      if(value.bitrateTest){
        bitrate=new BitrateController({store:state,viewer});let previous='';
        setInterval(()=>{const snapshot=bitrate.snapshot(),serialized=JSON.stringify(snapshot);if(serialized!==previous){previous=serialized;emit({type:'bitrate',...snapshot});}},50).unref();
      }
      await viewer.open({width:value.width,height:value.height,fps:value.fps,bitrate:value.bitrate,fullscreen:value.fullscreen});
    }else if(value.action==='route'){
      state.host.routeReady=value.ready;if(value.ready){state.host.port=value.port;state.host.routeId=value.id;}
      emit({type:'route',ready:value.ready});
      viewer.reconcile();
    }else if(value.action==='bitrate'){
      bitrate.apply({viewId:bitrate.snapshot().viewId,budgetKbps:value.budgetKbps});
    }else if(value.action==='stop')stop();
    else throw Error('invalid command');
  }catch(error){emit({type:'failure',code:error.code || 'FIXTURE_ERROR'});if(!viewer)process.exit(1);else stop();}
});
setTimeout(()=>{emit({type:'failure',code:'FIXTURE_DEADLINE'});stop();},110000).unref();
