'use strict';
// Runs only read-only status commands through the production process owner.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
async function main(){
  assert.equal(process.platform,'darwin');
  const directory=path.resolve(process.argv[2]);
  const {HostPermissions}=require(path.join(path.dirname(directory),'host-permissions.cjs'));
  const pin=JSON.parse(fs.readFileSync(path.join(path.dirname(directory),'host-engine-pin.json'),'utf8'));
  const owner=new HostPermissions({directory,pin});
  const cases=[];
  try{
    assert.equal(owner.snapshot().checkedAt,null);
    for(const name of ['packaged-status','packaged-repeat-status']){
      const status=await owner.query();
      assert.equal(typeof status.screenRecording,'boolean');assert.equal(typeof status.inputControl,'boolean');
      assert.equal(status.checking,false);assert.equal(status.error,null);assert.equal(owner.operation,null);cases.push(name);
    }
  }finally{await owner.close();}
  assert.equal(owner.snapshot().screenRecording,null);assert.equal(owner.snapshot().inputControl,null);
  process.stdout.write(JSON.stringify({passed:true,cases,nativeRequestsExecuted:false,ownedChildrenReaped:true,
    scope:'Actual packaged engine read-only status via the production Node owner. No permission requests, recording, input or host startup.'})+'\n');
}
main().catch(error=>{console.error(error.code || error.message);process.exitCode=1;});
