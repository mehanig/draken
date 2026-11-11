const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {closeDb}=require('../dist/db/schema'),{summarizeRecap}=require('../dist/sync/recap');
let root;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'draken-recap-format-'));process.env.DRAKEN_DATA_DIR=root;});
afterEach(()=>{closeDb();fs.rmSync(root,{recursive:true,force:true});});
const input={sync_id:1,status:'open',snapshot_at:'2026-01-01',briefing:'Synthetic report, not independent verification.',decisions:'',carry_forward:'',messages:[]};
const signal=()=>new AbortController().signal;
test('overlong prose reflows without losing words or qualifications, using one call and the existing cache key',async()=>{
 const line='The synthetic client was reported implemented. '+ 'Device checks remain unverified. '.repeat(5)+'Delivery is NOT enabled. 🧪';
 assert.ok(line.length>160&&line.length<600);let calls=0;const diagnostics=[];
 const result=await summarizeRecap(input,'test/cheap',async()=>{calls++;return JSON.stringify({lines:[line]});},signal(),d=>diagnostics.push(d));
 assert.equal(result.replace(/\n/g,' '),line);assert.ok(result.split('\n').every(l=>l.length<=160));assert.ok(result.split('\n').length<=5);assert.ok(result.length<=600);
 assert.equal(calls,1);assert.deepEqual(diagnostics,[{status:'reflowed',line_lengths:[line.length],characters:line.length}]);
 assert.equal(await summarizeRecap(input,'test/cheap',async()=>{throw Error('Must reuse accepted cache');},signal()),result);
});
test('valid short lines retain their point boundaries unchanged',async()=>{
 const lines=['Client implementation was reported.','Delivery remains disabled; no device acceptance.'];const diagnostics=[];
 assert.equal(await summarizeRecap(input,'test/valid',async()=>JSON.stringify({lines}),signal(),d=>diagnostics.push(d)),lines.join('\n'));
 assert.equal(diagnostics[0].status,'valid');
});
test('total size and five display lines stay bounded; unbreakable tokens and malformed data get only one repair',async()=>{
 const cases=[['PRIVATE_REJECTED_OUTPUT',/JSON/], [JSON.stringify({lines:['x'.repeat(161)]}),/token longer than 160/],
  [JSON.stringify({lines:['word '.repeat(121)]}),/total limit is 600/],
  [JSON.stringify({lines:Array(5).fill('word '.repeat(35).trim())}),/total limit is 600/],
  [JSON.stringify({lines:['word '.repeat(35).trim(),...Array(4).fill('Point remains unverified.')]}),/display lines/],
  [JSON.stringify({lines:['first\nsecond']}),/embedded line breaks/], [JSON.stringify({lines:Array(6).fill('Point.')}),/use 1 to 5/]];
 for(const [index,[answer,reason]] of cases.entries()){
  let calls=0;const diagnostics=[];
  await assert.rejects(summarizeRecap(input,'test/invalid-'+index,async payload=>{calls++;if(calls===2)assert.match(payload.repair.reason,reason);return answer;},signal(),d=>diagnostics.push(d)),reason);
  assert.equal(calls,2);assert.equal(diagnostics.length,2);assert.ok(diagnostics.every(d=>d.status==='invalid'));assert.doesNotMatch(JSON.stringify(diagnostics),/PRIVATE_REJECTED_OUTPUT/);
 }
});
test('a valid repair retains both diagnostic outcomes without retaining rejected prose',async()=>{
 const diagnostics=[];let calls=0;
 const summary=await summarizeRecap(input,'test/repaired',async()=>++calls===1?'PRIVATE_REJECTED_OUTPUT':JSON.stringify({lines:['Deployment remains unverified.']}),signal(),d=>diagnostics.push(d));
 assert.equal(summary,'Deployment remains unverified.');assert.deepEqual(diagnostics.map(d=>d.status),['invalid','valid']);assert.doesNotMatch(JSON.stringify(diagnostics),/PRIVATE_REJECTED_OUTPUT/);
});
