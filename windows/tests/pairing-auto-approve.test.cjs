'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {PairingAutoApprover} = require('../electron/pairing-auto-approve.cjs');
const pending = {id: 'a'.repeat(32), generation: 'b'.repeat(32), verification: '1234 ABCD 5678', state: 'waiting', automatic: true, expires: Math.floor(Date.now() / 1000) + 120};
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(calls, pairings = [pending]) {
  const timers = new Set();
  const approver = new PairingAutoApprover({request: async (action, data) => { calls.push([action, data]); return action === 'remote' && data.action === 'lanPairings' ? {ok: true, data: {pairings}} : {ok: true, data: {status: true}};},
    setTimer: fn => { timers.add(fn); return fn; }, clearTimer: fn => timers.delete(fn)});
  return {approver, timers, tick() { const next = [...timers][0]; if (!next) throw new Error('no timer'); timers.delete(next); next(); }};
}

test('approves each waiting automatic request once and ignores other states', async () => {
  const calls = [], other = {...pending, id: 'c'.repeat(32), generation: 'd'.repeat(32), state: 'approving'};
  const manual = {...pending, id: 'e'.repeat(32), generation: 'f'.repeat(32), automatic: false};
  const invalid = {...pending, id: '../escape', generation: 'f'.repeat(32)};
  const f = fixture(calls, [pending, other, manual, invalid]);
  f.approver.start(); f.tick();
  await settle(); await settle();
  const approvals = calls.filter(([action, data]) => data.action === 'lanPairApprove');
  assert.deepEqual(approvals, [['remote', {action: 'lanPairApprove', id: pending.id, generation: pending.generation, verification: pending.verification}]]);
  f.tick(); await settle(); await settle();
  assert.equal(calls.filter(([action, data]) => data.action === 'lanPairApprove').length, 1);
  f.approver.stop();
});

test('stops polling after stop and ignores request failures', async () => {
  const errors = [], timers = new Set();
  const approver = new PairingAutoApprover({request: async () => { throw new Error('offline'); }, onError: error => errors.push(error.message),
    setTimer: fn => { timers.add(fn); return fn; }, clearTimer: fn => timers.delete(fn)});
  approver.start(); const tick = [...timers][0]; timers.delete(tick); tick();
  await settle(); await settle();
  assert.deepEqual(errors, ['offline']);
  approver.stop();
  assert.equal(timers.size, 0);
  assert.equal(approver.started, false);
});

test('enabled network connections are accepted without a settings window and failed decisions retry', async () => {
  const id='a'.repeat(24), calls=[]; let attempts=0;
  const approver=new PairingAutoApprover({request:async(_,data)=>{
    calls.push(data.action);
    if(data.action==='lanPairings')return {ok:true,data:{pairings:[]}};
    if(data.action==='networkStatus')return {ok:true,data:{ready:true,pending:[{id},{id:'invalid'}]}};
    assert.deepEqual(data,{action:'networkApprove',id});
    return {ok:++attempts>1};
  }});
  approver.started=true;
  await approver.poll();await approver.poll();await approver.poll();
  assert.equal(attempts,2);
  approver.stop();
});

test('stop while status is pending cannot approve a late request', async () => {
  let resolve;const calls=[];
  const approver=new PairingAutoApprover({request:(_,data)=>{calls.push(data.action);return new Promise(done=>{resolve=done;});}});
  approver.started=true;const polling=approver.poll();approver.stop();
  resolve({ok:true,data:{pairings:[pending]}});await polling;
  assert.deepEqual(calls,['lanPairings']);
});
