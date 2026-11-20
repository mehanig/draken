/** Portable contracts. Hosts own source verification, permissions, I/O and model accounting. */
export interface Discovery {
  id: string;
  revision: string;
  locationKey: string;
  purpose: string;
  appliesWhen: string;
  method: string[];
  limitations: string[];
}
export interface Capability {
  id: string;
  revision: string;
  kind: 'action' | 'check' | 'repair';
  description: string;
  effects: string[];
  repeatable: boolean;
  /** Actions this verifier or repair handler can assess or recover. */
  forActions?: string[];
}
export interface Policy {
  id: string;
  revision: string;
  locationKey: string;
  discoveryRevision: string;
  endpoint: string;
  /** Host-selected lifecycle checks. Model-generated bindings cannot weaken the endpoint. */
  inputCheck: string;
  prepare: string;
  completionCheck: string;
  allowedCapabilities: string[];
  allowedEffects: string[];
  maxAttempts: number;
  timeoutMs: number;
}
export interface Binding {
  /** One-based index into the discovered method, not a new historical claim. */
  step: number;
  action: string;
  verify: string;
  repair?: string;
}
export interface Configuration {
  inputCheck?: string;
  prepare?: string;
  completionCheck?: string;
  bindings: Binding[];
}
export interface Enrichment {
  format: 'factory-enrichment-v1';
  discovery: Discovery;
  policy: Policy;
  configuration: Configuration;
  capabilities: Capability[];
  additions: readonly string[];
  missing: string[];
  ready: boolean;
}
export interface Task {
  id: string;
  locationKey: string;
  inputs: Record<string, string>;
}
export interface Outcome {
  ok: boolean;
  detail: string;
  /** Host-produced receipts, not an agent's unsupported assertion of success. */
  evidence: string[];
}
export interface Invocation {
  phase: 'input' | 'prepare' | 'action' | 'verify' | 'repair' | 'completion';
  step?: number;
  attempt: number;
  task: Task;
  previous?: Outcome;
}
export interface RunEvent {
  sequence: number;
  type: 'started' | 'requested' | 'result' | 'completed' | 'failed' | 'cancelled';
  invocation?: Invocation;
  capability?: string;
  outcome?: Outcome;
  detail?: string;
}
export interface RunnerHost {
  capabilities: Capability[];
  /** Persist an exclusive task claim and the exact plan. Refuse duplicates; never resume blindly. */
  claim(task: Task, plan: Enrichment): Promise<void>;
  /** Freshly check source access/identity, repository identity and current operating policy. */
  authorize(plan: Enrichment, task: Task, signal: AbortSignal): Promise<void>;
  /** Await durable recording before executing anything. Do not put credentials in receipts. */
  record(event: RunEvent): Promise<void>;
  /** Dispatch registered handlers, never execute historical text or model-generated shell strings.
   * Hosts must stop owned subprocesses on cancellation and account for any provider calls. */
  invoke(capability: string, invocation: Invocation, signal: AbortSignal): Promise<Outcome>;
}
