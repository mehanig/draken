#!/usr/bin/env node
// Synthetic test provider. Production never imports this file.
const fs = require('node:fs');
const args = process.argv.slice(2);
for (const required of ['--no-session', '--no-tools', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve']) {
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
    task: value.task, stage: value.stage, model, input: value.input, snapshot: value.snapshot,
    verification_evidence: value.verification_evidence, retrieved_evidence: value.retrieved_evidence,
    allowed_source_ids: value.allowed_source_ids, allowed_observation_ids: value.allowed_observation_ids, repair: value.repair, original: value.original,
  }) + '\n');
  if (value.user_question === 'FAIL' || (control.failStage && value.stage === control.failStage)) {
    console.error('provider unavailable'); process.exit(1);
  }
  if (value.user_question === 'TIMEOUT') { setTimeout(() => console.log('too late'), 10000); return; }
  const emit = result => setTimeout(() => {
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    if (!args.includes('--mode')) { console.log(text); return; }
    const event = value => console.log(JSON.stringify(value));
    event({ type: 'message_start', message: { role: 'assistant' } });
    const pieces = (control.provisionalText || text).match(/[\s\S]{1,24}/g) || [];
    pieces.forEach((delta, index) => setTimeout(() => event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } }), index * (control.streamDelay || 1)));
    setTimeout(() => {
      event({ type: 'message_end', message: { role: 'assistant', stopReason: control.streamFailure ? 'error' : 'stop', content: [{ type: 'text', text }] } });
      event({ type: 'agent_settled', aborted: false });
    }, pieces.length * (control.streamDelay || 1));
  }, control.delay || 20);
  if (value.task === 'summarize') {
    let observations;
    if (value.stage === 'chunk') {
      const items = value.input.evidence;
      const last = items[items.length - 1];
      observations = [{ topic: last.workspace, state: last.role === 'toolResult' ? 'validated' : 'reported_done',
        summary: last.text.slice(0, 800), evidence: [last.id] }];
    } else {
      const latest = new Map();
      for (const child of value.input.children) for (const observation of child.summary.observations) latest.set(observation.topic, observation);
      observations = [...latest.values()].map(({ topic, state, summary, evidence }) => ({ topic, state, summary, evidence }));
    }
    if (control.tooManySources && !value.repair && value.stage === 'chunk') observations[0].evidence = value.input.evidence.slice(0, 17).map(item => item.id);
    if (control.invalidSources || (control.repairableSources && !value.repair)) observations[0].evidence = ['K-invented'];
    emit({ observations, limitations: [] });
  } else if (value.task === 'group_topics') {
    const groups = new Map();
    for (const item of value.input.observations) {
      if (!groups.has(item.topic)) groups.set(item.topic, { topic: item.topic, members: [] });
      groups.get(item.topic).members.push(item.id);
    }
    const result = [...groups.values()];
    if (control.invalidGroups) result[0].members.pop();
    emit({ groups: result });
  } else if (value.task === 'voice_reply') {
    const original = value.original || value;
    if (original.user_question === 'INVALID_CITATION') return emit({ reply: 'Invented outcome.', evidence: ['E999999'], kind: 'grounded' });
    if (original.user_question === 'BAD_JSON') return emit('not JSON');
    const ref = control.voiceRefFromBriefing
      ? [...(original.briefing || '').matchAll(/\[([EC]\d+)\]/g)].at(-1)?.[1]
      : (original.evidence || []).find(item => /tests/i.test(item.text))?.ref || original.evidence?.[0]?.ref;
    let output = JSON.stringify({ reply: 'The targeted export tests passed. Deployment is not confirmed by this evidence.', evidence: ref ? [ref] : [], kind: ref ? 'grounded' : 'conversation' }, null, control.prettyVoice ? 2 : undefined);
    if (!value.repair || control.alwaysBadVoice) {
      if (control.repeatVoice) output += '\n' + output;
      if (control.voiceCommas) output += ',\n' + output;
      if (control.voiceArray) output = '[' + output + ']';
      if (control.voiceBadTail) output += '\nThis is not a JSON object.';
      if (control.voiceBadCitationTail) output += '\n' + JSON.stringify({ reply: 'An invented result.', kind: 'grounded', evidence: ['E999999'] });
      if (control.voiceText) output = 'Yesterday, the export tests passed. Deployment is not confirmed. ' + JSON.stringify(ref ? [ref] : []);
    }
    emit(output);
  } else if (value.task === 'final_verdict') {
    if (value.user_question === 'SHOW MEMORY') return emit(JSON.stringify(value.previous_sync_memory));
    if (value.user_question === 'INVALID_CITATION') return emit('Invented outcome [E9999999]');
    const refs = value.verification_evidence || [];
    const reference = refs[0] ? ` [${refs[0].ref}]` : '';
    if (value.user_question) return emit('The session reports targeted tests passing, not a deployment. Keep the dashboard decision open.' + reference);
    const outcomes = value.summary_tree.flatMap(node => node.observations.map(observation => `${observation.summary} [${observation.evidence[0]}]`)).join('\n');
    emit(`Needs your attention\nAll ${value.snapshot.processed_entries} entries were processed. Review uncertainties.\n\nProgress\n${outcomes}\n\nSuggested discussion\nWhat should we prioritize?`);
  } else { console.error('Unknown fake-provider task'); process.exit(2); }
});
