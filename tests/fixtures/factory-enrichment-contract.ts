import { enrich, runWorkflow, sessionPlan, type SessionPlan, type Binding, type Capability, type Configuration, type Discovery, type Enrichment,
  type Invocation, type Outcome, type Policy, type RunEvent, type RunnerHost, type Task } from '../../src/factory-enrichment';

async function proof() {
  const discovery: Discovery = { id: 'example', revision: '1', locationKey: 'repo', purpose: 'Check an artifact', appliesWhen: 'Artifact exists', method: ['Check contents'], limitations: [] };
  const capabilities: Capability[] = [
    { id: 'check', revision: '1', kind: 'check', description: 'Fixture check', effects: [], repeatable: true, forActions: ['act'] },
    { id: 'act', revision: '1', kind: 'action', description: 'Fixture action', effects: [], repeatable: true },
  ];
  const policy: Policy = { id: 'policy', revision: '1', locationKey: 'repo', discoveryRevision: '1', endpoint: 'Checked', inputCheck: 'check', prepare: 'act', completionCheck: 'check', allowedCapabilities: ['act', 'check'], allowedEffects: [], maxAttempts: 1, timeoutMs: 1000 };
  const binding: Binding = { step: 1, action: 'act', verify: 'check' };
  const configuration: Configuration = { inputCheck: 'check', prepare: 'act', completionCheck: 'check', bindings: [binding] };
  const plan: Enrichment = enrich(discovery, policy, configuration, capabilities);
  const task: Task = { id: 'task', locationKey: 'repo', inputs: {} };
  const whole: SessionPlan = sessionPlan(discovery, 'Check the artifact', 'repo', 4);
  if (whole.workflow.method.length !== discovery.method.length || whole.policy.publication !== false) throw Error('Invalid whole-workflow contract');
  const events: RunEvent[] = [];
  const host: RunnerHost = { capabilities, claim: async () => {}, authorize: async () => {},
    record: async (event: RunEvent) => { events.push(event); },
    invoke: async (_: string, invocation: Invocation): Promise<Outcome> => ({ ok: invocation.task.id === task.id, detail: 'Controlled fixture', evidence: ['fixture receipt'] }) };
  const result = await runWorkflow(plan, task, host, new AbortController().signal);
  if (result.status !== 'completed' || events.at(-1)?.type !== 'completed') throw Error('Public contract proof failed');
  console.log('Standalone enrichment and execution proof passed');
}
void proof();
