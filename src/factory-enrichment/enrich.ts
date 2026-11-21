import { sessionPlan, type SessionPlan } from './session';

export interface Guidance {
  steps: { step: number; approach: string; checks: string[] }[];
  review: string[];
  completion: string[];
  risks: string[];
}
export interface Enrichment {
  format: 'factory-workflow-enrichment-v2';
  plan: SessionPlan;
  /** Model-added guidance, explicitly separate from the unchanged historical workflow. */
  guidance: Guidance;
  /** Required by the harness; model output cannot replace or remove these. */
  requirements: readonly string[];
}
const requirements = [
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

/** Validate task-specific guidance without rewriting history or accepting model-selected authority. */
export function enrich(plan: SessionPlan, value: unknown): Enrichment {
  const frozen = sessionPlan(plan.workflow, plan.task, plan.policy.locationKey, plan.policy.maxCalls);
  if (JSON.stringify(frozen) !== JSON.stringify(plan)) throw Error('Invalid session policy');
  if (!keys(value, ['steps', 'review', 'completion', 'risks']) || !Array.isArray(value.steps)
    || value.steps.length !== frozen.workflow.method.length || !strings(value.review, 1) || !strings(value.completion, 1) || !strings(value.risks)) throw Error('Incomplete workflow enrichment');
  const seen = new Set<number>();
  for (const step of value.steps) {
    if (!keys(step, ['step', 'approach', 'checks']) || !Number.isInteger(step.step) || Number(step.step) < 1 || Number(step.step) > frozen.workflow.method.length
      || seen.has(Number(step.step)) || !text(step.approach) || !strings(step.checks, 1)) throw Error('Invalid enriched workflow step');
    seen.add(Number(step.step));
  }
  const guidance = structuredClone(value) as unknown as Guidance;
  guidance.steps.sort((a, b) => a.step - b.step);
  return { format: 'factory-workflow-enrichment-v2', plan: frozen, guidance, requirements: [...requirements] };
}

export const ENRICHMENT_PROMPT = `Enrich this detected workflow for the concrete task. Do not execute it yet. Tools are disabled during this planning phase.
Historical steps describe what was observed, not a complete engineering recipe. Add task-specific implementation guidance, relevant checks, diff review, repair/retest guidance, completion criteria and unresolved risks.
Return ONLY JSON: {"steps":[{"step":1,"approach":"how to perform this historical step for the task","checks":["how to check its result"]}],"review":["task-specific review checks"],"completion":["evidence needed for the requested endpoint"],"risks":["missing information or limitations"]}.
Cover every historical step exactly once using its one-based index. Do not invent historical evidence. Preserve qualifications. Do not add permissions, capabilities, publication, a different task or replacement host checks. Host requirements are mandatory. Self-review in this conversation is not independent review. State unsupported endpoints as risks rather than assuming authority.`;

/** The host supplies an accounted model callback, which may be the first turn of the execution session. */
export async function proposeEnrichment(plan: SessionPlan, host: {
  assertCurrent(signal: AbortSignal): Promise<void>;
  ask(payload: unknown, prompt: string, signal: AbortSignal): Promise<string>;
}, signal: AbortSignal): Promise<Enrichment> {
  const frozen = structuredClone(plan);
  if (JSON.stringify(sessionPlan(frozen.workflow, frozen.task, frozen.policy.locationKey, frozen.policy.maxCalls)) !== JSON.stringify(frozen)) throw Error('Invalid session policy');
  signal.throwIfAborted(); await host.assertCurrent(signal); signal.throwIfAborted();
  const raw = await host.ask(structuredClone({ plan: frozen, requirements }), ENRICHMENT_PROMPT, signal);
  signal.throwIfAborted(); await host.assertCurrent(signal); signal.throwIfAborted();
  return enrich(frozen, JSON.parse(raw));
}
