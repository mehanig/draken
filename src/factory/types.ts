import type { ContractDecision, ContractMatchInput } from '../workflow-learning';

export interface WorkflowLocation {
  kind: 'repository' | 'folder' | 'unavailable';
  key: string;
  path: string;
  name: string;
}
interface FactoryProposal {
  location: WorkflowLocation;
  id: string;
  model: string;
  createdAt: string;
  decision: ContractDecision;
  evidence: ContractMatchInput[];
}
export interface FactoryPage {
  proposals: FactoryProposal[];
  nextCursor: number | null;
  unavailable: number;
  learning: 'enabled' | 'paused' | 'error';
  failedExtractions: number;
}
