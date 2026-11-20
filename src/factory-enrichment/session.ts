import type { Discovery } from './contracts';

export interface SessionPlan {
  format: 'factory-agent-session-v1';
  workflow: Discovery;
  task: string;
  policy: { locationKey: string; maxCalls: number; tools: readonly ['read', 'write', 'edit', 'bash']; publication: false };
}
/** Whole-workflow execution is explicit; never disguise it as a single historical step binding. */
export function sessionPlan(workflow: Discovery, task: string, locationKey: string, maxCalls = 16): SessionPlan {
  const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 4000;
  if (!workflow || ![workflow.id, workflow.revision, workflow.purpose, workflow.appliesWhen, locationKey].every(text)
    || workflow.locationKey !== locationKey || !Array.isArray(workflow.method) || !workflow.method.length || workflow.method.length > 32 || !workflow.method.every(text)
    || !Array.isArray(workflow.limitations) || workflow.limitations.length > 64 || !workflow.limitations.every(text) || !text(task)) throw Error('Invalid workflow session or repository scope');
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 64) throw Error('Invalid agent invocation allowance');
  return structuredClone({ format: 'factory-agent-session-v1', workflow, task, policy: { locationKey, maxCalls, tools: ['read', 'write', 'edit', 'bash'], publication: false } });
}
