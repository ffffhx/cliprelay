'use strict';
// Run with the bundled Electron executable. Real primary-display capture, real video codecs,
// two independent peer connections, and HTTP signaling; no synthetic MediaStream.
const {app,BrowserWindow,screen}=require('electron');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const role=process.argv.find(x=>x.startsWith('--role='))?.split('=')[1] || 'receiver';
const mode=process.argv.find(x=>x.startsWith('--mode='))?.split('=')[1] || 'normal';
const output=path.resolve(process.argv.find(x=>x.startsWith('--output='))?.slice(9) || '.tools/video-live');
const port=role==='sender'?47911:47912, peerPort=role==='sender'?47912:47911;
fs.mkdirSync(output,{recursive:true});
const setPath=app.setPath.bind(app);
app.setPath=(name,value)=>setPath(name,name==='userData'?path.join(output,role+'-profile'):value);
app.requestSingleInstanceLock=()=>true;
const host=require('../screen-share/main.js');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let server, motion;
const results=[];
function record(value){results.push(value);fs.writeFileSync(path.join(output,role+'-results.json'),JSON.stringify(results,null,2));}
app.whenReady().then(async()=>{
  server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    try {
      const data=JSON.parse(body);
      const result=host.handleCommand({action:'signal',path:req.url,remoteAddress:'127.0.0.1',data});
      record({http:req.url,type:data.type,status:result.status});res.writeHead(result.status);res.end();
    }catch(error){res.writeHead(400);res.end();record({error:error.message});}
  });
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  if(role==='sender') {
    const primary=screen.getPrimaryDisplay();
    motion=new BrowserWindow({...primary.bounds,frame:false,alwaysOnTop:true,title:'ClipRelay Motion Test',webPreferences:{backgroundThrottling:false}});
    await motion.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<title>ClipRelay Motion Test</title><body style="margin:0;background:#152032;color:white;font:28px monospace"><p>ClipRelay real window capture</p><p id="clock"></p><div id="box" style="background:#88bfff;width:160px;height:160px;position:absolute;top:260px"></div><script>function frame(t){document.getElementById("clock").textContent=Date.now();document.getElementById("box").style.left=(t/5%1000)+"px";requestAnimationFrame(frame)}requestAnimationFrame(frame)</script>'));
    motion.show();motion.setFullScreen(true);motion.setTitle('ClipRelay Motion Test');await sleep(1500);
    host.handleCommand({action:'start',peer:{name:'QA receiver',address:'127.0.0.1',port:peerPort},localPort:port,localName:'QA sender'});
  }
  let clicked=false,verifiedDisplay=false,captured=false,measured=false,liveAt=0,lastBytes=0,stopRequested=false,activeSession,invitedAt=0,lastPhase;
  const deadline=Date.now()+90000;
  while(Date.now()<deadline) {
    const s=[...host.sessions.values()][0];
    if(s)activeSession=s;
    if(role==='sender' && s?.state!==lastPhase) {lastPhase=s?.state;if(lastPhase)record({phase:lastPhase});}
    if(role==='sender' && activeSession?.ended && activeSession.window.isDestroyed()) {
      record({ended:activeSession.endReason,cleanup:{rendererDestroyed:true,captureDisabled:!activeSession.captureAllowed,sessionsRemoved:host.sessions.size===0}});break;
    }
    if(s && !s.window.isDestroyed() && !s.window.webContents.isLoading()) {
      if(s.window.isVisible()!==(role==='receiver'))throw new Error('Wrong sender/receiver window visibility');
      const state=await s.window.webContents.executeJavaScript('({ready:!!document.getElementById("start")&&!document.getElementById("start").disabled,status:document.getElementById("status")?.textContent,detail:document.getElementById("detail")?.textContent,ended:document.body.classList.contains("ended"),sources:document.querySelectorAll("#sourceList button").length})');
      fs.writeFileSync(path.join(output,role+'-state.json'),JSON.stringify(state));
      if(role==='receiver' && state.ready && !invitedAt)invitedAt=Date.now();
      if(role==='receiver' && state.ready && !clicked && Date.now()-invitedAt>=2000) {await s.window.webContents.executeJavaScript(mode==='decline'?'document.getElementById("stop").click()':'document.getElementById("start").click()',true);clicked=true;}
      if(role==='sender' && s.stats?.frames>0 && !verifiedDisplay) {
        const settings=await s.window.webContents.executeJavaScript('stream.getVideoTracks()[0].getSettings()');
        record({automaticCapture:true,displayId:s.captureDisplayId,settings});
        if(s.captureDisplayId!==String(screen.getPrimaryDisplay().id) || settings.displaySurface!=='monitor' || state.sources!==0)throw new Error('Did not automatically capture primary screen');
        verifiedDisplay=true;
      }
      if(s.stats && s.stats.bytes!==lastBytes) {lastBytes=s.stats.bytes;record({time:Date.now(),stats:s.stats});if(!liveAt)liveAt=Date.now();}
      if(s.stats?.frames>120 && !measured) {
        const pipeline=await s.window.webContents.executeJavaScript(`(async()=>{
          const reports=await pc.getStats(), result={};
          for(const r of reports.values()) {
            if(r.type==='candidate-pair' && r.nominated && r.state==='succeeded')result.networkRoundTripMs=r.currentRoundTripTime*1000;
            if(r.kind==='video' && r.type==='outbound-rtp' && r.framesEncoded)result.encodeMs=r.totalEncodeTime/r.framesEncoded*1000;
            if(r.kind==='video' && r.type==='inbound-rtp' && r.framesDecoded){
              result.decodeMs=r.totalDecodeTime/r.framesDecoded*1000;
              result.jitterBufferMs=r.jitterBufferDelay/r.jitterBufferEmittedCount*1000;
            }
          }
          return result;
        })()`);
        record({pipeline});measured=true; // Component averages, not end-to-end screen latency.
      }
      if(role==='receiver' && s.stats?.frames>120 && !captured) {
        fs.writeFileSync(path.join(output,'receiver.png'),(await s.window.webContents.capturePage()).toPNG());captured=true;
        await s.window.webContents.executeJavaScript('document.getElementById("fullscreen").click()',true);
        await sleep(500);
        const fullscreen=await s.window.webContents.executeJavaScript('!!document.fullscreenElement');
        record({fullscreen});
        if(!fullscreen)throw new Error('Fullscreen did not activate');
        await s.window.webContents.executeJavaScript('document.exitFullscreen()');
      }
      if(role==='receiver' && mode==='disconnect' && liveAt && Date.now()-liveAt>13000) {
        record({abruptExit:true,at:Date.now(),frames:s.stats?.frames});
        process.kill(process.pid,'SIGKILL');return; // No window-close events or stop signaling.
      }
      const shouldStop=(role==='sender' && mode==='normal' && liveAt && Date.now()-liveAt>25000) ||
        (role==='receiver' && mode==='receiver-stop' && liveAt && Date.now()-liveAt>13000);
      if(shouldStop && !stopRequested) {
        if(role==='sender')host.handleCommand({action:'stop-all'});
        else await s.window.webContents.executeJavaScript('document.getElementById("stop").click()',true);
        record({stopped:true});stopRequested=true;
      }
      if(role==='receiver' && state.ended) {record({ended:state.detail,cleanup:await s.window.webContents.executeJavaScript('({videoCleared:document.getElementById("video").srcObject===null,peerClosed:!pc||pc.connectionState==="closed",tracksStopped:!stream||stream.getTracks().every(t=>t.readyState==="ended")})')});break;}
    }
    await sleep(500);
  }
  const frames=results.filter(x=>x.stats?.frames>0);
  const median=frames.map(x=>x.stats.fps||0).sort((a,b)=>a-b)[Math.floor(frames.length/2)] || 0;
  const stopped=results.find(x=>x.ended);
  const clean=role==='sender' ? stopped?.cleanup?.rendererDestroyed && stopped?.cleanup?.captureDisabled && stopped?.cleanup?.sessionsRemoved : stopped?.cleanup?.videoCleared && stopped?.cleanup?.peerClosed && stopped?.cleanup?.tracksStopped;
  const lostPeerDetected=mode!=='disconnect' || (!results.some(x=>x.type==='stop') && /连接.*中断|连接已断开/.test(stopped?.ended || ''));
  const phases=results.filter(x=>x.phase).map(x=>x.phase);
  const phaseFeedback=role!=='sender' || (phases.includes('waiting') && (mode==='decline' || phases.includes('connected')));
  const pass=Boolean(clean && lostPeerDetected && phaseFeedback && (mode==='decline'?frames.length===0:frames.length>=10 && median>=20));
  record({summary:{mode,frames:frames.length,medianFps:median,decoded:frames.at(-1)?.stats.frames,pass}});
  server.close();app.exit(pass?0:1);
}).catch(error=>{record({fatal:error.stack});app.exit(1);});
