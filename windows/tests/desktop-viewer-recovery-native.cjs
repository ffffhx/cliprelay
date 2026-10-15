'use strict';
// Test-only owner for the production supervisor and packaged native viewer.
// Credentials arrive on stdin; stdout contains lifecycle facts only.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),readline=require('node:readline');
const {spawn}=require('node:child_process');
const {StreamViewer}=require('../electron/mac/stream-viewer.cjs');
const {BitrateController}=require('../electron/mac/bitrate-controller.cjs');
const {DisplayController}=require('../electron/mac/display-controller.cjs');
const directory=process.argv[2],logs=process.argv[3];
const emit=value=>process.stdout.write(JSON.stringify({atMs:Math.round(performance.now()),...value})+'\n');
let viewer,state,bitrate,displays,number=0,stopping=false,inputTest=false,switching=false;
function stop(){stopping=true;displays?.close();bitrate?.close();viewer?.stop();if(!viewer?.child)process.exit(0);}
const lines=readline.createInterface({input:process.stdin});
lines.on('close',stop);
lines.on('line',async line=>{
  try{
    const value=JSON.parse(line);
    if(!viewer){
      const identity={cert:value.certificate,key:value.privateKey};
      inputTest=value.inputTest===true;
      state={data:{legacySelected:false},host:{id:crypto.createHash('sha256').update(new crypto.X509Certificate(value.hostCertificate).raw).digest('hex'),
        name:'Recovery fixture',certificate:value.hostCertificate,clientId:value.clientId,enabled:true,networkId:'fixture',address:value.address,port:value.port,
        overlay:value.overlay,overlayPort:value.overlayPort,routeId:'initial',routeReady:true},selected(){return {...this.host};},async identity(){return identity;}};
      viewer=new StreamViewer({directory,store:state,onUpdate:snapshot=>{bitrate?.reconcile();displays?.reconcile();emit({type:'state',...snapshot});if(stopping && !viewer?.child)process.exit(0);},
        spawnProcess:(file,args,options)=>{
          const log=fs.openSync(path.join(logs,'attempt-'+(++number)+'.log'),'w');
          const child=spawn(file,args,{...options,stdio:['pipe','pipe',log]});fs.closeSync(log);
          emit({type:'spawn',number,pid:child.pid});
          let buffer='';child.stdout.on('data',chunk=>{
            buffer+=chunk.toString();if(buffer.length>4096){buffer='';return;}
            while(buffer.includes('\n')){
              const index=buffer.indexOf('\n'),line=buffer.slice(0,index);buffer=buffer.slice(index+1);
              try{const event=JSON.parse(line);if(event.version===1 && ['connected','ended','input'].includes(event.event))emit({type:'native',number,event:event.event,reason:event.reason,epoch:event.epoch,stage:event.stage});}catch{}
            }
          });
          child.on('close',code=>emit({type:'closed',number,code,pid:child.pid}));return child;
        }});
      if(value.bitrateTest){
        bitrate=new BitrateController({store:state,viewer});let previous='';
        setInterval(()=>{const snapshot=bitrate.snapshot(),serialized=JSON.stringify(snapshot);if(serialized!==previous){previous=serialized;emit({type:'bitrate',...snapshot});}},50).unref();
      }
      if(inputTest)displays=new DisplayController({store:state,viewer});
      await viewer.open({width:value.width,height:value.height,fps:value.fps,bitrate:value.bitrate,fullscreen:value.fullscreen});
    }else if(value.action==='route'){
      state.host.routeReady=value.ready;if(value.ready){state.host.port=value.port;state.host.routeId=value.id;}
      emit({type:'route',ready:value.ready});
      viewer.reconcile();
    }else if(value.action==='bitrate'){
      bitrate.apply({viewId:bitrate.snapshot().viewId,budgetKbps:value.budgetKbps});
    }else if(value.action==='input-manual'&&inputTest&&!switching){
      switching=true;const record=viewer.currentSession(),signal=AbortSignal.timeout(30000);
      const check=()=>{if(!record||viewer.currentSession()!==record||signal.aborted)throw Error('manual input binding lost');};
      const wait=async predicate=>{while(!predicate()){check();await new Promise(resolve=>setTimeout(resolve,25));}check();};
      await wait(()=>displays.snapshot().input.canPause&&displays.snapshot().canSelect);
      const started=performance.now();displays.setInput({viewId:displays.snapshot().viewId,paused:true});
      await wait(()=>displays.snapshot().input.canResume);
      const pausedMs=Math.round(performance.now()-started),epoch=record.input.epoch,firstPausedFrame=viewer.snapshot().progress.rendered;
      const before=displays.record.latest.d,switchStarted=performance.now();displays.apply({viewId:displays.snapshot().viewId,display:before.capture});
      await wait(()=>displays.snapshot().result?.kind==='applied');const switchedMs=Math.round(performance.now()-switchStarted);
      const applied=displays.record.latest.d;await new Promise(resolve=>setTimeout(resolve,350));check();
      if(record.input.epoch!==epoch||record.input.phase!=='paused'||!viewer.inputPaused(record))throw Error('display selection released manual pause');
      const heldFrame=viewer.snapshot().progress.rendered,resumeStarted=performance.now();
      displays.setInput({viewId:displays.snapshot().viewId,paused:false});
      await wait(()=>record.input.phase==='active'&&!viewer.inputPaused(record));
      emit({type:'input-manual',pausedEpoch:epoch,resumedEpoch:record.input.epoch,pauseMs:pausedMs,displayMs:switchedMs,resumeMs:Math.round(performance.now()-resumeStarted),
        generation:applied.generation,firstFrame:applied.stream.firstFrame,firstPausedFrame,heldFrame,resumedFrame:viewer.snapshot().progress.rendered,
        manualPausePreserved:true,sameStream:true});switching=false;
    }else if(value.action==='input-switch'&&inputTest&&!switching){
      switching=true;
      const record=viewer.currentSession();
      if(!record?.input||record.input.phase!=='active')throw Error('input owner unavailable');
      const signal=AbortSignal.timeout(25000);
      const check=()=>{if(viewer.currentSession()!==record||signal.aborted)throw Error('input switch binding lost');};
      while(!displays.snapshot().canSelect){check();await new Promise(resolve=>setTimeout(resolve,50));}
      const before=displays.record.latest.d,pausedEpoch=record.input.epoch+1;
      const afterFrame=viewer.snapshot().progress.rendered;
      displays.apply({viewId:displays.snapshot().viewId,display:before.capture});
      while(displays.snapshot().result?.kind!=='applied'){check();await new Promise(resolve=>setTimeout(resolve,50));}
      const applied=displays.record.latest.d;
      emit({type:'input-switch',sameStream:true,requestId:applied.requestId,pausedEpoch,resumedEpoch:record.input.epoch,
        previousGeneration:before.generation,generation:applied.generation,firstFrame:applied.stream.firstFrame,afterFrame,progress:viewer.snapshot().progress});
      switching=false;
    }else if(value.action==='stop')stop();
    else throw Error('invalid command');
  }catch(error){emit({type:'failure',code:error.code || 'FIXTURE_ERROR'});if(!viewer)process.exit(1);else stop();}
});
setTimeout(()=>{emit({type:'failure',code:'FIXTURE_DEADLINE'});stop();},110000).unref();
