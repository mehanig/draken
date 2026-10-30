export interface ObservedSession {
  id: string;
  path: string;
  cwd: string;
  name: string;
  included: number;
  missing: number;
  modified_at: string;
  pending: number;
}

export interface Evidence {
  ref: string;
  event_key: string;
  session_id: string;
  session_name: string;
  source_path: string;
  cwd: string;
  entry_id: string;
  sequence?: number;
  timestamp: string;
  role: string;
  text: string;
}

export interface SyncSummary {
  id: number;
  status: 'open' | 'completed' | 'discarded';
  created_at: string;
  completed_at: string | null;
  briefing: string;
  decisions: string;
  carry_forward: string;
  item_count: number;
  remaining_count: number;
  snapshot_version: number;
  snapshot_at: string;
}

export interface SyncMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface SyncDetail extends SyncSummary {
  items: Evidence[];
  context: Evidence[];
  memory: { sync_id: number; decisions: string; carry_forward: string }[];
  messages: SyncMessage[];
  busy: boolean;
  history_since: string | null;
  models: SyncModels;
  tree: TreeProgress;
}

export interface SyncModels {
  summary: string;
  final: string;
  max_invocations: number;
}

export type NodeKind = 'chunk' | 'session' | 'topics' | 'topic' | 'overview';
export interface Observation {
  topic: string;
  state: 'requested' | 'in_progress' | 'reported_done' | 'validated' | 'blocked' | 'superseded' | 'unclear';
  summary: string;
  evidence: string[];
}
export interface NodeSummary { observations: Observation[]; limitations: string[] }
export interface TopicGroups { groups: { topic: string; members: string[] }[] }
export interface TreeNode {
  key: string;
  kind: NodeKind;
  label: string;
  status: 'pending' | 'running' | 'done' | 'cached' | 'failed';
  children: string[];
  source_count: number;
  error: string;
}
export interface TreeRun {
  id: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  stage: string;
  summary_model: string;
  final_model: string;
  invocations: number;
  max_invocations: number;
  processed_entries: number;
  total_entries: number;
  cache_hits: number;
  error: string;
  question: string | null;
  started_at: string;
  completed_at: string | null;
}
export interface TreeProgress { busy: boolean; complete: boolean; run: TreeRun | null; nodes: TreeNode[] }

export interface ScanResult {
  files: number;
  added: number;
  warnings: string[];
}

export interface Overview {
  sessions: ObservedSession[];
  syncs: SyncSummary[];
  pending: number;
  active_sync_id: number | null;
  session_root: string;
  model: string;
  history_since: string | null;
  history_initialized: boolean;
  summary_model: string;
}
