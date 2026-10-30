import type { Overview, ScanResult, SyncDetail } from '../types';

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const token = localStorage.getItem('draken_token');
  const response = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) {
    localStorage.removeItem('draken_token');
    localStorage.removeItem('draken_username');
    window.location.reload();
    throw new Error('Authentication required');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

export const api = {
  overview: () => request<Overview>('/overview'),
  scan: () => request<ScanResult>('/scan', 'POST'),
  include: (id: string, included: boolean) => request<Overview>(`/sessions/${encodeURIComponent(id)}`, 'PATCH', { included }),
  start: (history_since?: string | null) => request<{ sync: SyncDetail; scan: ScanResult }>('/syncs', 'POST', { history_since }),
  sync: (id: number) => request<SyncDetail>(`/syncs/${id}`),
  brief: (id: number) => request<SyncDetail>(`/syncs/${id}/briefing`, 'POST', { consent: true }),
  discuss: (id: number, message: string) => request<SyncDetail>(`/syncs/${id}/messages`, 'POST', { message, consent: true }),
  notes: (id: number, decisions: string, carry_forward: string) => request<SyncDetail>(`/syncs/${id}/notes`, 'PATCH', { decisions, carry_forward }),
  finish: (id: number, decisions: string, carry_forward: string) => request<SyncDetail>(`/syncs/${id}/complete`, 'POST', { decisions, carry_forward, reviewed: true }),
  discard: (id: number) => request<SyncDetail>(`/syncs/${id}/discard`, 'POST'),
};
