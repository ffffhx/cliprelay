'use strict';
const mode=process.argv[2],timer=setInterval(()=>{},1000);
let bytes=Buffer.alloc(0),initialized=false;
process.stdin.on('data',chunk=>{
  bytes=Buffer.concat([bytes,chunk]);if(initialized || !bytes.includes(10))return;initialized=true;
  const frame=JSON.parse(bytes.toString());
  process.send?.({initialized:true,protocol:frame.protocol,passwordMatches:frame.password==='fixture-only-password'});
  if(mode==='quiet' || mode==='ignore')return;
  if(mode==='flood'){process.stdout.write('x'.repeat(4097));return;}
  if(mode==='bad-utf8'){process.stdout.write(Buffer.from([0xff,10]));return;}
  const reply={type:'listening',protocol:1,pid:process.pid,ownerPid:process.ppid,ipc:'/fixture/clipboard-relay.sock',nativeWorkers:false};
  if(mode==='wrong-pid')reply.pid++;
  if(mode==='wrong-owner')reply.ownerPid++;
  if(mode==='workers')reply.nativeWorkers=true;
  let encoded=JSON.stringify(reply);
  if(mode==='duplicate')encoded=encoded.replace('{','{"protocol":2,');
  if(mode==='extra-field')encoded=encoded.replace('{','{"unexpected":true,');
  if(mode==='extra-byte')encoded+='\nx';
  process.stdout.write(encoded+'\n');
  if(mode==='exit')setTimeout(()=>process.exit(7),150);
  if(mode==='late-data')setTimeout(()=>process.stdout.write('x'),150);
});
process.stdin.on('end',()=>{if(mode==='ignore')return;clearInterval(timer);setTimeout(()=>process.exit(0),30);});
