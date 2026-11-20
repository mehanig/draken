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
  /** The first PR is a read-only preview, not an enabled background learner. */
  learning: 'not-enabled';
}
