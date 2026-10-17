'use strict';
// Additional component acceptance, distinct from shipped Qt presentation.
// Only a CI-owned color backdrop and unsaved center samples are inspected.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
async function verify({directory,host,identity,hostState,admin,until,nativeChildren,report,setStage}){
  assert.equal(process.platform,'darwin');assert.equal(process.env.GITHUB_ACTIONS,'true');
  assert.equal(report.componentOnly,true);
  const configuration=hostState.read('sunshine.conf',65536).toString('utf8');
  assert.match(configuration,/^lan_encryption_mode = 2$/m);assert.match(configuration,/^wan_encryption_mode = 2$/m);
  const {exchange,jsonRequest}=require(path.join(directory,'paired-transport.cjs'));
  const {xmlValue}=require(path.join(directory,'paired-crypto.cjs'));
  const protocol=require(path.join(directory,'privacy-protocol.cjs'));
  const root=fs.realpathSync(process.env.RUNNER_TEMP)+path.sep;
  function child(variable){
    const file=fs.realpathSync(process.env[variable]);assert.ok(file.startsWith(root));
    const processChild=spawn(file,[],{stdio:['pipe','pipe','pipe']});nativeChildren.push(processChild);
    const state={child:processChild,events:[],error:null,exit:null,buffer:'',stderr:''};
    processChild.stdin.on('error',()=>{});
    processChild.once('error',()=>{state.error='PIXEL_FIXTURE_SPAWN';});
    processChild.once('close',(code,signal)=>{state.exit={code,signal};});
    processChild.stderr.on('data',value=>{state.stderr=(state.stderr+value.toString('utf8')).slice(-2048);});
    processChild.stdout.on('data',value=>{
      state.buffer+=value.toString('utf8');
      if(state.buffer.length>8192){state.error='PIXEL_FIXTURE_OUTPUT_LIMIT';processChild.kill('SIGKILL');return;}
      while(state.buffer.includes('\n')){
        const end=state.buffer.indexOf('\n'),line=state.buffer.slice(0,end);state.buffer=state.buffer.slice(end+1);
        try{assert.ok(state.events.length<1500);state.events.push(JSON.parse(line));}
        catch{state.error='PIXEL_FIXTURE_PROTOCOL';processChild.kill('SIGKILL');return;}
      }
    });
    return state;
  }
  const alive=state=>{assert.equal(state.error,null);assert.equal(state.exit,null,'PIXEL_FIXTURE_EXIT');return state.events.at(-1);};
  async function close(state){
    if(!state)return;
    state.child.stdin.end();
    try{await until(()=>state.exit,value=>value!==null,5000);}
    finally{if(!state.exit){state.child.kill('SIGKILL');await until(()=>state.exit,value=>value!==null,5000);}}
  }
  async function nvhttp(endpoint,parameters={}){
    const query=new URLSearchParams({...parameters,uniqueid:'cliprelay-privacy-pixel-ci',uuid:crypto.randomUUID()});
    const xml=await exchange({address:'127.0.0.1',port:48784,path:`/${endpoint}?${query}`,method:'GET',identity,
      trust:{cert:host.certificate},timeout:10000,limit:65536});
    assert.ok(!/<!/.test(xml));assert.match(xml,/<root\b[^>]*\bstatus_code="200"(?:\s|\/|>)/);
    return xml;
  }
  const engine=()=>jsonRequest({address:'127.0.0.1',port:48790,path:'/api/cliprelay/privacy',method:'GET',identity,
    trust:{cert:host.certificate},headers:{Authorization:hostState.authorization()},timeout:3000,limit:8192});
  let colors,decoder,binding;
  const receipt=report.privacyPixels={passed:false,decoder:'standalone-software-h264',productionQtPixelsVerified:false,
    source:'owned-solid-color-window',localSampleSize:[16,16],decodedSampleCount:9,screenContentSaved:false,
    encryptedRTSP:true,hostRequiresVideoEncryption:true,observations:[]};
  async function command(value,event){
    const after=colors.events.length;alive(colors);colors.child.stdin.write(value+'\n');
    return until(()=>{alive(colors);return colors.events.slice(after).find(item=>item.event===event);},Boolean,5000);
  }
  async function local(expected){
    return until(()=>command('sample','sample'),value=>value.color===expected,5000);
  }
  async function remote(expected,minimum){
    return until(()=>alive(decoder),value=>value?.color===expected&&value.decoded>=minimum&&value.received>=value.decoded&&value.ageMs<1000&&value.errors===0,10000);
  }
  try{
    setStage('privacy-pixels-baseline');colors=child('CLIPRELAY_PRIVACY_COLOR_FIXTURE');
    const owned=await until(()=>alive(colors),value=>value?.event==='ready',10000);assert.ok(owned.window>0&&owned.display>0);
    await local('red');
    const info=await nvhttp('serverinfo'),apps=await nvhttp('applist'),appid=xmlValue(apps,'ID');assert.match(appid,/^[1-9][0-9]*$/);
    const key=crypto.randomBytes(16).toString('hex'),keyID=1060,iv=Buffer.alloc(16);iv.writeUInt32BE(keyID);
    const launched=await nvhttp('launch',{appid,mode:'1280x720x30',sops:0,rikey:key,rikeyid:keyID,localAudioPlayMode:1,
      surroundAudioInfo:196610,remoteControllersBitmap:0,gcmap:0,gcpersist:0,corever:1});
    assert.equal(xmlValue(launched,'gamesession'),'1');
    const url=xmlValue(launched,'sessionUrl0');assert.match(url,/^rtspenc:\/\/127\.0\.0\.1:[0-9]{1,5}$/);
    decoder=child('CLIPRELAY_PRIVACY_DECODE_FIXTURE');
    decoder.child.stdin.write([xmlValue(info,'appversion'),xmlValue(info,'GfeVersion')||'3.23.0.74',url,key,iv.toString('hex'),''].join('\n'));
    const baseline=await remote('red',5),before=await admin();
    assert.equal(before.phase,'active');assert.equal(before.streams.length,1);
    assert.equal(before.streams[0].owner,new crypto.X509Certificate(identity.cert).fingerprint256.replaceAll(':','').toLowerCase());
    receipt.observations.push({stage:'before',remote:baseline.color,local:'red',frame:baseline.decoded,generation:before.generation});
    setStage('privacy-pixels-masked');binding={instance:before.instance,stream:before.streams[0].id,lease:crypto.randomBytes(16).toString('hex')};
    const active=await protocol.request(host,identity,'start',binding);assert.equal(active.active,true);
    const filtered=await engine();assert.equal(filtered.ready,true);assert.equal(filtered.authorized,true);
    assert.equal(filtered.lease,binding.lease);assert.equal(filtered.stream,binding.stream);assert.ok(filtered.generation>before.generation&&filtered.firstFrame>0);
    // Change the owned scene only AFTER the mask is active. A stale red frame
    // or a stream that captures the black mask cannot satisfy green.
    await command('green','paint');const green=await remote('green',Math.max(filtered.firstFrame,baseline.decoded+5));
    const black=await local('black'),still=await engine();assert.equal(still.ready,true);assert.equal(still.authorized,true);
    assert.equal(still.lease,binding.lease);assert.equal(still.generation,filtered.generation);
    receipt.observations.push({stage:'masked',remote:green.color,local:black.color,frame:green.decoded,
      generation:filtered.generation,firstFrame:filtered.firstFrame});
    setStage('privacy-pixels-restored');const stopped=await protocol.request(host,identity,'stop',binding);assert.equal(stopped.active,false);binding=null;
    await until(engine,value=>!value.authorized&&!value.retained&&!value.ready,6000);
    const recovered=await until(admin,value=>value.phase==='active'&&value.generation>filtered.generation&&
      value.streams.length===1&&value.streams[0].id===before.streams[0].id&&value.streams[0].firstFrame>0,10000);
    await command('blue','paint');const blue=await remote('blue',Math.max(recovered.streams[0].firstFrame,green.decoded+5));
    await local('blue');receipt.observations.push({stage:'restored',remote:blue.color,local:'blue',frame:blue.decoded,generation:recovered.generation});
    receipt.decodedPixelsVerified=true;receipt.passed=true;
  }finally{
    if(binding)await protocol.request(host,identity,'stop',binding).catch(()=>{});
    const closed=await Promise.allSettled([close(decoder),close(colors)]);
    for(const result of closed)if(result.status==='rejected')throw result.reason;
  }
  await until(admin,value=>value.streams.length===0,10000);
  report.cases.push('owned-color-decoded-through-encrypted-stream-while-local-display-masked');
}
module.exports={verify};
