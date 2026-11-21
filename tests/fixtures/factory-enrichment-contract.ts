import { sessionPlan, enrich, proposeEnrichment, type Discovery, type Guidance, type Enrichment, type SessionPlan } from '../../src/factory-enrichment';
async function proof() {
  const workflow: Discovery = { id: 'example', revision: '1', locationKey: 'repo', purpose: 'Fix parser', appliesWhen: 'Parser defect', method: ['Reproduce', 'Fix'], limitations: ['Historical gap'] };
  const plan: SessionPlan = sessionPlan(workflow, 'Fix escaping', 'repo', 8);
  const guidance: Guidance = { steps: [{ step: 1, approach: 'Reproduce escaping', checks: ['Failure confirmed'] }, { step: 2, approach: 'Repair escaping', checks: ['Regression passes'] }], review: ['Review edge cases'], completion: ['Format preserved'], risks: [] };
  const expected: Enrichment = enrich(plan, guidance);
  let calls = 0;
  const actual = await proposeEnrichment(plan, { assertCurrent: async () => {}, ask: async () => { calls++; return JSON.stringify(guidance); } }, new AbortController().signal);
  if (calls !== 1 || JSON.stringify(actual) !== JSON.stringify(expected) || actual.plan.workflow.method.length !== 2 || !actual.requirements.length) throw Error('Invalid standalone enrichment');
  console.log('Standalone enrichment and execution contract proof passed');
}
void proof();
