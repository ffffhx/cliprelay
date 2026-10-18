'use strict';
// Two owned tone children establish process isolation before this observer is
// used to assess a shipped viewer. No speaker or remote playback claim here.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
assert.equal(process.platform,'darwin');assert.equal(process.env.GITHUB_ACTIONS,'true');
const root=path.join(__dirname,'..'),runner=fs.realpathSync(process.env.RUNNER_TEMP)+path.sep;
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function ownedFile(variable){const file=fs.realpathSync(process.env[variable]);assert.ok(file.startsWith(runner));return file;}
const source=ownedFile('CLIPRELAY_AUDIO_TONE_FIXTURE'),observer=ownedFile('CLIPRELAY_AUDIO_OBSERVER');
const fixture=JSON.parse(fs.readFileSync(ownedFile('CLIPRELAY_AUDIO_OBSERVER_RECEIPT'),'utf8'));
assert.equal(fixture.protocol,1);assert.equal(fixture.testCommit,process.env.GITHUB_SHA);
assert.equal(fixture.sourceSha256,hash(path.join(__dirname,'audio_fixture/observe.mm')));
assert.equal(fixture.builderSha256,hash(path.join(__dirname,'build_macos_audio_observer.py')));
assert.equal(fixture.path,observer);assert.equal(fixture.binarySha256,hash(observer));
const tones=JSON.parse(fs.readFileSync(ownedFile('CLIPRELAY_AUDIO_FIXTURE_RECEIPT'),'utf8'));
assert.equal(tones.testCommit,process.env.GITHUB_SHA);assert.equal(tones.files.tone.path,source);
assert.equal(tones.files.tone.sha256,hash(source));
assert.equal(tones.sources['scripts/audio_fixture/tone.mm'],hash(path.join(root,'scripts/audio_fixture/tone.mm')));
const children=[],pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,predicate,timeout=10000){
  const end=Date.now()+timeout;
  while(true){const value=read();if(predicate(value))return value;if(Date.now()>end)throw Error('OBSERVER_WAIT_TIMEOUT');await pause(40);}
}
function launch(file,args=[]){
  const child=spawn(file,args,{stdio:['pipe','pipe','pipe']});
  const item={child,exit:null,error:null,events:[],buffer:'',stderr:''};children.push(item);
  child.once('error',()=>{item.error='OBSERVER_SPAWN_FAILED';});child.stdin.on('error',()=>{});
  child.once('close',(code,signal)=>{item.exit={code,signal};});
  child.stderr.on('data',data=>{item.stderr=(item.stderr+data.toString('utf8')).slice(-2048);});
  child.stdout.on('data',data=>{
    item.buffer+=data.toString('utf8');
    if(item.buffer.length>16384){item.error='OBSERVER_OUTPUT_LIMIT';child.kill('SIGKILL');return;}
    while(item.buffer.includes('\n')){
      const end=item.buffer.indexOf('\n'),line=item.buffer.slice(0,end);item.buffer=item.buffer.slice(end+1);
      try{assert.ok(item.events.length<1500);item.events.push(JSON.parse(line));}
      catch{item.error='OBSERVER_OUTPUT_INVALID';child.kill('SIGKILL');return;}
    }
  });return item;
}
function alive(item){assert.equal(item.error,null);assert.equal(item.exit,null);return item.events.at(-1);}
async function command(item,text='state'){
  alive(item);const start=item.events.length;item.child.stdin.write(text+'\n');
  return until(()=>{alive(item);return item.events.slice(start).find(value=>value.event==='state');},Boolean,3000);
}
async function close(item){
  if(!item||item.exit)return;
  item.child.stdin.end();
  try{await until(()=>item.exit,Boolean,5000);}
  finally{if(!item.exit){item.child.kill('SIGKILL');await until(()=>item.exit,Boolean,5000);}}
}
const report={protocol:1,testCommit:process.env.GITHUB_SHA,architecture:process.arch,passed:false,
  scope:'Owned tone process isolation through a private muted Core Audio tap; not shipped Qt playback or physical output.',
  samplesSaved:false,shippingViewerTested:false,fixture:{...fixture,path:undefined},
  toneSha256:tones.files.tone.sha256,testSha256:hash(__filename),observations:[],cases:[]};
let first,second,tap,stage='source-start';
async function main(){
  try{
    first=launch(source);second=launch(source);
    for(const item of [first,second])await until(()=>alive(item),value=>value?.event==='ready');
    report.routeBefore=(await command(first)).route;
    const noise=await command(second,'high');assert.equal(noise.frequency,1600);
    stage='observer-start';tap=launch(observer,[String(first.child.pid)]);
    const ready=await until(()=>alive(tap),value=>value?.event==='ready',15000);
    assert.ok([44100,48000].includes(ready.rate));assert.equal(ready.channels,2);
    for(const [name,hz] of [['quiet',0],['low',1000],['high',1600],['quiet',0]]){
      stage='observe-'+name;
      const before=await command(tap),tone=await command(first,name);assert.equal(tone.frequency,hz);
      let last=before.windows,matched=[];const deadline=Date.now()+12000;
      while(matched.length<2){
        assert.ok(Date.now()<deadline,'OBSERVER_PHASE_TIMEOUT');
        const value=await command(tap);assert.equal(value.invalid,0);assert.ok(value.callbacks>0);
        if(value.windows>last){
          last=value.windows;
          const target=hz===1000?value.low:value.high,other=hz===1000?value.high:value.low;
          const matches=hz===0?Math.max(value.low,value.high,value.rms)<.001:target>.01&&other<target*.15&&value.rms>.005;
          if(value.windows<before.windows+2||!matches)matched=[];
          else matched.push(value);
        }
        await pause(80);
      }
      const sourceAfter=await command(first),noiseAfter=await command(second);
      assert.ok(sourceAfter.callbacks>tone.callbacks&&noiseAfter.callbacks>noise.callbacks);
      assert.equal(noiseAfter.frequency,1600);assert.equal(sourceAfter.errors,0);assert.equal(noiseAfter.errors,0);
      report.observations.push({frequency:hz,afterWindow:before.windows,windows:matched,
        selectedCallbacks:sourceAfter.callbacks,otherCallbacks:noiseAfter.callbacks,otherFrequency:noiseAfter.frequency});
    }
    report.cases.push('selected-process-quiet-1000Hz-1600Hz-quiet-with-other-process-playing');
    stage='observer-eof';await close(tap);assert.deepEqual(tap.exit,{code:0,signal:null});
    assert.deepEqual(tap.events.at(-1),{event:'closed',stopped:true,ioDestroyed:true,aggregateDestroyed:true,tapDestroyed:true});
    report.cases.push('EOF-stops-private-tap-and-aggregate');
    await command(first,'quiet');await command(second,'quiet');
    report.routeAfter=(await command(first)).route;assert.deepEqual(report.routeAfter,report.routeBefore);
    for(const item of [first,second]){await close(item);assert.deepEqual(item.exit,{code:0,signal:null});}
    report.cases.push('default-route-rate-buffer-preserved-and-owned-children-reaped');report.passed=true;
  }catch(error){
    report.failure={stage,code:error.code||error.message,observed:tap?.events.at(-1),
      source:first?.events.at(-1),other:second?.events.at(-1)};process.exitCode=1;
  }finally{
    for(const item of [tap,first,second])try{await close(item);}catch{report.passed=false;process.exitCode=1;}
    report.exits=children.map(item=>item.exit);
    fs.writeFileSync(process.argv[2],JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({passed:report.passed,stage,cases:report.cases}));
  }
}
main().catch(()=>{process.exitCode=1;});
