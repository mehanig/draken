import type { Discovery } from './contracts';
import { enrich, type Enrichment } from './enrich';

export interface SessionPlan {
  format: 'factory-agent-session-v2';
  workflow: Discovery;
  enrichment: Enrichment;
  task: string;
  policy: { locationKey: string; maxCalls: number; tools: readonly ['read', 'write', 'edit', 'bash']; publication: false };
}
/** Execution consumes saved workflow guidance; it never regenerates that guidance for a task. */
export function sessionPlan(workflow: Discovery, task: string, locationKey: string, enrichment: Enrichment, maxCalls = 16): SessionPlan {
  if (typeof task !== 'string' || !task.trim() || task.length > 4000 || workflow.locationKey !== locationKey) throw Error('Invalid workflow session or repository scope');
  if (!enrichment || JSON.stringify(enrich(workflow, enrichment.guidance)) !== JSON.stringify(enrichment)) throw Error('Current saved workflow enrichment required');
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 64) throw Error('Invalid agent invocation allowance');
  return structuredClone({ format: 'factory-agent-session-v2', workflow, enrichment, task, policy: { locationKey, maxCalls, tools: ['read', 'write', 'edit', 'bash'], publication: false } });
}
