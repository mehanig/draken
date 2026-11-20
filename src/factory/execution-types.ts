export interface FactoryRun {
  id: string;
  version: string;
  createdAt: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  phase: string;
  detail: string;
  modelCalls: number | null;
  reused: boolean;
  steps: { capability: string; status: 'running' | 'passed' | 'failed' | 'cancelled' | 'unverified' }[];
}
export interface FactoryExecution {
  proposalId: string | null;
  available: boolean;
  reason: string;
  hasPlan: boolean;
  bindings: { step: number; action: string; verify: string }[];
  runs: FactoryRun[];
}
