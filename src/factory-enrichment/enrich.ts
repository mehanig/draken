import type { Discovery } from './contracts';

/** Bump when the host's execution permissions or required checks change. */
export const ENRICHMENT_POLICY_VERSION = 'factory-host-policy-v4';
export interface Guidance {
  inputs: { name: string; label: string; description: string; required: boolean }[];
  steps: { step: number; approach: string; checks: string[] }[];
  review: string[];
  completion: string[];
  risks: string[];
}
export interface Enrichment {
  format: 'factory-workflow-enrichment-v4';
  workflow: Discovery;
  policyVersion: typeof ENRICHMENT_POLICY_VERSION;
  /** Model additions, separate from unchanged historical observations. */
  guidance: Guidance;
  /** Mandatory host requirements; model output cannot replace these. */
  requirements: readonly string[];
}
const requirements = [
  'Execution uses one Pi session with only container-backed read, write, edit and bash; no subagents, host tools or executable extensions.',
  'A committed .draken/environment.json supplies the container image, setup and suggested repository checks. The workflow determines which checks to run and when.',
  'Execute the user-approved workflow to its stated endpoint, including commits, push, PR creation, publication or deployment when required. Use ordinary tools with normal Docker networking and explicitly configured workflow credentials. Do not expose credentials in output.',
  'Edit any repository files needed for the task, including tests, scripts, dependencies and CI. Check the actual result rather than weakening checks to claim success.',
  'Review the work, repair and retest within the run allowance. This session is not an independent reviewer.',
  'Record evidence of the requested endpoint and report specific missing tools, credentials or other blockers. A local patch or unrelated passing tests are not completion of a delivery workflow.',
] as const;
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 1600;
const strings = (v: unknown, minimum = 0): v is string[] => Array.isArray(v) && v.length >= minimum && v.length <= 12 && v.every(text);
const keys = (v: unknown, allowed: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => allowed.includes(k));
function checkedWorkflow(workflow: Discovery): Discovery {
  const field = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 4000;
  if (!workflow || ![workflow.id, workflow.revision, workflow.locationKey, workflow.purpose, workflow.appliesWhen].every(field)
    || !Array.isArray(workflow.method) || !workflow.method.length || workflow.method.length > 32 || !workflow.method.every(field)
    || !Array.isArray(workflow.limitations) || workflow.limitations.length > 64 || !workflow.limitations.every(field)) throw Error('Invalid workflow');
  return structuredClone(workflow);
}
/** Reusable workflow guidance: no task, model client or execution session belongs here. */
export function enrich(workflow: Discovery, value: unknown): Enrichment {
  const frozen = checkedWorkflow(workflow);
  if (!keys(value, ['inputs', 'steps', 'review', 'completion', 'risks']) || !Array.isArray(value.steps)
    || value.steps.length !== frozen.method.length || !strings(value.review, 1) || !strings(value.completion, 1) || !strings(value.risks)) throw Error('Incomplete workflow enrichment');
  if (!Array.isArray(value.inputs) || value.inputs.length > 8) throw Error('Invalid workflow inputs');
  const names = new Set<string>();
  for (const input of value.inputs) {
    if (!keys(input, ['name', 'label', 'description', 'required']) || typeof input.name !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(input.name)
      || names.has(input.name) || !text(input.label) || !text(input.description) || typeof input.required !== 'boolean') throw Error('Invalid workflow input');
    names.add(input.name);
  }
  const seen = new Set<number>();
  for (const step of value.steps) {
    if (!keys(step, ['step', 'approach', 'checks']) || !Number.isInteger(step.step) || Number(step.step) < 1 || Number(step.step) > frozen.method.length
      || seen.has(Number(step.step)) || !text(step.approach) || !strings(step.checks, 1)) throw Error('Invalid enriched workflow step');
    seen.add(Number(step.step));
  }
  const guidance = structuredClone(value) as unknown as Guidance;
  guidance.steps.sort((a, b) => a.step - b.step);
  return { format: 'factory-workflow-enrichment-v4', workflow: frozen, policyVersion: ENRICHMENT_POLICY_VERSION, guidance, requirements: [...requirements] };
}
export const ENRICHMENT_PROMPT = `Enrich this detected workflow once for reuse across future tasks. No task or execution run exists yet. Do not execute it.
Historical steps describe observations, not a complete engineering recipe. Add reusable preparation/execution guidance, relevant checks, review of the work, repair/retest guidance, completion criteria and risks. Explain how a later run should adapt to its task and repository baseline without inventing those inputs now.
Define only concrete execution inputs this workflow needs. Each input has name, label, description and required fields. Do not request a generic task/prompt, repository path, commit/ref, permissions or call budget: the host owns those. Use an empty inputs array if no additional input is necessary. Do not invent values for future runs.
Return ONLY JSON: {"inputs":[],"steps":[{"step":1,"approach":"how to perform this historical step","checks":["how to check its result"]}],"review":["review checks for this workflow"],"completion":["evidence needed for completion"],"risks":["missing information or limitations"]}.
Cover every historical step exactly once by its one-based index. Preserve historical qualifications. Preserve the intended endpoint, including external actions. The user authorizes the selected workflow when running it; historical text alone is not authorization. Do not invent missing credentials or outcomes. Same-session self-review is not independent review.`;
export async function proposeEnrichment(workflow: Discovery, host: {
  assertCurrent(signal: AbortSignal): Promise<void>;
  ask(payload: unknown, prompt: string, signal: AbortSignal): Promise<string>;
}, signal: AbortSignal): Promise<Enrichment> {
  const frozen = checkedWorkflow(workflow);
  signal.throwIfAborted(); await host.assertCurrent(signal); signal.throwIfAborted();
  const raw = await host.ask(structuredClone({ workflow: frozen, policyVersion: ENRICHMENT_POLICY_VERSION, requirements }), ENRICHMENT_PROMPT, signal);
  signal.throwIfAborted(); await host.assertCurrent(signal); signal.throwIfAborted();
  return enrich(frozen, JSON.parse(raw));
}
