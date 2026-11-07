export interface HistoryRecord {
  ref: string;
  kind: 'session' | 'snapshot' | 'discussion' | 'decisions' | 'carry_forward';
  session_id: string | null;
  sync_id: number | null;
  origin_ref: string | null;
  title: string;
  workspace: string;
  role: string;
  at: string | null;
  qualification: string;
  text: string;
}
export interface HistoryQuery {
  question: string;
  session_id?: string;
  sync_id?: number;
  before?: string;
}
export interface HistoryResults {
  mode: 'hybrid';
  results: (HistoryRecord & { offset: number; score: number })[];
  limitations: string;
}
export interface HistoryPage {
  record: HistoryRecord;
  offset: number;
  total: number;
  neighbors: HistoryRecord[];
}
export interface HistoryUpdate {
  stage: 'scanning' | 'downloading' | 'loading' | 'indexing' | 'searching' | 'reading';
  completed: number;
  total: number;
  reused: number;
  parallelism?: { workers: number; threads: number };
  remaining_seconds: number | null;
  downloaded_bytes: number;
  download_total_bytes: number;
}
export interface HistoryProgress {
  active: boolean;
  background?: boolean;
  queued: number;
  elapsed_ms: number;
  updated_at: number | null;
  work: HistoryUpdate | null;
}
export type ReportHistory = (update: HistoryUpdate) => void;
export const historyUpdate = (stage: HistoryUpdate['stage'], fields: Partial<Omit<HistoryUpdate, 'stage'>> = {}): HistoryUpdate => ({
  stage, completed: 0, total: 0, reused: 0, remaining_seconds: null, downloaded_bytes: 0, download_total_bytes: 0, ...fields,
});
export interface Embedder {
  readonly fingerprint: string;
  ready(): boolean;
  setup(report?: ReportHistory, allowDownload?: boolean): Promise<void>;
  embed(text: string, query: boolean): Promise<Float32Array>;
  embedMany?(texts: string[], parallel?: boolean): Promise<Float32Array[]>;
  readonly parallelism?: { workers: number; threads: number };
}
