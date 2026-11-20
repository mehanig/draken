const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateProcess, validateProcessEvidence, processMatchInput, validateProcessMatch } = require('../dist/workflow-learning');
const claim = (description, basis='observed', refs=['A']) => ({ description, basis, refs });
function sample() {
  return {summary:'A change was checked; its delivery is reported.',fragments:[{
    key:'work',goal:'Change a result',context:'An existing result needs revision',state:'partial',refs:['A','B'],
    coverage:{triggerRefs:[],outcomeRefs:['B'],gaps:['Initial request missing']},
    stages:[{key:'check',action:'Check the result',normalizedAction:'Check the result',role:'main',condition:null,
      claims:[claim('Check output is visible'),claim('Delivery is reported','reported',['B'])],refs:['A','B'],tools:[{name:'tool-one',usage:'Check result',refs:['A']}],skills:[]},
      {key:'repair',action:'Correct the failed check',normalizedAction:'Correct a failure',role:'recovery',condition:claim('A check failed'),claims:[claim('A correction was attempted','attempted')],refs:['A'],tools:[],skills:[]},
      {key:'branch',action:'Use alternate handling when the input is incompatible',normalizedAction:'Handle incompatible input',role:'conditional',condition:claim('Input is incompatible'),claims:[claim('Alternate handling was requested','requested')],refs:['A'],tools:[],skills:[]}],
    dependencies:[],decisions:[],exceptions:[claim('A check failed')],questions:[],matching:{goal:'Revise a result',context:'A revision is requested'}
  }],limitations:['Partial sample']};
}
function result(relation='shared_subprocedure') { return {relation,reason:'Supported overlap, not a complete episode',sharedStages:[{left:'S1',right:'S1',description:'Check the result'}],importantDifferences:[],toolSkillDifferences:[],missingEvidence:['Initial request']}; }

test('recovery and conditional stages cannot become ordinary stages through a second matching narrative', () => {
  const value=sample();validateProcess(JSON.stringify(value),['A','B']);
  const input=processMatchInput(value.fragments[0]);
  assert.deepEqual(input.primary.stages.map(s=>s.id),['S1']);
  assert.deepEqual(input.primary.branches.map(s=>s.id),['S3']);
  assert.deepEqual(input.secondary.recoveries.map(s=>s.id),['S2']);
  value.fragments[0].matching.stages=['Always fix failed checks'];
  assert.throws(()=>validateProcess(JSON.stringify(value),['A','B']),/fields/);
  for(const id of ['S2','S3','unknown']) {
    const bad=result();bad.sharedStages[0].left=id;
    assert.throws(()=>validateProcessMatch(JSON.stringify(bad),[input,input]),/main stages/);
  }
});

test('outcome evidence belongs to individual claims, not a mixed observed stage', () => {
  const value=validateProcess(JSON.stringify(sample()),['A','B']);
  assert.deepEqual(value.fragments[0].stages[0].claims.map(c=>c.basis),['observed','reported']);
  value.fragments[0].stages[0].basis='observed';
  assert.throws(()=>validateProcess(JSON.stringify(value),['A','B']),/fields/);
});

test('conditions need source support; unknown conditions cannot silently become prerequisites', () => {
  for(const mutate of [f=>f.stages[1].condition=null,f=>f.stages[2].condition.refs=[],f=>f.stages[0].condition=claim('Maybe')]) {
    const value=sample();mutate(value.fragments[0]);assert.throws(()=>validateProcess(JSON.stringify(value),['A','B']));
  }
});

test('a reported final result does not establish whole-episode coverage', () => {
  const value=sample(), f=value.fragments[0];f.state='completed';
  assert.throws(()=>validateProcess(JSON.stringify(value),['A','B']),/boundaries/);
  f.coverage.triggerRefs=['A'];assert.throws(()=>validateProcess(JSON.stringify(value),['A','B']),/boundaries/);
  f.coverage.gaps=[];validateProcess(JSON.stringify(value),['A','B']);
  const full=processMatchInput(f), partial=processMatchInput(sample().fragments[0]);
  assert.equal(validateProcessMatch(JSON.stringify(result('same_workflow_candidate')),[full,full]).relation,'same_workflow_candidate');
  for(const pair of [[full,partial],[partial,full],[partial,partial]]) assert.throws(()=>validateProcessMatch(JSON.stringify(result('same_workflow_candidate')),pair),/Incomplete/);
  assert.equal(validateProcessMatch(JSON.stringify(result()),[partial,partial]).relation,'shared_subprocedure');
});

test('tool and explicitly observed skill substitutions change only the secondary comparison data', () => {
  const a=sample().fragments[0], b=structuredClone(a);
  a.stages[0].skills=[{name:'skill-one',usage:'Explicitly used for checking',refs:['A']}];
  b.stages[0].skills=[{name:'skill-two',usage:'Explicitly used for checking',refs:['B']}];
  b.stages[0].tools[0].name='tool-two';b.goal='A different instance identifier';b.key='other';
  const x=processMatchInput(a),y=processMatchInput(b);
  assert.deepEqual(x.primary,y.primary);assert.notDeepEqual(x.secondary,y.secondary);
  validateProcess(JSON.stringify({...sample(),fragments:[a,b]}),['A','B']);
});

test('observed claims cannot cite only assistant plans or secondary summaries', () => {
  const value=sample();
  for(const role of ['assistant','compaction','branch_summary']) assert.throws(()=>validateProcessEvidence(value,[{ref:'A',role},{ref:'B',role:'assistant'}]),/secondary accounts/);
  assert.equal(validateProcessEvidence(value,[{ref:'A',role:'toolResult'},{ref:'B',role:'assistant'}]),value);
  for(const f of value.fragments) {
    for(const s of f.stages) { for(const c of s.claims) if(c.basis==='observed')c.basis='reported';if(s.condition?.basis==='observed')s.condition.basis='reported'; }
    for(const c of f.exceptions)c.basis='reported';
  }
  validateProcessEvidence(value,[{ref:'A',role:'assistant'},{ref:'B',role:'assistant'}]);
});

test('different and insufficient relations cannot also claim shared stages', () => {
  const input=processMatchInput(sample().fragments[0]);
  for(const relation of ['different','insufficient']) {
    assert.throws(()=>validateProcessMatch(JSON.stringify(result(relation)),[input,input]),/disagrees/);
    assert.equal(validateProcessMatch(JSON.stringify({...result(relation),sharedStages:[]}),[input,input]).relation,relation);
  }
  assert.throws(()=>validateProcessMatch(JSON.stringify({...result(),sharedStages:[]}),[input,input]),/disagrees/);
});
