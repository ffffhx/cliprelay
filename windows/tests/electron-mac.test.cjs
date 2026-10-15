'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {once}=require('node:events');
const {sendSelection,receive,postText,preferredIPv4,discoveredPeer}=require('../electron/mac/relay.cjs');
const {loadConfig,saveConfig,importHammerspoon,importLuaDefaults}=require('../electron/mac/config.cjs');

test('Mac selection restores original text and sends only a new nonempty selection after 200ms',async()=>{
  for(const selection of ['selected\n中文','old','']){
    const events=[];let text='old';
    const clipboard={availableFormats:()=>['text/plain'],readText:()=>text,writeText:value=>{text=value;events.push('restore');}};
    const result=await sendSelection({clipboard,config:{legacyEnabled:true},copySelection:async()=>{events.push('copy');text=selection;},delay:async ms=>events.push(ms),post:async(_,value)=>events.push(value)});
    assert.equal(text,'old');assert.equal(result,selection==='selected\n中文');
    assert.deepEqual(events,selection==='selected\n中文'?['copy',200,'restore',selection]:['copy',200,'restore']);
  }
});
test('Mac keeps newly copied text if the old clipboard had no plain text, and sends silently on failure',async()=>{
  let text='new';let writes=0;
  const sent=await sendSelection({clipboard:{availableFormats:()=>['image/png'],readText:()=>text,writeText:()=>writes++},config:{legacyEnabled:true},copySelection:async()=>{},delay:async()=>{},post:async()=>{throw new Error('offline');}});
  assert.equal(sent,true);assert.equal(writes,0);
});
test('Mac receiver preserves the existing POST/probe protocol without altering the clipboard on probes',()=>{
  const writes=[],notifications=[];const adapters={getConfig:()=>({legacyEnabled:true}),clipboard:{writeText:value=>writes.push(value)},notify:(...args)=>notifications.push(args)};
  for(const body of ['{}','{"text":""}','{"text":1}','invalid'])assert.equal(receive('POST','/push',body,adapters,{remoteAddress:'127.0.0.1'}).status,400);
  assert.equal(receive('GET','/push','{"text":"hello"}',adapters,{remoteAddress:'127.0.0.1'}).status,400);
  assert.equal(receive('POST','/push-image','image',adapters,{remoteAddress:'127.0.0.1'}).status,400);
  assert.equal(receive('POST','/push','{"text":"hello","probe":true}',adapters,{remoteAddress:'127.0.0.1'}).status,200);assert.equal(writes.length,0);
  const value='# Title\n中文 **original**';assert.equal(receive('POST','/push',JSON.stringify({text:value}),adapters,{remoteAddress:'127.0.0.1'}).body,'ok');assert.deepEqual(writes,[value]);assert.deepEqual(notifications,[['ClipRelay 收到文本',value]]);
});
test('Mac transport sends UTF-8 and per-peer authentication over real HTTP',async()=>{
  let seen;const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;seen={method:req.method,path:req.url,token:req.headers['x-cliprelay-token'],body:JSON.parse(body)};res.end('ok');});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{await postText({legacyEnabled:true,peer:'127.0.0.1',peerPort:server.address().port,peerToken:'qa-key'},'Hello\n中文');assert.deepEqual(seen,{method:'POST',path:'/push',token:'qa-key',body:{text:'Hello\n中文'}});}
  finally{server.close();await once(server,'close');}
});
test('discovery prefers private IPv4 and excludes the same device ID',()=>{
  assert.equal(preferredIPv4(['::1','203.0.113.1','172.31.2.3','192.168.1.2']),'172.31.2.3');
  const service={name:'Phone',port:47632,addresses:['::1','192.168.1.2'],txt:{id:'phone',auth:'required'}};
  assert.equal(discoveredPeer(service,'phone'),null);
  assert.deepEqual(discoveredPeer(service,'mac'),{id:'phone',text:'Phone',address:'192.168.1.2',port:47632,requiresAuth:true,subText:'192.168.1.2:47632 · 需要访问密钥'});
});
test('Hammerspoon import is restricted to ClipRelay keys and existing Electron settings win on subsequent starts',()=>{
  const calls=[];const imported=importHammerspoon((_,args)=>{calls.push(args);if(args[2]==='cliprelay.peerToken')return ' key with spaces \n';return 'value\n';});
  assert.equal(imported.peerToken,' key with spaces ');assert.equal(calls.length,5);assert.ok(calls.every(args=>args[2].startsWith('cliprelay.')));
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-mac-test-'));
  try{
    const config=loadConfig(directory,{legacy:()=>({peer:'phone.local',peerPort:'47640',peerToken:'secret',deviceId:'old-id',discoveryEnabled:'0'}),hostname:()=> 'Test Mac'});
    assert.equal(config.peer,'phone.local');assert.equal(config.peerPort,47640);assert.equal(config.discoveryEnabled,false);assert.equal(config.deviceId,'old-id');
    config.peer='new.local';saveConfig(directory,config);
    assert.equal(loadConfig(directory,{legacy:()=>{throw new Error('must not reimport');}}).peer,'new.local');
  }finally{assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(directory).startsWith('cliprelay-mac-test-'));fs.rmSync(directory,{recursive:true,force:true});}
});
test('documented Lua constants are migrated without executing user automations',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-lua-test-'));
  try{
    const file=path.join(directory,'init.lua');
    fs.writeFileSync(file,'local DEFAULT_PEER = "phone.local" -- fallback\nlocal LOCAL_PORT = 47633\nlocal HOTKEY_MODS = { "ctrl", "cmd" }\nlocal HOTKEY_KEY = "h"\nerror("must not execute")\n');
    assert.deepEqual(importLuaDefaults(file),{defaultPeer:'phone.local',localPort:47633,hotkey:'Control+Command+H'});
    const config=loadConfig(directory,{legacy:()=>({}),defaults:()=>importLuaDefaults(file)});
    assert.equal(config.peer,'phone.local');assert.equal(config.localPort,47633);assert.equal(config.hotkey,'Control+Command+H');
  }finally{assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(directory).startsWith('cliprelay-lua-test-'));fs.rmSync(directory,{recursive:true,force:true});}
});
