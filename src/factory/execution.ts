import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { getDataDir } from '../data-dir';
import { HttpError } from '../errors';
import { claimFactoryExecution } from './execution-owner';
import { readDiscovery as readSourceDiscovery } from './enrichment';
import type { Enrichment } from '../factory-enrichment';
import type { FactoryExecution, FactoryRun } from './execution-types';

// Explicit operator profile. Browser requests cannot supply images, commands, sockets or paths.
const entry = path.resolve(__dirname, '../../scripts/factory-release-example.cjs');
const active = new Map<string, { child: ChildProcess; stopped: Promise<void> }>();
let starting = false, stopping = false;
interface Saved { id: string; version: string; createdAt: string; proposalId: string; revision: string; regenerate: boolean }
const root = () => path.join(getDataDir(), 'factory-runs');
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id);
function json<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function save(file: string, value: unknown) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
async function readDiscovery(id: string, signal: AbortSignal) {
  try { return await readSourceDiscovery(id, signal); }
  catch { signal.throwIfAborted(); throw new HttpError(409, 'Workflow source is unavailable. Check its repository and history access in Settings.'); }
}
function config() {
  const proposalId = process.env.DRAKEN_FACTORY_PROPOSAL_ID || null;
  const available = process.platform !== 'win32' && !!proposalId && !!process.env.DRAKEN_DOCKER_BIN && !!process.env.DRAKEN_DOCKER_HOST
    && !!process.env.DRAKEN_FACTORY_IMAGE && !!process.env.DRAKEN_PI_BIN && fs.existsSync(entry);
  return { proposalId, available, reason: available ? '' : 'Docker execution is not configured for this checkout.' };
}
function saved(): Saved[] {
  if (!fs.existsSync(root())) return [];
  return fs.readdirSync(root()).filter(validId).map(id => json<Saved>(path.join(root(), id, 'request.json'))).filter((x): x is Saved => !!x)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function view(item: Saved): FactoryRun {
  const dir = path.join(root(), item.id), work = path.join(dir, 'work');
  const result = json<{ status: FactoryRun['status']; detail: string; modelCalls: number }>(path.join(work, 'result.json'));
  const failure = json<{ message: string }>(path.join(work, 'failure.json'));
  const exit = json<{ code: number | null; cancelled: boolean }>(path.join(dir, 'exit.json'));
  const model = json<{ receipt: { invocations: number } }>(path.join(work, 'model-response.json'));
  const steps: FactoryRun['steps'] = [];
  const events = path.join(work, 'events.jsonl');
  if (fs.existsSync(events)) for (const line of fs.readFileSync(events, 'utf8').split('\n').filter(Boolean)) {
    let event: { type: string; capability?: string; outcome?: { ok: boolean } };
    try { event = JSON.parse(line); } catch { continue; } // A writer may still be finishing the last line.
    if (event.type === 'requested' && event.capability) steps.push({ capability: event.capability, status: 'running' });
    if (event.type === 'result' && event.capability) {
      const step = [...steps].reverse().find(s => s.capability === event.capability);
      if (step) step.status = event.outcome?.ok ? 'passed' : 'failed';
    }
  }
  // A result is written only after Docker cleanup. A lost controller never means success.
  const cleaned = json<{ completed: boolean }>(path.join(work, 'cleanup.json'))?.completed;
  const status = result?.status || (active.has(item.id) ? 'running' : exit && (cleaned || !steps.length) ? exit.cancelled ? 'cancelled' : 'failed' : 'interrupted');
  if (status !== 'running') for (const step of steps) if (step.status === 'running') step.status = status === 'cancelled' ? 'cancelled' : 'unverified';
  return { id: item.id, version: item.version, createdAt: item.createdAt, status,
    phase: steps.find(s => s.status === 'running')?.capability || (steps.length ? 'Finalizing' : item.regenerate ? 'Enriching workflow' : 'Checking saved plan'),
    detail: result?.detail || failure?.message || (status === 'interrupted' ? 'Run interrupted. Inspect Docker resources before starting another run.' : status === 'failed' ? 'Run failed. See its local run log.' : ''),
    modelCalls: result?.modelCalls ?? model?.receipt.invocations ?? (item.regenerate ? null : 0), reused: !item.regenerate, steps };
}
function planDirectory(items: Saved[]): string | undefined {
  for (const item of items) {
    const dir = path.join(root(), item.id, 'work');
    if (fs.existsSync(path.join(dir, 'enrichment.json')) && fs.existsSync(path.join(dir, 'model-response.json'))) return dir;
  }
  return process.env.DRAKEN_FACTORY_PLAN_DIR || undefined;
}
export async function readExecution(signal: AbortSignal): Promise<FactoryExecution> {
  const settings = config();
  if (!settings.available || !settings.proposalId) return { ...settings, hasPlan: false, bindings: [], runs: [] };
  const discovery = await readDiscovery(settings.proposalId, signal);
  const items = saved().filter(item => item.proposalId === discovery.id);
  const runs = items.filter(item => item.revision === discovery.revision).slice(0, 10).map(view);
  signal.throwIfAborted();
  const directory = planDirectory(items.filter(item => item.revision === discovery.revision));
  const plan = directory ? json<Enrichment>(path.join(directory, 'enrichment.json')) : undefined;
  const current = plan?.ready && plan.discovery.revision === discovery.revision && plan.discovery.id === discovery.id
    && plan.capabilities.every(capability => capability.revision === process.env.DRAKEN_FACTORY_IMAGE);
  return { ...settings, hasPlan: !!current, bindings: current ? plan.configuration.bindings.map(({ step, action, verify }) => ({ step, action, verify })) : [], runs };
}
export async function startExecution(body: unknown, token: string, signal: AbortSignal): Promise<FactoryRun> {
  const input = body as { requestId?: unknown; version?: unknown; regenerate?: unknown } | null;
  if (!input || !validId(input.requestId) || typeof input.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(input.version)
    || input.version.length > 40 || typeof input.regenerate !== 'boolean') throw new HttpError(400, 'A release version and run request ID are required.');
  if (starting || stopping) throw new HttpError(409, 'Factory execution is busy.');
  starting = true; let release: (() => void) | undefined;
  try {
    const settings = config();
    if (!settings.available || !settings.proposalId) throw new HttpError(409, settings.reason);
    if (!token) throw new HttpError(409, 'Factory execution requires an authenticated session.');
    const discovery = await readDiscovery(settings.proposalId, signal);
    const items = saved(), previous = items.find(item => item.id === input.requestId);
    if (previous) {
      if (previous.version !== input.version || previous.regenerate !== input.regenerate || previous.revision !== discovery.revision) throw new HttpError(409, 'Run request ID already used.');
      return view(previous);
    }
    if (active.size || items.some(item => ['running', 'interrupted'].includes(view(item).status))) throw new HttpError(409, 'A run is active or needs cleanup.');
    const reuse = input.regenerate ? undefined : planDirectory(items.filter(item => item.revision === discovery.revision && item.proposalId === discovery.id));
    if (!input.regenerate && !reuse) throw new HttpError(409, 'Generate a plan before running this workflow.');
    signal.throwIfAborted();
    release = claimFactoryExecution(input.requestId);
    fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
    const dir = path.join(root(), input.requestId); fs.mkdirSync(dir, { mode: 0o700 });
    const item: Saved = { id: input.requestId, version: input.version, regenerate: input.regenerate, createdAt: new Date().toISOString(), proposalId: discovery.id, revision: discovery.revision };
    save(path.join(dir, 'request.json'), item);
    const host = process.env.DRAKEN_HOST || '127.0.0.1', address = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host;
    const base = `http://${address.includes(':') ? `[${address}]` : address}:${process.env.DRAKEN_PORT || 40333}`;
    const log = fs.openSync(path.join(dir, 'run.log'), 'wx', 0o600);
    const child = spawn(process.execPath, [entry, base, discovery.id, item.version, path.join(dir, 'work'), ...(reuse ? [reuse] : [])], {
      cwd: path.resolve(__dirname, '../..'), env: { ...process.env, DRAKEN_FACTORY_TOKEN: token }, stdio: ['ignore', log, log], windowsHide: true,
    });
    fs.closeSync(log);
    let cancelled = false; const releaseRun = release; release = undefined;
    const stopped = new Promise<void>(resolve => {
      const finish = (code: number | null) => {
        try { if (!fs.existsSync(path.join(dir, 'exit.json'))) save(path.join(dir, 'exit.json'), { code, cancelled }); }
        catch { console.error('Factory could not save process exit state; inspect the private run directory.'); }
        active.delete(item.id); releaseRun?.(); resolve();
      };
      child.once('error', () => finish(1)); child.once('close', finish);
    });
    child.on('kill-requested', () => { cancelled = true; });
    active.set(item.id, { child, stopped });
    return view(item);
  } finally { release?.(); starting = false; }
}
export async function cancelExecution(id: string): Promise<void> {
  if (!validId(id)) throw new HttpError(400, 'Invalid run ID.');
  const run = active.get(id);
  if (!run) throw new HttpError(409, 'This run is no longer active.');
  run.child.emit('kill-requested'); run.child.kill('SIGTERM');
}
export async function stopFactoryExecution(): Promise<void> {
  stopping = true;
  for (const run of active.values()) { run.child.emit('kill-requested'); run.child.kill('SIGTERM'); }
  await Promise.all([...active.values()].map(run => run.stopped));
}
