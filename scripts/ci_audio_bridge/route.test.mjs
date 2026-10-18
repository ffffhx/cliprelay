import test from 'node:test';
import assert from 'node:assert/strict';
import {addresses} from './route.mjs';
const host='owned-fixture.trycloudflare.com';
const reply=()=>({Status:0,TC:false,CD:false,Question:[{name:host+'.',type:1}],Answer:[{name:host+'.',type:1,TTL:60,data:'104.16.1.1'}]});
test('only exact generated endpoint and bounded public IPv4 answers qualify',()=>{
  assert.deepEqual(addresses(host,reply()),['104.16.1.1']);
  const undotted=reply();undotted.Question[0].name=undotted.Answer[0].name=host;assert.deepEqual(addresses(host,undotted),['104.16.1.1']);
  for(const ip of ['127.0.0.1','10.0.0.1','172.16.2.1','192.168.1.1','169.254.169.254','100.64.0.1','224.0.0.1','0.1.2.3','::1','not-an-ip']){
    const v=reply();v.Answer[0].data=ip;assert.throws(()=>addresses(host,v));
  }
  for(const change of [v=>v.Status=3,v=>v.TC=true,v=>v.CD=true,v=>v.Question[0].name='foreign.invalid.',
      v=>v.Answer[0].name='foreign.invalid.',v=>v.Answer[0].type=5,v=>v.Answer=[],v=>v.Answer=Array(9).fill(v.Answer[0])]){
    const v=reply();change(v);assert.throws(()=>addresses(host,v));
  }
  assert.throws(()=>addresses('localhost',reply()));
});
