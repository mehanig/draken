import type { Discovery } from './contracts';

/** Bump when the host's execution permissions or required checks change. */
export const ENRICHMENT_POLICY_VERSION = 'factory-host-policy-v2';
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
  'A committed .draken/environment.json supplies the approved image, setup and frozen checks. Do not infer or replace it.',
  'Public HTTPS reads, including public GitHub APIs and deployment websites, are authorized through bash: node /factory/network.cjs HTTPS_URL [OUTPUT_FILE]. The helper follows at most five public HTTPS redirects and reports HTTP status and final URL. No separate network tool is needed.',
  'npm is preconfigured with npm_config_registry=http://egress:8080/npm/: use ordinary npm view, install and audit through bash. Use temporary directories for published-package checks. Do not override the registry or claim npm access is unavailable merely because there is no broker tool.',
  'Host/LAN/private and metadata destinations, credentials, arbitrary write methods and CONNECT tunnels are denied. Public reads do not authorize authentication, push, merge, publication or deployment. Outbound URLs can transmit data: do not include secrets or repository contents in them.',
  'Existing tests, scripts, CI, package manifests/locks and environment policy are protected. New regression tests may be added.',
  'Check task applicability and report missing context or authority rather than inventing it.',
  'Inspect repository instructions and implementation; use the recorded baseline and reproduce relevant failures.',
  'Implement the requested change and add appropriate regression coverage without weakening protected checks.',
  'Run relevant tests and compatibility checks; repair failures within the host allowance.',
  'Review the diff for correctness, unintended changes, security concerns and missing tests; repair and retest findings. This is same-session self-review, not an independent reviewer.',
  'Assess the requested endpoint and report unresolved blockers. Host verification separately runs the frozen repository checks; do not equate those checks with arbitrary task acceptance.',
  'Retain the patch and a truthful result. Do not publish, change permissions or exceed the host policy.',
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
Historical steps describe observations, not a complete engineering recipe. Add reusable preparation/execution guidance, relevant checks, diff review, repair/retest guidance, completion criteria and risks. Explain how a later run should adapt to its task and repository baseline without inventing those inputs now.
Define only concrete execution inputs this workflow needs, such as a target release version. Do not request a generic task/prompt, repository path, commit/ref, permissions or call budget: the host owns those. Use an empty inputs array if no additional input is necessary. Do not invent values for future runs.
Return ONLY JSON: {"inputs":[{"name":"target_version","label":"Release version","description":"Published version to verify","required":true}],"steps":[{"step":1,"approach":"how to perform this historical step","checks":["how to check its result"]}],"review":["review checks for this workflow"],"completion":["evidence needed for completion"],"risks":["missing information or limitations"]}.
Cover every historical step exactly once by its one-based index. Preserve historical qualifications. Do not add permissions, publication or replacement host checks. Host requirements are mandatory. Same-session self-review is not independent review. Unsupported endpoints require escalation, not assumed authority.`;
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
