'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),readline=require('node:readline');
const {spawn}=require('node:child_process');const {PassThrough}=require('node:stream');const {once}=require('node:events');
const {AiController}=require('../electron/ai-controller.cjs');const {AiServer}=require('../electron/ai-server.cjs');const {run}=require('../electron/ai-mcp.cjs');
(async()=>{
  const incoming=readline.createInterface({input:process.stdin})[Symbol.asyncIterator]();const config=JSON.parse((await incoming.next()).value);
  const fixture=spawn(config.fixture,['--automation-probe'],{stdio:['pipe','pipe','pipe'],windowsHide:true});fixture.stdout.setEncoding('utf8');
  const fixtureEvents=[];let fixtureBuffer='';fixture.stdout.on('data',chunk=>{fixtureBuffer+=chunk;let at;while((at=fixtureBuffer.indexOf('\n'))>=0){fixtureEvents.push(JSON.parse(fixtureBuffer.slice(0,at)));fixtureBuffer=fixtureBuffer.slice(at+1);}});
  const wait=async(predicate,timeout=10000)=>{const until=Date.now()+timeout;while(!predicate()){if(Date.now()>until)throw new Error('Isolated fixture timeout');await new Promise(r=>setTimeout(r,20));}};
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-tls-ai-'));
  const store={hosts:()=>[config.host],identity:async()=>config.identity};
  const client={paired:{store},direct:{busy:false},network:{}};
  const controller=new AiController({getClient:()=>client,directory:{snapshot:()=>({devices:[]})}}),server=new AiServer({directory,controller});
  await server.start();const input=new PassThrough(),output=new PassThrough(),responses=new Map();let buffer='',seq=0;
  output.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\n'))>=0){const value=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);responses.set(value.id,value);}});
  const running=run({file:server.file,input,output});
  const rpc=async(method,params)=>{const id=++seq;input.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');await wait(()=>responses.has(id),60000);return responses.get(id);};
  const tool=async(name,args)=>{const response=await rpc('tools/call',{name:'cliprelay_'+name,arguments:args});assert.ok(!response.error);assert.ok(!response.result.isError,response.result.content[0].text);return JSON.parse(response.result.content[0].text);};
  try{
    await wait(()=>fixtureEvents.some(e=>e.title));const title=fixtureEvents.find(e=>e.title).title;
    await rpc('initialize',{protocolVersion:'2025-11-25'});
    const devices=await tool('devices',{});assert.equal(devices.devices[0].id,'paired:'+config.host.id);
    const connected=await tool('connect',{deviceId:devices.devices[0].id}),session=connected.session;assert.equal(connected.capabilities.windows,true);
    const windows=(await tool('windows',{session})).result.windows,windowId=windows.find(w=>w.title===title)?.id;assert.ok(windowId,'isolated native target not returned');
    let observed=(await tool('window_observe',{session,windowId})).result;
    const edit=observed.elements.find(e=>e.name==='TLS fixture input');assert.ok(edit);
    await tool('window_action',{session,version:observed.version,ref:edit.reference,kind:'set_value',value:'你好 remote TLS'});
    observed=(await tool('window_observe',{session,windowId})).result;assert.equal(observed.elements.find(e=>e.name==='TLS fixture input').text,'你好 remote TLS');
    const button=observed.elements.find(e=>e.name==='TLS fixture apply');
    await tool('window_action',{session,version:observed.version,ref:button.reference,kind:'invoke',requestId:'f'.repeat(32)});
    await wait(()=>fixtureEvents.some(e=>e.clicks===1));assert.equal(fixtureEvents.find(e=>e.clicks===1).applied,'你好 remote TLS');
    await tool('window_action',{session,version:observed.version,ref:button.reference,kind:'invoke',requestId:'f'.repeat(32)});assert.equal(fixtureEvents.filter(e=>e.clicks).length,1);
    const screenshot=await rpc('tools/call',{name:'cliprelay_window_screenshot',arguments:{session,windowId}});assert.ok(!screenshot.result.isError);assert.ok(screenshot.result.content.some(c=>c.type==='image'&&c.data.length>1000));
    console.log(JSON.stringify({phase:'revoke'}));assert.equal((await incoming.next()).value,'revoked');
    const denied=await rpc('tools/call',{name:'cliprelay_windows',arguments:{session}});assert.equal(denied.result.isError,true);assert.match(denied.result.content[0].text,/UNPAIRED/);
  }finally{
    input.end();await running;await server.close();fixture.stdin.end();if(fixture.exitCode===null)await once(fixture,'exit');fs.rmSync(directory,{recursive:true,force:true});
  }
  console.log(JSON.stringify({phase:'complete'}));process.exit(0);
})().catch(error=>{console.error(error.message);process.exit(1);});
