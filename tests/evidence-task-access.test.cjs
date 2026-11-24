const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readTaskEvidence}=require('../dist/evidence');

test('task permissions retain uncited neighbors even when they disappear from later context pages',async()=>{
 const record=ref=>({ref,kind:'session',session_id:'source',sequence:1,at:'2026-01-01T00:00:00.000Z',role:'user',text:'Stored task evidence',workspace:'/project'});
 let neighbor=true,revoked=false;const reads=[];
 const dependencies={cleanText:(text,limit)=>text.slice(0,limit),read:async ref=>{
  reads.push(ref);if(ref==='HB'&&revoked)throw Error('Source revoked');
  return{record:record(ref),offset:0,total:20,neighbors:ref==='HA'&&neighbor?[record('HB')]:[]};
 }};
 const request={before:'2026-01-02T00:00:00.000Z',selections:[{ref:'HA',offset:0}],signal:new AbortController().signal};
 const initial=await readTaskEvidence(request,dependencies);assert.deepEqual(initial.references,['HA','HB']);
 neighbor=false;revoked=true;
 await assert.rejects(readTaskEvidence({...request,requiredRefs:initial.references},dependencies),/Source revoked/);
 revoked=false;await readTaskEvidence({...request,requiredRefs:initial.references},dependencies);
 assert.deepEqual(reads,['HA','HA','HB','HA','HB'],'a shifted context page does not itself revoke a still-permitted record');
});
