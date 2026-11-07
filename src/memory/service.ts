import path from 'path';
import { fork, type ChildProcess } from 'child_process';
import { getDataDir, getDb } from '../db/schema';
import { getSourceRoots } from '../sources/registry';
import { HttpError } from '../sync/store';
import { historyUpdate, type HistoryPage, type HistoryProgress, type HistoryQuery, type HistoryResults, type HistoryUpdate } from './types';
import { storedHistoryReadiness } from './readiness';

// One owned CPU worker; ordinary concurrent requests wait rather than requiring
// the user to manage an index. No model/runtime is loaded in the dashboard.
interface Work {
  id: number; method: string; args: Record<string, unknown>; background: boolean;
  resolve(value: unknown): void; reject(error: Error): void;
  signal?: AbortSignal; abort(): void; timer?: NodeJS.Timeout; deadline?: NodeJS.Timeout;
  started?: number; updated?: number; progress?: HistoryUpdate;
}
let child: ChildProcess | undefined, directory = '', sessionRoot = '', sequence = 0, active: Work | undefined;
let idle: NodeJS.Timeout | undefined;
const retiring = new Set<ChildProcess>(), queue: Work[] = [];
const failure = () => new HttpError(503, 'History could not be prepared or searched. Check network access on first use; if session files changed or moved, scan sessions again, then retry your question. Completed work is cached; no other provider or search mode was substituted.');
const cancelled = () => new HttpError(409, 'History lookup stopped. Completed work is retained for the next request.');
function settle(work: Work, error?: Error, value?: unknown) {
  clearTimeout(work.timer); clearTimeout(work.deadline); work.signal?.removeEventListener('abort', work.abort);
  if (active === work) active = undefined;
  if (error) work.reject(error); else work.resolve(value);
}
function retire() {
  const prior = child; child = undefined;
  if (prior) {
    retiring.add(prior); prior.kill('SIGTERM');
    const timer = setTimeout(() => { if (prior.exitCode === null && prior.signalCode === null) prior.kill('SIGKILL'); }, 1500); timer.unref();
  }
}
function watch(work: Work) {
  clearTimeout(work.timer);
  work.timer = setTimeout(() => { if (active === work) { settle(work, failure()); retire(); } }, work.method.startsWith('read') ? 30000 : 10 * 60000);
}
function progressValue(value: any): HistoryUpdate | undefined {
  if (!value || !['scanning', 'downloading', 'loading', 'indexing', 'searching', 'reading'].includes(value.stage)) return;
  for (const name of ['completed', 'total', 'reused', 'downloaded_bytes', 'download_total_bytes']) if (!Number.isSafeInteger(value[name]) || value[name] < 0) return;
  if (value.completed > value.total || !Number.isSafeInteger(value.total + value.reused) || value.downloaded_bytes > value.download_total_bytes) return;
  if (value.remaining_seconds !== null && (!Number.isSafeInteger(value.remaining_seconds) || value.remaining_seconds < 0)) return;
  const p = value.parallelism;
  if (p !== undefined && (!p || !Number.isSafeInteger(p.workers) || p.workers < 1 || p.workers > 2 || !Number.isSafeInteger(p.threads) || p.threads < p.workers || p.threads > 6)) return;
  return historyUpdate(value.stage, { completed: value.completed, total: value.total, reused: value.reused,
    ...(p ? { parallelism: { workers: p.workers, threads: p.threads } } : {}),
    remaining_seconds: value.remaining_seconds, downloaded_bytes: value.downloaded_bytes, download_total_bytes: value.download_total_bytes });
}
export function historyProgress(): HistoryProgress {
  return { active: Boolean(active), background: active?.background || false, queued: queue.length, elapsed_ms: active?.started ? Date.now() - active.started : 0,
    updated_at: active?.updated || null, work: active?.progress || null };
}
function start() {
  if (child) return;
  const processChild = fork(path.join(__dirname, 'worker.js'), [directory, sessionRoot], { execArgv: [],
    env: { PATH: process.env.PATH, LANG: process.env.LANG, SYSTEMROOT: process.env.SYSTEMROOT },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  child = processChild;
  processChild.on('message', (message: any) => {
    if (child !== processChild || !message || !active || message.id !== active.id) return;
    if (message.progress !== undefined) {
      const value = progressValue(message.progress);
      if (value) { active.progress = value; active.updated = Date.now(); watch(active); }
      return;
    }
    settle(active, message.error ? failure() : undefined, message.value); pump();
  });
  const exited = () => {
    retiring.delete(processChild);
    if (child === processChild) { child = undefined; if (active) settle(active, failure()); }
    pump();
  };
  processChild.once('error', exited); processChild.once('exit', exited);
}
function pump() {
  if (active || retiring.size) return;
  clearTimeout(idle);
  if (!queue.length) { if (child) { idle = setTimeout(stopHistory, 5 * 60000); idle.unref(); } return; }
  const work = queue.shift()!;
  if (work.signal?.aborted) { settle(work, cancelled()); pump(); return; }
  active = work;
  try {
    start();
    work.started = work.updated = Date.now(); work.progress = historyUpdate(work.method.startsWith('read') ? 'reading' : 'scanning');
    watch(work);
    // A healthy first index can exceed an interactive-query timeout. Progress
    // renews its stall deadline, but total work remains bounded to two hours.
    work.deadline = setTimeout(() => { if (active === work) { settle(work, failure()); retire(); } }, 2 * 60 * 60000);
    child!.send({ id: work.id, method: work.method, ...work.args }, error => { if (error && active === work) { settle(work, failure()); retire(); } });
  } catch { settle(work, failure()); retire(); if (!retiring.size) pump(); }
}
function request<T>(method: string, args: Record<string, unknown> = {}, signal?: AbortSignal, background = false): Promise<T> {
  if (signal?.aborted) return Promise.reject(cancelled());
  const roots = JSON.stringify(getSourceRoots());
  if (directory !== getDataDir() || sessionRoot !== roots) { stopHistory(); directory = getDataDir(); sessionRoot = roots; }
  if (background && (active || queue.length || retiring.size)) return Promise.reject(cancelled());
  if (!background && active?.background) { settle(active, cancelled()); retire(); }
  if (queue.length >= 8) return Promise.reject(new HttpError(429, 'Too many history requests. Try again shortly.'));
  getDb(); // Only the app initializes its DB. The worker opens it read-only.
  return new Promise<T>((resolve, reject) => {
    const work: Work = { id: ++sequence, method, args, signal, background, resolve: value => resolve(value as T), reject, abort: () => {
      if (active === work) { settle(work, cancelled()); retire(); }
      else { const at = queue.indexOf(work); if (at >= 0) { queue.splice(at, 1); settle(work, cancelled()); } }
    } };
    signal?.addEventListener('abort', work.abort, { once: true });
    queue.push(work); pump();
  });
}
export function stopHistory() {
  clearTimeout(idle);
  if (active) settle(active, cancelled());
  for (const work of queue.splice(0)) settle(work, cancelled());
  retire();
}
export function validateHistoryQuery(value: unknown): HistoryQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'A history query is required');
  const query = value as Record<string, unknown>;
  if (Object.keys(query).some(key => !['question', 'session_id', 'sync_id', 'before'].includes(key))) throw new HttpError(400, 'Unknown history query option');
  if (typeof query.question !== 'string' || !query.question.trim() || query.question.length > 2000) throw new HttpError(400, 'History question must be 1 to 2000 characters');
  if (query.session_id !== undefined && (typeof query.session_id !== 'string' || !/^(?:(?:codex|claude):)?[\w-]{1,128}(?::[\w-]{1,128})?$/.test(query.session_id))) throw new HttpError(400, 'Invalid session filter');
  if (query.sync_id !== undefined && (!Number.isSafeInteger(query.sync_id) || (query.sync_id as number) < 1)) throw new HttpError(400, 'Invalid sync filter');
  if (query.before !== undefined && (typeof query.before !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(query.before) || !Number.isFinite(Date.parse(query.before)) || new Date(query.before).toISOString() !== query.before)) throw new HttpError(400, 'Invalid history cutoff');
  return { ...query, question: query.question.trim() } as HistoryQuery;
}
export const historyReadiness = () => storedHistoryReadiness(getDataDir(), getDb());
export const prepareHistory = (before: string, signal: AbortSignal, background = false) => request<void>('prepare', { before }, signal, background);
export const searchPreparedHistory = (query: HistoryQuery, signal?: AbortSignal) => request<HistoryResults>('search-prepared', { query: validateHistoryQuery(query) }, signal);
export const searchHistory = (query: HistoryQuery, signal?: AbortSignal) => request<HistoryResults>('search', { query: validateHistoryQuery(query) }, signal);
export function readHistory(ref: string, offset = 0, signal?: AbortSignal, preparedBefore?: string) {
  if (!/^H[a-f0-9]{24}$/.test(ref) || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new HttpError(400, 'Invalid historical source or offset');
  if (preparedBefore !== undefined) validateHistoryQuery({ question: 'source', before: preparedBefore });
  return request<HistoryPage>(preparedBefore ? 'read-prepared' : 'read', { ref, offset, before: preparedBefore }, signal);
}
