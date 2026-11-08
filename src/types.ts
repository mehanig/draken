export interface CallReadiness { ready: boolean; briefingReady: boolean; historyReady: boolean; preparing: boolean; before: string | null; error: string }
export type AgentKind = 'pi' | 'codex' | 'claude';
export interface AgentSource { id: AgentKind; name: string; enabled: boolean; roots: { path: string; status: 'present' | 'missing' | 'unavailable' }[] }
export interface ObservedSession {
  id: string;
  agent: AgentKind;
  external_id: string;
  path: string;
  cwd: string;
  name: string;
  included: number;
  missing: number;
  modified_at: string;
  pending: number;
}

export interface Evidence {
  agent?: AgentKind;
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
  unavailable?: string;
  source_key?: string;
}

export interface AutoIndexSettings {
  enabled: boolean; check_seconds: number; batch_records: number;
  phase: 'off' | 'waiting' | 'scanning' | 'indexing' | 'paused' | 'stopping' | 'error';
  pending_records: number; last_completed_at: string | null; error: string;
}
export interface SyncCost { usd: number | null; complete: boolean }
export interface PiAccounting {
  source: 'pi-usage/catalog-pricing'; cost_usd: number | null; complete: boolean; responses: number;
  tokens: { input: number; output: number; cache_read: number; cache_write: number; reasoning: number };
  models: string[];
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
  recap: string;
  recap_state: 'empty' | 'running' | 'ready' | 'failed';
  recap_error: string;
  aggregation_cost: SyncCost | null;
}

interface SyncCard {
  aggregation_cost: SyncCost | null;
  id: number; status: SyncSummary['status']; created_at: string; item_count: number;
  preview: string; preview_kind: 'recap' | 'previous_recap' | 'briefing' | 'empty'; busy: boolean; calls: number; needs_retry: boolean; active_call: boolean;
}
export interface PiSetupStatus {
  source: 'managed' | 'external';
  state: 'missing' | 'incompatible' | 'needs_login' | 'configured' | 'error';
  version: string | null;
  agent_dir: string;
  message: string;
  models: { model: string; state: 'configured' | 'needs_login' | 'unavailable' }[];
}

export interface HomeOverview {
  syncs: SyncCard[]; available: number; included_unreviewed: number; covered: number;
  busy: boolean; active_call: boolean; next_cursor: number | null;
}

interface SyncMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface SyncDetail extends SyncSummary {
  items: Evidence[];
  context: Evidence[];
  memory: { sync_id: number; decisions: string; carry_forward: string; recap?: string; status?: string; snapshot_at?: string }[];
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
interface Observation {
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
export interface ModelCallMetric {
  accounting?: PiAccounting;
  task: string;
  stage: string | null;
  repair: boolean;
  model: string;
  elapsed_ms: number;
  input_characters: number;
  input_tokens_estimate: number;
  output_characters: number | null;
  output_tokens_estimate: number | null;
  status: 'completed' | 'cancelled' | 'failed';
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
  metrics: ModelCallMetric[];
  error: string;
  question: string | null;
  request_id: string | null;
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
  agents: AgentSource[];
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
