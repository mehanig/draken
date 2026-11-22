const {test}=require('node:test'),assert=require('node:assert/strict');
const {reconstructionEvidence}=require('../dist/workflow-learning');
test('task reconstruction sends labelled excerpts rather than entire original logs',()=>{
 const records=Array.from({length:306},(_,i)=>({ref:'R'+i,sessionId:'session',sequence:i,at:'2026-11-22T00:00:00Z',role:i===300?'user':'assistant',text:'Beginning '+('x'.repeat(20000))+' end.'}));
 const result=reconstructionEvidence({refs:['R1'],coverage:{triggerRefs:['R300'],outcomeRefs:['R305'],gaps:[]}},records);
 assert.equal(result.records.length,12);assert.equal(result.omittedRecords,294);assert.deepEqual(result.records.slice(0,2).map(r=>r.ref),['R300','R305']);
 assert.ok(result.records.every(r=>r.clipped&&r.text.includes('[Middle omitted]')&&r.text.startsWith('Beginning')&&r.text.endsWith('end.')));
 assert.ok(JSON.stringify(result).length<27000);assert.ok(records.every(r=>r.text.length>20000));
});
