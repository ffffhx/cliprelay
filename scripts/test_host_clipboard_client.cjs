'use strict';
// Run the actual desktop transport against the disposable native Mac host.
const assert=require('node:assert/strict'),path=require('node:path');
const directory=process.argv[2]||path.resolve(__dirname,'../windows/electron/mac');
const {sendClipboard,makeRequest}=require(path.join(directory,'paired-relay.cjs'));
async function main(){
  let raw='';for await(const chunk of process.stdin){raw+=chunk;assert.ok(raw.length<65536);}
  const config=JSON.parse(raw),identity={cert:config.cert,key:config.key};
  const host={certificate:config.cert,address:'127.0.0.1',port:48789};
  const controller=new AbortController(),request=makeRequest(host,identity,controller.signal,'/v1/clipboard');
  try{
    const text='Desktop client → Mac 剪贴板 😀';
    await sendClipboard(host,identity,{kind:'text',text},controller.signal);
    assert.deepEqual(await request({op:'read'}),{ok:true,kind:'text',text});
    await sendClipboard(host,identity,{kind:'png',bytes:Buffer.from(config.png,'base64')},controller.signal);
    const reply=await request({op:'read'}),image=Buffer.from(reply.data,'base64');
    assert.equal(reply.ok,true);assert.equal(reply.kind,'png');
    assert.equal(image.readUInt32BE(16),2);assert.equal(image.readUInt32BE(20),3);
    process.stdout.write(JSON.stringify({passed:true,text:true,png:true})+'\n');
  }finally{controller.abort();}
}
main().catch(error=>{process.stderr.write(String(error.stack)+'\n');process.exitCode=1;});
