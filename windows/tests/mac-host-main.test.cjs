'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function fixture({defer=setImmediate}={}){
  const events=new Map(),windows=[],calls=[];let quit=0;
  const app={setName(){},setPath(){},getPath:()=>'/fixture',requestSingleInstanceLock:()=>true,on:(name,handler)=>events.set(name,handler),
    whenReady:()=>new Promise(()=>{}),quit:()=>{quit++;}};
  class Window{
    constructor(){this.events=new Map();this.webContents={id:windows.length+1,on:()=>{},setWindowOpenHandler:()=>{}};windows.push(this);}
    on(name,fn){this.events.set(name,fn);}once(name,fn){this.events.set(name,fn);}loadFile(){}close(){this.events.get('closed')?.();}
  }
  const owner={close:async()=>{calls.push('host-close');},releaseWindow:()=>{calls.push('window-release');}};
  const permissionOwner={close:async()=>{calls.push('permissions-close');}};
  const context={__dirname:path.join(__dirname,'../electron/mac'),setTimeout,clearTimeout,setImmediate:defer,console,fixtureOwner:owner,fixturePermissions:permissionOwner,
    require:name=>name==='electron'?{app,BrowserWindow:Window}:name.startsWith('node:')?require(name):{},Buffer};
  const source=fs.readFileSync(path.join(__dirname,'../electron/mac/main.cjs'),'utf8');
  vm.runInNewContext(source+'\nhost=fixtureOwner;hostPermissions=fixturePermissions;this.fixtureOpen=openWindow;',context);
  return {context,events,owner,permissionOwner,calls,get quit(){return quit;},windows};
}
test('application quit waits for the hosting owner and permission owner, including repeated quit events',async()=>{
  const f=fixture();let releaseHost,releasePermissions;
  f.owner.close=()=>{f.calls.push('host-close');return new Promise(resolve=>releaseHost=resolve);};
  f.permissionOwner.close=()=>{f.calls.push('permissions-close');return new Promise(resolve=>releasePermissions=resolve);};
  let prevented=0;const event={preventDefault:()=>prevented++};f.events.get('before-quit')(event);f.events.get('before-quit')(event);
  assert.equal(prevented,2);assert.equal(f.quit,0);assert.deepEqual(f.calls,['permissions-close','host-close']);
  releaseHost();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.quit,0);
  releasePermissions();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.quit,1);
  f.events.get('before-quit')(event);assert.equal(prevented,2);
});

test('settled cleanup does not reenter native quit before its cancelled event has unwound',async()=>{
  const pending=[],f=fixture({defer:callback=>pending.push(callback)});
  f.context.fixtureOpen('host',{},{});
  let prevented=0;const event={preventDefault(){prevented++;}};
  f.events.get('before-quit')(event);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.quit,0,'cleanup microtasks must not recursively call app.quit');
  assert.equal(pending.length,1);assert.equal(prevented,1);
  f.events.get('before-quit')(event);assert.equal(prevented,2);
  pending.shift()();assert.equal(f.quit,1);
  f.events.get('before-quit')(event);assert.equal(prevented,2);
  assert.deepEqual(f.calls,['permissions-close','host-close']);
});
test('closing the registered host window releases pending UI reads without closing hosting',()=>{
  const f=fixture(),window=f.context.fixtureOpen('host',{},{});window.close();assert.deepEqual(f.calls,['window-release']);
});
