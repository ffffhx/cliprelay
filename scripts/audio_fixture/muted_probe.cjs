'use strict';
// Disposable CI experiment: does a private muted process tap also exclude its
// source from the packaged host's global tap? Both outcomes are observations;
// neither is a shipping playback pass. No samples leave either native callback.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function probe({tone,command,readDecoder,until}){
  assert.equal(process.platform,'darwin');assert.equal(process.env.GITHUB_ACTIONS,'true');
  const root=fs.realpathSync(process.env.RUNNER_TEMP)+path.sep;
  const file=fs.realpathSync(process.env.CLIPRELAY_AUDIO_OBSERVER);
  const receipt=fs.realpathSync(process.env.CLIPRELAY_AUDIO_OBSERVER_RECEIPT);
  assert.ok(file.startsWith(root)&&receipt.startsWith(root));
  const fixture=JSON.parse(fs.readFileSync(receipt,'utf8'));
  assert.equal(fixture.testCommit,process.env.GITHUB_SHA);assert.equal(fixture.path,file);
  assert.equal(fixture.binarySha256,hash(file));
  assert.equal(fixture.sourceSha256,hash(path.join(__dirname,'observe.mm')));
  assert.equal(fixture.builderSha256,hash(path.join(__dirname,'../build_macos_audio_observer.py')));
  const result={protocol:1,testCommit:process.env.GITHUB_SHA,testSha256:hash(__filename),completed:false,
    scope:'Owned tone private CATapMuted versus packaged global host capture and independent encrypted Opus decoder; no Qt playback claim.',
    shippingPlaybackVerified:false,audioSamplesSaved:false,fixture:{...fixture,path:undefined},observations:[]};
  let child,exit=null,protocolError=null,buffer='',events=[],stage='unmuted-low';
  const alive=()=>{assert.equal(protocolError,null);assert.equal(exit,null);return events.at(-1);};
  async function state(){
    alive();const after=events.length;child.stdin.write('state\n');
    return until(()=>{alive();return events.slice(after).find(v=>v.event==='state');},Boolean,3000);
  }
  const quiet=a=>Math.max(a.low,a.high,a.rms)<.001;
  const low=a=>a.low>.005&&a.low<.06&&a.high<a.low*.15&&a.rms>.003&&a.rms<.06;
  async function phase(name,hz,muted){
    stage=name;const previous=readDecoder(),initialTap=muted?await state():null;
    const source=await command(hz?'low':'quiet');assert.equal(source.frequency,hz);
    let last=previous.audio.windows,lastTap=initialTap?.windows||0,matched=[],classification;
    await until(async()=>{
      const value=readDecoder(),a=value.audio,tap=muted?await state():null;
      assert.equal(value.errors,0);assert.equal(a.errors,0);
      if(tap){assert.equal(tap.invalid,0);assert.ok(tap.callbacks>0);}
      if(a.windows<=last||(tap&&tap.windows<=lastTap))return false;
      last=a.windows;if(tap)lastTap=tap.windows;
      const kind=quiet(a)?'silent':low(a)?'source-tone':'other';
      const directMatches=!tap||(hz?low(tap):quiet(tap));
      const receiverMatches=hz?(muted?kind!=='other':kind==='source-tone'):kind==='silent';
      if(a.windows<previous.audio.windows+3||a.ageMs>=1000||value.ageMs>=2000||value.decoded<=previous.decoded||
        (tap&&tap.windows<initialTap.windows+3)||!directMatches||!receiverMatches){matched=[];classification=null;return false;}
      if(classification!==kind)matched=[];classification=kind;
      matched.push({decoder:value,observer:tap});return matched.length===2;
    },Boolean,15000);
    const after=await command('state');assert.equal(after.errors,0);assert.ok(after.callbacks>source.callbacks);
    result.observations.push({stage:name,frequency:hz,muted,afterWindow:previous.audio.windows,
      afterObserverWindow:initialTap?.windows||0,sourceCallbacks:after.callbacks,classification,windows:matched});
  }
  async function close(){
    if(!child||exit)return;
    child.stdin.end();
    try{await until(()=>exit,Boolean,5000);}
    finally{if(!exit){child.kill('SIGKILL');await until(()=>exit,Boolean,5000);}}
  }
  try{
    await phase('unmuted-low',1000,false);
    stage='muted-tap-start';
    child=spawn(file,[String(tone.child.pid)],{stdio:['pipe','pipe','pipe']});
    child.stdin.on('error',()=>{});child.stderr.resume();
    child.once('error',()=>{protocolError='MUTED_PROBE_SPAWN';});child.once('close',(code,signal)=>{exit={code,signal};});
    child.stdout.on('data',data=>{
      buffer+=data.toString('utf8');
      if(buffer.length>16384){protocolError='MUTED_PROBE_OUTPUT_LIMIT';child.kill('SIGKILL');return;}
      while(buffer.includes('\n')){
        const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        try{assert.ok(events.length<2000);events.push(JSON.parse(line));}
        catch{protocolError='MUTED_PROBE_PROTOCOL';child.kill('SIGKILL');return;}
      }
    });
    await until(alive,v=>v?.event==='ready');
    await phase('muted-low',1000,true);await phase('muted-quiet',0,true);
    stage='tap-close';await close();assert.deepEqual(exit,{code:0,signal:null});
    result.closed=events.at(-1);
    assert.deepEqual(result.closed,{event:'closed',stopped:true,ioDestroyed:true,aggregateDestroyed:true,tapDestroyed:true});
    await phase('restored-low',1000,false);await phase('restored-quiet',0,false);
    result.mutedSourceCapturedByHost=result.observations[1].classification==='source-tone';
    result.completed=true;
  }catch(error){
    result.failure={stage,code:error.code||error.message,location:error.stack?.match(/muted_probe\.cjs:\d+:\d+/)?.[0],
      decoder:readDecoder(),observer:events.at(-1)};
  }finally{
    try{await close();assert.deepEqual(exit,{code:0,signal:null});}
    catch{result.cleanupFailed=true;result.completed=false;}
    result.exit=exit;
  }
  return result;
}
module.exports={probe};
