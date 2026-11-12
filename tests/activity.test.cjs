const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { activity } = require('../dist/sync/activity');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const releases = [];
const own = release => { releases.push(release); return release; };
afterEach(() => { for (const release of releases.splice(0).reverse()) release(); });

test('pre-snapshot ownership blocks competing starts without inventing a sync ID', () => {
  const release = own(activity.beginStart());
  assert.equal(activity.starting, true);
  assert.equal(activity.busy, true);
  assert.deepEqual(activity.busyIds, []);
  assert.throws(() => activity.beginStart(), /already being prepared/);
  release();
  const next = own(activity.beginStart());
  release();
  assert.equal(activity.starting, true, 'an old release must not clear a new owner');
  next();
  assert.equal(activity.busy, false);
});

test('cancellation reaches the job owner but does not unlock resources before completion', () => {
  const controller = new AbortController();
  const release = own(activity.beginJob(1, controller));
  assert.equal(activity.cancelJob(1), true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(activity.jobActive(1), true);
  assert.throws(() => activity.beginJob(1, new AbortController()), /still being generated/);
  assert.throws(() => activity.beginCall(1), /still being generated/);
  assert.throws(() => activity.beginStart(), /wait for preparation/);
  release();
  assert.equal(activity.cancelJob(1), false);
  own(activity.beginJob(1, controller));
  release();
  assert.equal(activity.jobActive(1), true, 'even reuse of a controller does not reuse the old lease');
});

test('all job leases remain visible until their own release, including sequential jobs', () => {
  const first = own(activity.beginJob(1, new AbortController()));
  const second = own(activity.beginJob(2, new AbortController()));
  assert.equal(activity.busy, true);
  assert.deepEqual(activity.busyIds, [1, 2]);
  first();
  assert.equal(activity.busy, true);
  assert.deepEqual(activity.busyIds, [2]);
  assert.throws(() => activity.beginStart(), /wait for preparation/);
  second();
  assert.equal(activity.busy, false);
  const next = own(activity.beginJob(1, new AbortController()));
  first();
  assert.equal(activity.busy, true, 'a stale release cannot hide a later job');
  assert.deepEqual(activity.busyIds, [1]);
  next();
  assert.equal(activity.busy, false);
});

test('shutdown cancels owners, refuses new work and waits for the final lease release', () => {
  for (const kind of ['job', 'start', 'call']) {
    const child = spawnSync(process.execPath, ['-e', `
      const assert=require('node:assert/strict'),{activity}=require('./dist/sync/activity');
      (async()=>{
        const kind=${JSON.stringify(kind)},controller=new AbortController();
        const release=kind==='job'?activity.beginJob(1,controller):kind==='start'?activity.beginStart():activity.beginCall(1);
        let finished=false;const done=activity.shutdown().then(()=>{finished=true;});
        if(kind==='job')assert.equal(controller.signal.aborted,true);
        for(const begin of [()=>activity.beginJob(2,new AbortController()),()=>activity.beginStart(),()=>activity.beginCall(2)]) assert.throws(begin,/stopping/);
        await Promise.resolve();assert.equal(finished,false);release();await done;assert.equal(finished,true);
        console.log('DRAINED-'+kind);
      })().catch(error=>{console.error(error);process.exitCode=1;});
    `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), `DRAINED-${kind}`, 'a pending Promise must not let the child silently exit before the final assertion');
  }
});

test('voice ownership is globally exclusive and protects its sync until released', () => {
  const release = own(activity.beginCall(1));
  assert.equal(activity.callActive, true);
  assert.equal(activity.voiceActive(1), true);
  assert.equal(activity.voiceActive(2), false);
  assert.throws(() => activity.beginCall(2), /End the existing call/);
  assert.throws(() => activity.beginJob(1, new AbortController()), /End the voice call/);
  assert.throws(() => activity.beginStart(), /End the active call/);
  release();
  own(activity.beginCall(2));
  release();
  assert.equal(activity.voiceActive(2), true);
});
