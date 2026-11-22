#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.4.0'); process.exit(0); }
if (args[0] === 'auth') {
  if (!args.includes('--no-refresh') || args.includes('--credentials')) process.exit(2);
  const control = process.env.DRAKEN_FAKE_CONTROL ? JSON.parse(fs.readFileSync(process.env.DRAKEN_FAKE_CONTROL, 'utf8')) : {};
  const status = control.authState || 'ready';
  console.log(JSON.stringify({ status, provider: 'synthetic', ...(status === 'ready' ? { authType: 'api_key' } : { reason: 'credentials_not_configured' }) }));
  process.exit(status === 'ready' ? 0 : 1);
}
for (const required of ['--print', '--no-session', '--no-tools', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve']) {
  if (!args.includes(required)) { console.error('Missing safety flag ' + required); process.exit(2); }
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const value = JSON.parse(input);
  const model = args[args.indexOf('--model') + 1];
  const control = process.env.DRAKEN_FAKE_CONTROL ? JSON.parse(fs.readFileSync(process.env.DRAKEN_FAKE_CONTROL, 'utf8')) : {};
  if (process.env.DRAKEN_TEST_CALL_LOG) fs.appendFileSync(process.env.DRAKEN_TEST_CALL_LOG, JSON.stringify({
    task: value.task, stage: value.stage, model, question: value.question, previous_user_messages: value.previous_user_messages, sessions: value.sessions, candidates: value.candidates, input: value.input, snapshot: value.snapshot, summary_tree: value.summary_tree, opening_briefing: value.opening_briefing,
    input_characters: input.length, input_bytes: Buffer.byteLength(input), system: args[args.indexOf('--system-prompt') + 1],
    verification_evidence: value.verification_evidence, retrieved_evidence: value.retrieved_evidence, historical_evidence: value.historical_evidence,
    recent_call_transcripts: value.recent_call_transcripts, user_question: value.user_question, citation_repair: value.citation_repair, reference_labels: value.reference_labels,
    allowed_source_ids: value.allowed_source_ids, allowed_observation_ids: value.allowed_observation_ids, repair: value.repair, citation_repairs: value.citation_repairs,
  }) + '\n');
  if (value.user_question === 'FAIL' || (control.failStage && value.stage === control.failStage) || (control.failRepair && value.repair)) {
    console.error('provider unavailable'); process.exit(1);
  }
  if (value.user_question === 'TIMEOUT') { setTimeout(() => console.log('too late'), 10000); return; }
  const emit = result => setTimeout(() => {
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    if (args.includes('--mode') && args[args.indexOf('--mode')+1] === 'json') {
      const usage = control.noUsage ? {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}
        : {input:100,output:10,cacheRead:20,cacheWrite:0,reasoning:2,totalTokens:130,cost:{input:0.001,output:0.002,cacheRead:0.0001,cacheWrite:0,total:0.0031}};
      const message={role:'assistant',provider:'synthetic',model,content:[{type:'text',text}],usage,stopReason:control.protocolStop||'stop'};
      for(const event of [{type:'session',version:3},{type:'agent_start'},{type:'message_start',message:{role:'assistant',content:[]}},
        {type:'message_update',usage,assistantMessageEvent:{type:'text_delta',delta:text}},
        {type:'message_end',message},{type:'turn_end',message,toolResults:[]},{type:'agent_end',messages:[message],willRetry:false},{type:'agent_settled',aborted:false}])console.log(JSON.stringify(event));
    } else console.log(text);
  }, control.taskDelays?.[value.task] ?? control.delay ?? 20);
  if (control.hugeOutput) return emit('界'.repeat(24000));
  if (value.task === 'plan_evidence') return emit(control.badPlan ? { scope: 'project', sessions: ['P9999'] } : control.evidenceScope && control.evidenceScope !== 'project' ? { scope: control.evidenceScope } : control.evidencePlan || { scope: 'project', sessions: [], query: value.question, kind: 'sources', recent: true });
  if (value.task === 'select_evidence') return emit(control.badSelection ? { scope: 'project', selected: ['S9999'] } : { scope: control.evidenceScope || 'project', selected: control.evidenceScope && control.evidenceScope !== 'project' ? [] : value.candidates.slice(0, 8).map(item => item.id) });
  if (value.task === 'sync_recap') {
    if (control.badRecap) return emit('Invalid recap');
    return emit({ lines: ['Export checks were reported; deployment remains unverified.', 'Discussion covered the dashboard choice; no new saved agreement.'] });
  }
  if (value.task === 'repair_summary_citations') {
    if (control.badCitationSelection) return emit({ selections: value.citation_repairs.map(item => ({ observation: item.observation, evidence: item.candidate_source_ids })) });
    return emit({ selections: value.citation_repairs.map(item => ({ observation: item.observation, evidence: [item.candidate_source_ids[0], item.candidate_source_ids.at(-1)] })) });
  }
  if (value.task === 'select_workflow_candidates') return emit({ selected: control.workflowSelection ?? value.candidates.slice(0, 1).map(c => c.id) });
  if (value.task === 'create_workflow_from_history') {
    if (control.taskWorkflow) return emit(control.taskWorkflow);
    const ref = role => value.records.find(r => r.role === role)?.ref;
    const u=ref('user'),a=ref('assistant'),o=ref('toolResult'),refs=[u,a,o].filter(Boolean);
    return emit({kind:'ready',message:'Parser regression and compatibility method from the selected task.',repositoryRef:u,fragment:'fix',workflow:{purpose:'Repair parser defects through a review-ready PR',appliesWhen:'Parser failures requiring compatibility with the existing format',method:['Reproduce the parser defect with a regression test','Correct parsing and verify compatibility','Self-review, repair and retest','Push the approved branch and open a review-ready PR']},process:{summary:'Parser fix with reported checks',limitations:['PR delivery was requested, not observed.'],fragments:[{key:'fix',goal:'Fix the parser defect',context:'Parser compatibility',state:'partial',refs,coverage:{triggerRefs:[u],outcomeRefs:[o],gaps:['PR creation was not observed']},stages:[{key:'regression',action:'Added a parser regression',normalizedAction:'Reproduce a parser defect with a regression test',role:'main',condition:null,claims:[{description:'Agent reported adding the parser regression',basis:'reported',refs:[a]}],refs:[a],tools:[],skills:[]},{key:'checks',action:'Checked parser compatibility',normalizedAction:'Verify parser compatibility',role:'main',condition:null,claims:[{description:'The parser check reported success',basis:'observed',refs:[o]}],refs:[o],tools:[],skills:[]}],dependencies:[],decisions:[],exceptions:[],questions:[],matching:{goal:'Repair parser defects',context:'Parser compatibility'}}]}});
  }
  if (value.task === 'enrich_workflow') return emit(control.invalidEnrichment ? { steps: [] } : { inputs: [], steps: value.workflow.method.map((_, i) => ({ step: i + 1, approach: 'Inspect and carry out this workflow step', checks: ['Verify the step result'] })), review: ['Review the diff and repair findings'], completion: ['Verify the requested endpoint'], risks: [] });
  if (value.task === 'compare_workflow_identity') return emit((value.repair ? control.workflowRepairAssessment : undefined) || control.workflowAssessment || { relation: 'same_workflow_candidate', workflow: { purpose: 'Repair a parser defect', method: ['Reproduce the defect and add a regression test', 'Correct the parser and verify compatibility'], appliesWhen: 'A reproducible parser defect must be repaired without changing the format' }, stagePairs: value.left.stages.slice(0,2).map((s,i)=>({left:s.id,right:value.right.stages[i].id})), reason: 'Same purpose and method', limitations: [] });
  if (value.task === 'summarize') {
    let observations;
    if (value.stage === 'chunk') {
      const items = value.input.evidence;
      const last = items[items.length - 1];
      observations = [{ topic: last.workspace, state: last.role === 'toolResult' ? 'validated' : 'reported_done',
        summary: last.text.slice(0, 800), evidence: [last.id] }];
      if (control.knownFacts) {
        const facts = items.flatMap(item => [...item.text.matchAll(/SYNTHETIC_FACT: (\{[^\n]+\})/g)].map(match => ({ ...JSON.parse(match[1]), evidence: [item.id] })));
        if (facts.length) observations = facts;
      }
    } else {
      const latest = new Map();
      for (const child of value.input.children) for (const observation of child.summary.observations) latest.set(observation.topic, observation);
      observations = [...latest.values()].map(({ topic, state, summary, evidence }) => ({ topic, state, summary, evidence }));
    }
    if (control.compactOutput && value.stage === 'overview') observations = observations.map(item => ({ ...item, summary: item.summary.split('. ')[0] + '. Deployment not checked.' }));
    if (control.tooManySources && !value.repair && value.stage === 'chunk') observations[0].evidence = value.input.evidence.slice(0, 17).map(item => item.id);
    if (control.invalidSources || (control.repairableSources && !value.repair)) observations[0].evidence = ['K-invented'];
    if (control.denseOutput) observations = value.allowed_source_ids.slice(0, 96).map((id, index) => ({
      topic: `Distinct synthetic task ${index}`, state: 'blocked', summary: `Unresolved synthetic work ${index}. ` + 'Retain the negative qualification; deployment was not checked. '.repeat(8), evidence: [id],
    }));
    if (control.expandedReferences && value.stage === 'chunk') observations = Array.from({ length: 96 }, (_, index) => ({
      topic: `Synthetic dense task ${index}`, state: 'blocked', summary: 'Unresolved work; deployment was NOT checked. '.repeat(10), evidence: value.allowed_source_ids.slice(0, 16),
    }));
    let process;
    if (value.stage === 'chunk') {
      process = { summary: 'No procedural facts asserted by the default synthetic provider', fragments: [], limitations: ['Synthetic default has no workflow'] };
      if (control.workflowProcess) {
        const refs = { U: value.input.evidence[0]?.id, I: value.input.evidence[1]?.id, O: value.input.evidence[2]?.id };
        const remap = (v, key) => Array.isArray(v) ? v.map(x => typeof x === 'string' && ['refs','triggerRefs','outcomeRefs'].includes(key) ? refs[x] : remap(x, key)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remap(x, k)])) : v;
        process = remap(control.workflowProcess, '');
      }
      if (control.invalidProcess || (control.repairableProcess && !value.repair)) process = { invented: true };
      if (control.repairableProcess && value.repair) observations[0].summary = 'Changed by process repair';
    }
    emit({ observations, limitations: [], ...(process ? { process } : {}) });
  } else if (value.task === 'prepare_workflow_process') {
    const refs = { U: value.records[0]?.ref, I: value.records[1]?.ref, O: value.records[2]?.ref };
    const remap = (v, key) => Array.isArray(v) ? v.map(x => typeof x === 'string' && ['refs','triggerRefs','outcomeRefs'].includes(key) ? refs[x] : remap(x, key)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remap(x, k)])) : v;
    emit(control.invalidProcess || (control.repairableCachedProcess && !value.repair) ? { invented: true } : remap(control.workflowProcess, ''));
  } else if (value.task === 'group_topics') {
    const groups = new Map();
    for (const item of value.input.observations) {
      if (!groups.has(item.topic)) groups.set(item.topic, { topic: item.topic, members: [] });
      groups.get(item.topic).members.push(item.id);
    }
    const result = [...groups.values()];
    if (control.invalidGroups) result[0].members.pop();
    emit({ groups: result });
  } else if (value.task === 'final_verdict') {
    if (value.user_question === 'SHOW MEMORY') return emit(JSON.stringify(value.previous_sync_memory));
    if (value.user_question === 'INVALID_CITATION') return emit('Invented outcome [E9999999]');
    if (control.invalidFinalOnce && !value.repair) return emit('Unsupported draft [R999999]');
    if (control.missingFinalOnce && !value.repair) return emit('Draft missing its evidence links.');
    if (value.historical_evidence?.sources?.length) return emit(`Historical source reports a speech-path change; not proof of deployment. [${value.historical_evidence.sources[0].ref}]`);
    const refs = [...(value.verification_evidence || []), ...(value.retrieved_evidence || [])];
    const reference = refs[0] ? ` [${refs[0].ref}]` : '';
    if (value.user_question) return emit('The session reports targeted tests passing, not a deployment. Keep the dashboard decision open.' + reference);
    const outcomes = value.summary_tree.flatMap(node => node.observations.map(observation => `${observation.summary} [${observation.evidence[0]}]`)).join('\n');
    emit(`Needs your attention\nAll ${value.snapshot.processed_entries} entries were processed. Review uncertainties.\n\nProgress\n${outcomes}\n\nSuggested discussion\nWhat should we prioritize?`);
  } else { console.error('Unknown fake-provider task'); process.exit(2); }
});
