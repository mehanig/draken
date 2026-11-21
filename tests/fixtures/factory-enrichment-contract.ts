import { sessionPlan, enrich, proposeEnrichment, type Discovery, type Guidance, type Enrichment, type SessionPlan } from '../../src/factory-enrichment';
async function proof() {
  const workflow: Discovery = { id: 'example', revision: '1', locationKey: 'repo', purpose: 'Fix parser', appliesWhen: 'Parser defect', method: ['Reproduce', 'Fix'], limitations: ['Historical gap'] };
  const guidance: Guidance = { inputs: [], steps: [{ step: 1, approach: 'Reproduce escaping', checks: ['Failure confirmed'] }, { step: 2, approach: 'Repair escaping', checks: ['Regression passes'] }], review: ['Review edge cases'], completion: ['Format preserved'], risks: [] };
  const expected: Enrichment = enrich(workflow, guidance);
  let calls = 0;
  const actual = await proposeEnrichment(workflow, { assertCurrent: async () => {}, ask: async () => { calls++; return JSON.stringify(guidance); } }, new AbortController().signal);
  const plan: SessionPlan = sessionPlan(workflow, 'Fix escaping', 'repo', actual, 8);
  if (plan.enrichment !== actual && JSON.stringify(plan.enrichment) !== JSON.stringify(actual)) throw Error('Saved enrichment changed');
  if (calls !== 1 || JSON.stringify(actual) !== JSON.stringify(expected) || actual.workflow.method.length !== 2 || !actual.requirements.length) throw Error('Invalid standalone enrichment');
  console.log('Standalone enrichment and execution contract proof passed');
}
void proof();
