import type { Enrichment } from '../factory-enrichment';
import type { ContractDecision, ContractMatchInput, TaskWorkflow } from '../workflow-learning';

export interface WorkflowLocation {
  kind: 'repository' | 'folder' | 'unavailable';
  key: string;
  path: string;
  name: string;
}
export type SavedEnrichment = { status: 'pending' | 'running' | 'failed' | 'ready'; value?: Enrichment };
interface FactoryProposal {
  enrichment?: SavedEnrichment;
  location: WorkflowLocation;
  id: string;
  model: string;
  createdAt: string;
  decision: ContractDecision | null;
  aliases?: string[];
  task?: { workflow: TaskWorkflow['workflow']; limitations: string[]; reason: string; request: string; exampleCount?: number | null };
  evidence: ContractMatchInput[];
}
export interface FactoryPage {
  proposals: FactoryProposal[];
  nextCursor: number | null;
  unavailable: number;
  learning: 'enabled' | 'paused' | 'error';
  learningError?: string;
  preparationErrors?: number;
  failedExtractions: number;
}
