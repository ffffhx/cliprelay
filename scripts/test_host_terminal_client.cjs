'use strict';
// Production controller/protocol over actual TLS, with disposable CI identity.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path');
const directory=process.argv[2]||path.resolve(__dirname,'../windows/electron/mac');
const protocol=require(path.join(directory,'terminal-protocol.cjs'));
const {TerminalController}=require(path.join(directory,'terminal-controller.cjs'));
const {fault}=require(path.join(directory,'paired-transport.cjs'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const octal=text=>[...Buffer.from(text)].map(b=>'\\'+b.toString(8).padStart(3,'0')).join('');

async function main(){
  let raw='';for await(const chunk of process.stdin){raw+=chunk;assert.ok(raw.length<65536);}
  const config=JSON.parse(raw),identity={cert:config.cert,key:config.key};
  const host={id:crypto.createHash('sha256').update(new crypto.X509Certificate(config.cert).raw).digest('hex'),certificate:config.cert,
    clientId:'a'.repeat(32),name:'Native CI Mac',address:'127.0.0.1',port:48789,enabled:true};
  const store={selected:()=>host,identity:async()=>identity,data:{legacySelected:false}};
  const lost=new Set(),calls=[];
  const request=async(...args)=>{
    const command=args[2];calls.push({...command});const reply=await protocol.request(...args);
    if(['open','write'].includes(command.op)&&!lost.has(command.op)){lost.add(command.op);throw fault('TIMEOUT');}
    return reply;
  };
  const controller=new TerminalController({store,request}),abort=new AbortController();
  const current=()=>controller.states.get(controller.selected)?.snapshot;
  let heartbeat=false;
  const step=async()=>{
    if(heartbeat && controller.snapshot().mouse.ready && controller.snapshot().mouse.buttons){
      const snapshot=controller.snapshot();controller.mouse({id:controller.selected,view:controller.view,revision:snapshot.mouse.revision,epoch:current().mouse.epoch,action:'heartbeat'});
    }
    const reply=await controller.poll();
    assert.notEqual(controller.phase,'error',controller.error);
    if(reply.frame)controller.parsed({id:controller.selected,view:reply.frame.view,token:reply.frame.token});
    return reply;
  };
  const until=async(predicate,timeout=12000)=>{
    const end=Date.now()+timeout;while(Date.now()<end){await step();if(predicate())return;await sleep(35);}throw Error('Controller condition timed out: '+JSON.stringify(controller.snapshot()));
  };
  const read=async()=>{
    let offset=0,parts=[];
    for(let n=0;n<64;n++){
      const reply=await protocol.request(host,identity,{op:'read',instance:controller.instance,id:controller.selected,offset},abort.signal);
      parts.push(reply.data);offset=reply.next;
      if(offset===reply.session.end)return {text:Buffer.concat(parts).toString('utf8'),session:reply.session};
      assert.ok(reply.data.length);
    }
    throw Error('Unbounded terminal output');
  };
  try{
    controller.bind();await until(()=>controller.phase==='ready');
    assert.deepEqual(controller.snapshot().shells,['zsh','bash']);assert.equal(controller.mouseProtocol,1);
    for(const shell of ['bash','zsh']){
      controller.open(shell);await until(()=>current()?.shell===shell&&!controller.pendingAction&&!controller.needList);
      const marker='desktop-'+shell+'-中文-👋';
      controller.input({id:controller.selected,view:controller.view,text:"printf '\\n"+octal(marker)+"\\n'\r"});
      await until(()=>current()?.writtenSequence===1&&!controller.snapshot().uncertain);
      let output;for(let n=0;n<60;n++){output=await read();if(output.text.includes(marker))break;await sleep(30);}
      assert.equal(output.text.split(marker).length-1,1,'lost receipt repeated real shell input');
      if(shell==='bash'){
        controller.input({id:controller.selected,view:controller.view,text:config.mouseCommand});
        await until(()=>controller.mouseReady());
        const mouse=(action,column,row)=>controller.mouse({id:controller.selected,view:controller.view,revision:controller.snapshot().mouse.revision,
          epoch:current().mouse.epoch,action,column,row,button:0,modifiers:0});
        heartbeat=true;mouse('press',5,7);await until(()=>current().mouse.writtenSequence>=1);
        mouse('move',6,8);await until(()=>calls.some(c=>c.op==='mouse'&&c.action==='move')&&current().mouse.writtenSequence>=calls.filter(c=>c.op==='mouse'&&c.action==='move').at(-1).sequence);
        heartbeat=false;controller.pause();
        const expected='HTTP_MOUSE_CAPTURE_'+Buffer.from('\x1b[<0;5;7M\x1b[<32;6;8M\x1b[<0;6;8m').toString('base64')+'_END';
        const deadline=Date.now()+5000;let cleaned=false;
        while(Date.now()<deadline){output=await read();if(output.text.includes(expected)&&output.session.mouse.buttons===0){cleaned=true;break;}await sleep(50);}
        assert.ok(cleaned,'native drag was not released after desktop pause');
        controller.resume();await until(()=>controller.phase==='ready'&&!controller.needList);
      }
      controller.end({id:controller.selected,view:controller.view});await until(()=>current()?.state==='closed'&&!controller.pendingAction&&!controller.needList);
    }
    for(const op of ['open','write']){
      const values=calls.filter(c=>c.op===op);assert.ok(values.length>=2);assert.deepEqual(values[0],values[1],'lost reply changed request identity');
    }
    process.stdout.write(JSON.stringify({passed:true,shells:['bash','zsh'],lostReplies:true,mouseExpiry:true})+'\n');
  }finally{heartbeat=false;abort.abort();controller.close();}
}
main().catch(error=>{process.stderr.write(String(error.stack)+'\n');process.exitCode=1;});
