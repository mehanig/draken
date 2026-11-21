import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getDataDir } from '../data-dir';
import { HttpError } from '../errors';
import { workflowLocation } from './location';
import { readDiscovery } from './discovery';
import { sessionPlan } from '../factory-enrichment';
import { claimFactoryExecution } from './execution-owner';

import type { WorkspaceRun, WorkspacePage } from './workspace-types';
interface Request { id: string; ref: string; propose?: boolean; location: string; createdAt: string; workflowId?: string; revision?: string; task?: string }
const jobs = new Map<string, { cancel(): void; stopped: Promise<void> }>();
let starting = false, stopping = false;
const root = () => path.join(getDataDir(), 'factory-workspaces');
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id);
const entry = path.resolve(__dirname, '../../scripts/factory-workspace.cjs');
function read<T>(file: string): T | undefined { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } }
function save(file: string, value: unknown) { const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function config() {
  const repository = process.env.DRAKEN_WORKSPACE_REPO || '';
  const location = repository ? workflowLocation(repository) : null;
  const available = process.platform !== 'win32' && location?.kind === 'repository' && !!process.env.DRAKEN_WORKSPACE_ALLOWED_IMAGES
    && !!process.env.DRAKEN_DOCKER_BIN && !!process.env.DRAKEN_DOCKER_HOST && fs.existsSync(entry);
  return { repository, location, available: !!available, agentAvailable: !!available && !!process.env.DRAKEN_FACTORY_PI_SDK && fs.existsSync(process.env.DRAKEN_FACTORY_PI_SDK) };
}
function requests(): Request[] {
  return fs.existsSync(root()) ? fs.readdirSync(root()).filter(validId).map(id => read<Request>(path.join(root(), id, 'request.json'))).filter((r): r is Request => !!r).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
}
function view(request: Request): WorkspaceRun {
  const dir = path.join(root(), request.id), work = path.join(dir, 'work');
  const result = read<{ status: string; detail?: string; commit?: string; modelCalls: number | null; sessionId?: string }>(path.join(work, 'result.json'));
  const source = read<{ commit: string }>(path.join(work, 'source.json'));
  const exit = read<{ code: number | null; cancelled: boolean }>(path.join(dir, 'exit.json'));
  const stages: WorkspaceRun['stages'] = []; const progress = path.join(work, 'progress.jsonl');
  const file = fs.existsSync(progress) ? progress : path.join(work, 'events.jsonl');
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    let event: { type: string; name: string; code?: number }; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'stage-started') stages.push({ name: event.name, status: 'running' });
    if (event.type === 'stage-result') { const stage = [...stages].reverse().find(s => s.name === event.name); if (stage) stage.status = event.code === 0 ? 'passed' : 'failed'; }
  }
  const status = result?.status || (jobs.has(request.id) ? 'running' : exit && !stages.length && !fs.existsSync(path.join(work, 'resources.json')) ? exit.cancelled ? 'cancelled' : 'failed' : 'interrupted');
  if (status !== 'running') for (const stage of stages) if (stage.status === 'running') stage.status = 'unverified';
  const patch = path.join(work, 'changes.patch');
  const accounting = read<{modelCalls: number}>(path.join(work, 'agent/status.json'));
  const session = read<{id: string}>(path.join(work, 'agent/session.json'));
  return { id: request.id, ref: request.ref, workflowId: request.workflowId, task: request.task, sessionId: session?.id || result?.sessionId, commit: source?.commit || '', status, detail: result?.detail || (status === 'interrupted' ? 'Cleanup is not confirmed. Inspect the workspace before another run.' : status === 'failed' ? 'Repository checks failed. See the private run log.' : ''),
    modelCalls: result ? result.modelCalls ?? null : accounting ? accounting.modelCalls ?? null : request.workflowId || request.propose ? null : 0, createdAt: request.createdAt, stages, patchBytes: fs.existsSync(patch) ? fs.statSync(patch).size : 0 };
}
async function assertSource(request: Request): Promise<void> {
  if (!request.workflowId) return;
  try { const current = await readDiscovery(request.workflowId, new AbortController().signal); if (current.revision !== request.revision || current.locationKey !== request.location) throw Error('Changed'); }
  catch { throw new HttpError(409, 'Workflow source changed or is unavailable. Check history access in Settings.'); }
}
export async function readWorkspaces(): Promise<WorkspacePage> {
  const settings = config(), runs: WorkspaceRun[] = [], checked = new Map<string, boolean>();
  if (settings.available) for (const request of requests().filter(r => r.location === settings.location!.key).slice(0, 10)) {
    const key = `${request.workflowId}/${request.revision}/${request.location}`;
    if (!checked.has(key)) { try { await assertSource(request); checked.set(key, true); } catch { checked.set(key, false); } }
    if (checked.get(key)) runs.push(view(request));
  }
  return { available: settings.available, agentAvailable: settings.agentAvailable, locationKey: settings.location?.key || '', repository: settings.available ? settings.repository : '', runs };
}
export async function workspaceLog(id: string): Promise<{ text: string }> {
  if (!validId(id)) throw new HttpError(400, 'Invalid workspace run ID.');
  const settings = config(), item = requests().find(r => r.id === id && r.location === settings.location?.key);
  if (!settings.available || !item) throw new HttpError(404, 'Workspace log unavailable.');
  await assertSource(item);
  const file = path.join(root(), id, 'work/events.jsonl'); let text = '';
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try { const event = JSON.parse(line); if (event.type === 'stage-result') text = (text + `\n${event.name} — exit ${event.code}\n${event.stdout || ''}${event.stderr || ''}`).slice(-64000); }
    catch { /* Last record may still be being written. */ }
  }
  const agent = read<{summary?: string; detail?: string}>(path.join(root(), id, 'work/agent/result.json'));
  const enriched = read<{guidance: unknown; requirements: string[]}>(path.join(root(), id, 'work/agent/enrichment.json'));
  if (enriched) text += '\nEnriched workflow (Draken additions, not historical observations):\n' + JSON.stringify({ guidance: enriched.guidance, requirements: enriched.requirements }, null, 2);
  if (agent) text += '\nAgent: ' + (agent.summary || agent.detail || 'No final summary');
  if (!text) text = view(item).detail || 'No completed command output yet.';
  return { text: text.slice(-64000) };
}
export async function startWorkspace(body: unknown, token = ''): Promise<WorkspaceRun> {
  const input = body as { requestId?: unknown; ref?: unknown; workflowId?: unknown; task?: unknown } | null;
  if (!input || !validId(input.requestId) || typeof input.ref !== 'string' || !input.ref || input.ref.startsWith('-') || input.ref.length > 200 || /[\0\r\n]/.test(input.ref) || Object.keys(input).some(key => !['requestId', 'ref', 'workflowId', 'task'].includes(key))) throw new HttpError(400, 'Provide a commit or branch and a run request ID.');
  if (starting || stopping) throw new HttpError(409, 'Workspace execution is busy.');
  if (typeof input.workflowId !== 'string' || !/^[a-f0-9]{64}$/.test(input.workflowId) || typeof input.task !== 'string' || !input.task.trim() || input.task.length > 4000) throw new HttpError(400, 'Provide a workflow and a concrete task.');
  starting = true; let release: (() => void) | undefined;
  try {
    const settings = config(); if (!settings.available) throw new HttpError(409, 'Repository workspace is not configured or is unavailable.');
    if (!settings.agentAvailable || !token) throw new HttpError(409, 'An authenticated session and configured Factory Pi agent are required.');
    const discovery = await readDiscovery(input.workflowId, new AbortController().signal);
    if (discovery.locationKey !== settings.location!.key) throw new HttpError(409, 'Workflow belongs to a different repository.');
    const plan = sessionPlan(discovery, input.task, settings.location!.key);
    const existing = requests(), prior = existing.find(r => r.id === input.requestId);
    if (prior) {
      if (prior.ref !== input.ref || prior.location !== settings.location!.key || prior.workflowId !== input.workflowId || prior.task !== plan.task || prior.revision !== plan.workflow.revision) throw new HttpError(409, 'Run request ID already used.');
      return view(prior);
    }
    if (jobs.size || existing.some(r => ['running', 'interrupted'].includes(view(r).status))) throw new HttpError(409, 'A workspace is running or needs cleanup.');
    release = claimFactoryExecution(input.requestId);
    fs.mkdirSync(root(), { recursive: true, mode: 0o700 }); const dir = path.join(root(), input.requestId); fs.mkdirSync(dir, { mode: 0o700 });
    const request: Request = { id: input.requestId, ref: input.ref, location: settings.location!.key, createdAt: new Date().toISOString(), workflowId: plan.workflow.id, revision: plan.workflow.revision, task: plan.task }; save(path.join(dir, 'request.json'), request);
    const host = process.env.DRAKEN_HOST || '127.0.0.1', address = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host;
    save(path.join(dir, 'brief.json'), { plan, authorization: { kind: 'discovery', origin: `http://${address.includes(':') ? `[${address}]` : address}:${process.env.DRAKEN_PORT || 40333}` } });
    const log = fs.openSync(path.join(dir, 'run.log'), 'wx', 0o600);
    const child = spawn(process.execPath, [entry, settings.repository, input.ref, path.join(dir, 'work'), path.join(dir, 'brief.json')], { cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, DRAKEN_WORKSPACE_LOCATION_KEY: request.location, DRAKEN_FACTORY_TOKEN: token }, stdio: ['ignore', log, log] }); fs.closeSync(log);
    let cancelled = false; const releaseRun = release; release = undefined;
    const stopped = new Promise<void>(resolve => {
      const done = (code: number | null) => { try { if (!fs.existsSync(path.join(dir, 'exit.json'))) save(path.join(dir, 'exit.json'), { code, cancelled }); } catch { console.error('Workspace exit could not be recorded.'); } jobs.delete(request.id); releaseRun?.(); resolve(); };
      child.once('error', () => done(1)); child.once('close', done);
    });
    jobs.set(request.id, { stopped, cancel: () => { cancelled = true; child.kill('SIGTERM'); } });
    return view(request);
  } finally { release?.(); starting = false; }
}
export function cancelWorkspace(id: string): void {
  if (!validId(id)) throw new HttpError(400, 'Invalid workspace run ID.');
  const job = jobs.get(id); if (!job) throw new HttpError(409, 'Workspace is no longer running.'); job.cancel();
}
export async function stopWorkspaces(): Promise<void> { stopping = true; for (const job of jobs.values()) job.cancel(); await Promise.all([...jobs.values()].map(job => job.stopped)); }
