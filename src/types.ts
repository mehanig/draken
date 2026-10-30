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
}

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
}
