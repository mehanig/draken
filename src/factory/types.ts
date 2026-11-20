import type { ContractDecision, ContractMatchInput } from '../workflow-learning';

interface FactoryProposal {
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
