import type { PreparationUsage, UsageRange, UsageBucket, CallReadiness, PiSetupStatus, AutoIndexSettings, Overview, HomeOverview, ScanResult, SyncDetail, TreeProgress, NodeSummary, TopicGroups } from '../types';
import type { HistoryPage, HistoryProgress, HistoryQuery, HistoryResults } from '../../../src/memory/types';

import { authorizationHeaders, clearSession } from '../auth/session';

async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method, signal,
    headers: { 'Content-Type': 'application/json', ...authorizationHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) {
    clearSession();
    window.location.reload();
    throw new Error('Authentication required');
  }
  if (response.status === 204) return undefined as T;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

export const setup = (refresh = false) => request<{ pi: PiSetupStatus; data_dir: string }>(`/setup${refresh ? '?refresh=1' : ''}`);
export const preparationUsage = (range: UsageRange, bucket: UsageBucket, signal?: AbortSignal) => request<PreparationUsage>(`/settings/preparation-usage?range=${range}&bucket=${bucket}`, 'GET', undefined, signal);
export const autoIndexSettings = () => request<AutoIndexSettings>('/settings/auto-index');
export const setAutoIndex = (enabled: boolean) => request<AutoIndexSettings>('/settings/auto-index', 'PATCH', { enabled });
export const home = (before?: number) => request<HomeOverview>(`/home${before ? `?before=${before}` : ''}`);
export const startCall = (request_id: string) => request<{ sync: SyncDetail; scan: ScanResult }>('/syncs/start-call', 'POST', { request_id });
export const startChat = (request_id: string) => request<{ sync: SyncDetail; scan: ScanResult }>('/syncs/start-chat', 'POST', { request_id });
export const chat = (id: number, message: string, request_id: string) => request<SyncDetail>(`/syncs/${id}/chat/messages`, 'POST', { message, request_id });
export const recap = (id: number) => request<SyncDetail>(`/syncs/${id}/recap`, 'POST');
export const overview = () => request<Overview>('/overview');
export const scan = () => request<ScanResult>('/scan', 'POST');
export const enableAgent = (agent: string, enabled: boolean) => request<Overview>(`/agents/${encodeURIComponent(agent)}`, 'PATCH', { enabled });
export const include = (id: string, included: boolean) => request<Overview>(`/sessions/${encodeURIComponent(id)}`, 'PATCH', { included });
export const sync = (id: number) => request<SyncDetail>(`/syncs/${id}`);
export const progress = (id: number) => request<TreeProgress>(`/syncs/${id}/progress`);
export const callReadiness = (id: number, signal?: AbortSignal) => request<CallReadiness>(`/syncs/${id}/call-readiness`, 'GET', undefined, signal);
export const chatReadiness = (id: number, signal?: AbortSignal) => request<CallReadiness>(`/syncs/${id}/chat-readiness`, 'GET', undefined, signal);
export const prepareCall = (id: number) => request<SyncDetail>(`/syncs/${id}/prepare-call`, 'POST');
export const treeNode = (id: number, key: string) => request<{ label: string; output: NodeSummary | TopicGroups; refs: Record<string, string> }>(`/syncs/${id}/tree/${key}`);
export const expand = (id: number) => request<{ sync: SyncDetail; scan: ScanResult }>(`/syncs/${id}/expand`, 'POST');
export const cancel = (id: number) => request<TreeProgress>(`/syncs/${id}/cancel`, 'POST');
export const brief = (id: number) => request<SyncDetail>(`/syncs/${id}/briefing`, 'POST');
export const discuss = (id: number, message: string) => request<SyncDetail>(`/syncs/${id}/messages`, 'POST', { message });
export const historyProgress = (signal?: AbortSignal) => request<HistoryProgress>('/memory/progress', 'GET', undefined, signal);
export const searchHistory = (query: HistoryQuery, signal?: AbortSignal) => request<HistoryResults>('/memory/search', 'POST', query, signal);
export const readHistory = (ref: string, offset = 0, signal?: AbortSignal) => request<HistoryPage>(`/memory/records/${encodeURIComponent(ref)}?offset=${offset}`, 'GET', undefined, signal);
export const notes = (id: number, decisions: string, carry_forward: string) => request<SyncDetail>(`/syncs/${id}/notes`, 'PATCH', { decisions, carry_forward });
export const finish = (id: number, decisions: string, carry_forward: string) => request<SyncDetail>(`/syncs/${id}/complete`, 'POST', { decisions, carry_forward, reviewed: true });
export const discard = (id: number) => request<SyncDetail>(`/syncs/${id}/discard`, 'POST');
