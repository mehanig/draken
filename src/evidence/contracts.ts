/** Module-owned data contracts. No application or storage types cross this boundary. */
interface EvidenceSource {
  ref: string;
  kind: string;
  session_id: string | null;
  sync_id: number | null;
  title: string;
  workspace: string;
  role: string;
  at: string | null;
  qualification: string;
  text: string;
  sequence?: number;
}
interface EvidenceScope {
  session_ids?: string[];
}
export interface EvidenceQuery extends EvidenceScope {
  kind?: 'sources' | 'conversation';
  recent?: boolean;
  question: string;
  before: string;
  limit: number;
}
export interface EvidenceCandidates {
  mode: string;
  results: (EvidenceSource & { offset: number; lead?: string; score?: number })[];
  limitations: string;
}
interface EvidencePage {
  record: EvidenceSource;
  offset: number;
  neighbors: EvidenceSource[];
}
export interface EvidenceDependencies {
  /** Currently permitted sessions; metadata only, never a transcript scan. */
  sessions(signal: AbortSignal): Promise<{ id: string; workspace: string; title: string }[]>;
  /** Search already prepared records only; honor source consent and the cutoff. */
  search(query: EvidenceQuery, signal: AbortSignal): Promise<EvidenceCandidates>;
  /** Recheck consent and original bytes on each read, including neighbors. */
  read(ref: string, offset: number, signal: AbortSignal, before: string): Promise<EvidencePage>;
  /** Apply the host's secret redaction and text normalization policy. */
  cleanText(value: string, limit: number): string;
}
export interface EvidenceRequest {
  question: string;
  /** Only the host handling a new, actual user turn may enable action recognition. */
  allowWorkflowCreation?: boolean;
  /** Optional retrieval refinement; never replaces the actual user request. */
  lookupQuestion?: string;
  before: string;
  signal: AbortSignal;
  /** Explicit host restriction, not a guess about the user's intent. */
  scope?: EvidenceScope;
  previousQuestions?: string[];
  discussion?: { role: string; text: string }[];
  briefing?: string;
  /** The host owns provider choice, invocation accounting and cancellation. */
  ask: (payload: unknown, system: string) => Promise<string>;
}
export type EvidenceResult =
  | { kind: 'ready'; text: string; refs: string[]; workflowCreation?: { before: string; selections: { ref: string; offset: number }[] } }
  | { kind: 'unrelated' | 'clarify'; text: string; refs: string[]; message: string };
