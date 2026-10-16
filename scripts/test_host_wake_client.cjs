'use strict';
// The actual desktop parser and pinned mutual-TLS transport, with CI identities.
const assert=require('node:assert/strict'),path=require('node:path');
const protocol=require(path.join(process.argv[2]||path.resolve(__dirname,'../windows/electron/mac'),'wake-protocol.cjs'));
async function main(){
  let raw='';for await(const chunk of process.stdin){raw+=chunk;assert.ok(raw.length<65536);}
  const config=JSON.parse(raw),identity={cert:config.cert,key:config.key};
  const host={address:'127.0.0.1',port:48789,certificate:config.cert};
  const state=await protocol.request(host,identity,'status');
  assert.ok(state.adapters.length>0);
  for(const adapter of state.adapters)assert.equal(adapter.configuration,'unknown');
  await assert.rejects(protocol.request(host,identity,'send',{id:'d'.repeat(32),mac:'02:11:22:33:44:55',network:config.absentNetwork}),{code:'WAKE_NOT_ON_LAN'});
  console.log(JSON.stringify({passed:true,adapters:state.adapters.length,datagramsSent:0}));
}
main().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
