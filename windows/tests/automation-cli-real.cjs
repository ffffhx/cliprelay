'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),readline=require('node:readline');
const {spawn,execFile}=require('node:child_process'),{once}=require('node:events');
const {AiController}=require('../electron/ai-controller.cjs'),{AiServer}=require('../electron/ai-server.cjs');
(async()=>{
  const incoming=readline.createInterface({input:process.stdin})[Symbol.asyncIterator](),config=JSON.parse((await incoming.next()).value);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cliprelay-cli-real-'));
  const fixture=spawn(config.fixture,['--automation-probe'],{stdio:['pipe','pipe','pipe'],windowsHide:true}),events=[];
  let fixtureBuffer='';fixture.stdout.setEncoding('utf8');fixture.stdout.on('data',chunk=>{fixtureBuffer+=chunk;let at;while((at=fixtureBuffer.indexOf('\n'))>=0){events.push(JSON.parse(fixtureBuffer.slice(0,at)));fixtureBuffer=fixtureBuffer.slice(at+1);}});
  const wait=async predicate=>{const end=Date.now()+10000;while(!predicate()){if(Date.now()>end)throw new Error('Native fixture timeout');await new Promise(r=>setTimeout(r,20));}};
  const client={paired:{store:{hosts:()=>[config.host],identity:async()=>config.identity}},direct:{busy:false},network:{}};
  const controller=new AiController({getClient:()=>client,directory:{snapshot:()=>({devices:[]})}}),server=new AiServer({directory,controller});await server.start();
  const code="require(process.argv[1]).runProfilePilotCli(process.argv.slice(3),process,{homeDir:process.argv[2]}).then(code=>{process.exitCode=code;})";
  const run=args=>new Promise((resolve,reject)=>execFile(process.execPath,['-e',code,config.cli,directory,'remote',...args,'--json'],{env:{...process.env,PROFILEPILOT_REMOTE_ENDPOINT:server.file},windowsHide:true,timeout:90000,maxBuffer:5*1024*1024},(error,stdout,stderr)=>{
    try{assert.ok(!stdout.includes(server.token));for(const lease of server.cli.entries.values())assert.ok(!stdout.includes(lease.token));const data=JSON.parse(stdout);resolve({exitCode:error?.code||0,data});}catch(cause){reject(new Error(cause.message+' '+stderr.slice(0,400)));}
  }));
  const command=async args=>{const result=await run(args);assert.equal(result.exitCode,0,JSON.stringify(result.data));assert.equal(result.data.ok,true);return result.data;};
  const actionFile=path.join(directory,'action.json');
  try{
    await wait(()=>events.some(e=>e.title));const title=events.find(e=>e.title).title;
    assert.equal((await command(['devices'])).devices[0].id,'paired:'+config.host.id);
    const connected=await command(['connect','paired:'+config.host.id]),session=connected.session;
    assert.equal(controller.sessions.size,1,'CLI EOF released its remote session');
    const windows=(await command(['windows','--session',session])).result.windows,windowId=windows.find(w=>w.title===title)?.id;assert.ok(windowId);
    const observe=async()=> (await command(['window','observe','--session',session,'--window',windowId])).result;
    let observed=await observe();const edit=observed.elements.find(e=>e.name==='TLS fixture input');assert.ok(edit);
    fs.writeFileSync(actionFile,JSON.stringify({version:observed.version,ref:edit.reference,kind:'set_value',value:'你好 CLI & $() ` "'}),{mode:0o600});
    await command(['window','action','--session',session,'--params-file',actionFile]);
    observed=await observe();assert.equal(observed.elements.find(e=>e.name==='TLS fixture input').text,'你好 CLI & $() ` "');
    const button=observed.elements.find(e=>e.name==='TLS fixture apply');
    fs.writeFileSync(actionFile,JSON.stringify({version:observed.version,ref:button.reference,kind:'invoke'}));
    const invoke=['window','action','--session',session,'--params-file',actionFile,'--request-id','f'.repeat(32)];
    await command(invoke);await wait(()=>events.some(e=>e.clicks===1));await command(invoke);assert.equal(events.filter(e=>e.clicks).length,1);
    const picture=await command(['window','screenshot','--session',session,'--window',windowId]);assert.ok(fs.statSync(picture.result.image.path).size>1000);assert.equal(picture.result.image.data,undefined);
    await command(['disconnect','--session',session]);assert.equal(controller.sessions.size,0);assert.equal(server.cli.entries.size,0);
    const again=await command(['connect','paired:'+config.host.id]);await command(['status','--session',again.session]);
    console.log(JSON.stringify({phase:'revoke'}));assert.equal((await incoming.next()).value,'revoked');
    const denied=await run(['windows','--session',again.session]);assert.equal(denied.exitCode,75);assert.match(denied.data.code,/UNPAIRED/);
  }finally{
    await server.close();fixture.stdin.end();if(fixture.exitCode===null)await once(fixture,'exit');fs.rmSync(directory,{recursive:true,force:true});
  }
  console.log(JSON.stringify({phase:'complete'}));process.exit(0);
})().catch(error=>{console.error(error.message);process.exit(1);});
