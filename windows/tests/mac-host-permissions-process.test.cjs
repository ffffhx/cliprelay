'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {spawn}=require('node:child_process');
const {HostPermissions}=require('../electron/mac/host-permissions.cjs');
function fixture(mode,options={}){
  const children=[];
  const owner=new HostPermissions({directory:__dirname,pin:{arch:'arm64'},platform:'darwin',arch:'arm64',verify:()=>{},
    launch:(_file,args,settings)=>{
      const child=spawn(process.execPath,[path.join(__dirname,'mac-host-permission-child.cjs'),...args],{
        ...settings,cwd:__dirname,env:{...process.env,CLIPRELAY_PERMISSION_FIXTURE:mode}
      });children.push(child);return child;
    },queryTimeout:5000,requestTimeout:5000,killDelay:20,...options});
  return {owner,children};
}
test('a real short-lived fixture process returns state through bounded stdout',async()=>{
  const f=fixture('reply');const value=await f.owner.query();
  assert.equal(value.screenRecording,false);assert.equal(value.inputControl,true);
  await f.owner.close();assert.equal(f.children[0].exitCode,0);
});
test('timeout stops and reaps an actual owned fixture process',async()=>{
  const f=fixture('hang',{queryTimeout:200});
  await assert.rejects(f.owner.query(),{code:'HOST_PERMISSION_TIMEOUT'});await f.owner.close();
  assert.ok(f.children[0].exitCode!==null || f.children[0].signalCode!==null);
  assert.equal(f.owner.operation,null);
});
test('closing an owner waits for actual child shutdown during a pending request',async()=>{
  const f=fixture('hang'),pending=f.owner.request('screenRecording'),rejected=assert.rejects(pending,{code:'HOST_PERMISSION_CANCELLED'});
  await f.owner.close();await rejected;
  assert.ok(f.children[0].exitCode!==null || f.children[0].signalCode!==null);
  assert.equal(f.owner.snapshot().screenRecording,null);
});
