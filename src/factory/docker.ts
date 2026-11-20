import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Invocation, Outcome } from '../factory-enrichment';

interface DockerStage {
  dependencies: string[];
  output: boolean;
  networkHosts: string[];
}
interface DockerOptions {
  binary: string;
  host: string;
  image: string;
  stages: Record<string, DockerStage>;
  record(value: unknown): Promise<void>;
}

export function dockerIsolation(name: string, network: string, run: string, engineering = false): string[] {
  return ['--name', name, '--label', `draken.factory.run=${run}`, '--read-only', '--user', '65532:65532', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', `--pids-limit=${engineering ? 512 : 128}`, `--memory=${engineering ? 4096 : 768}m`,
    `--memory-swap=${engineering ? 4096 : 768}m`, `--cpus=${engineering ? 2 : 1}`,
    '--log-driver=json-file', '--log-opt', 'max-size=8m', '--log-opt', 'max-file=1', '--ulimit', engineering ? 'nofile=1024:1024' : 'nofile=256:256',
    '--network', network, '--ipc=private', '--init', '--tmpfs', engineering ? '/tmp:rw,nosuid,nodev,size=1024m' : '/tmp:rw,nosuid,nodev,noexec,size=256m',
    '--env', 'HOME=/tmp/home', '--env', 'DRAKEN_DATA_DIR=/tmp/data', '--env', 'DRAKEN_PI_SESSIONS_DIR=/tmp/no-sessions'];
}

/** Every capability, including checks, gets a fresh unprivileged container. No host-command fallback. */
export class DockerExecutor {
  private readonly prefix = `draken-factory-${randomUUID()}`;
  private readonly volumes = new Map<string, string>();
  private readonly resources: { containers: Set<string>; networks: Set<string>; volumes: Set<string> } = { containers: new Set(), networks: new Set(), volumes: new Set() };
  constructor(private readonly options: DockerOptions) {
    this.options = { ...options, stages: structuredClone(options.stages) };
    if (!/^sha256:[a-f0-9]{64}$/.test(options.image) || !options.host.startsWith('unix:///')) throw Error('A pinned image ID and local Docker socket are required');
    for (const [id, spec] of Object.entries(options.stages)) {
      if (!/^[a-z][a-z0-9-]{0,60}$/.test(id) || !Array.isArray(spec.dependencies) || spec.dependencies.some(dep => !/^[a-z][a-z0-9-]{0,60}$/.test(dep))
        || spec.networkHosts.some(host => !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host))) throw Error('Invalid registered Docker stage');
    }
  }
  private command(args: string[], input = '', signal?: AbortSignal, timeoutMs = 120000): Promise<string> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.binary, ['--host', this.options.host, ...args], { shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } });
      let stdout = '', stderr = '', failed = false;
      const stop = () => { failed = true; child.kill('SIGKILL'); };
      const timer = setTimeout(stop, timeoutMs);
      // Finish short create/remove operations before cleanup so cancellation cannot orphan
      // a resource whose server-side creation is still in flight. Attached workers are killed immediately.
      const interruptible = args[0] === 'start' && args.includes('--attach');
      if (interruptible) signal?.addEventListener('abort', stop, { once: true });
      if (interruptible && signal?.aborted) stop();
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 4_000_000) stop(); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
      child.stdin.on('error', () => {}); child.stdin.end(input);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
      child.once('error', error => { cleanup(); reject(error); });
      child.once('close', code => { cleanup(); if (failed || code !== 0) reject(Error(`Docker ${args[0]} failed${failed ? ' or was cancelled' : ` (${code})`}: ${stderr}`)); else resolve(stdout.trim()); });
    });
  }
  async check(signal: AbortSignal): Promise<void> {
    const info = JSON.parse(await this.command(['info', '--format', '{{json .}}'], '', signal));
    if (!info.SecurityOptions?.includes('name=rootless') || !info.SecurityOptions?.includes('name=seccomp,profile=builtin')
      || !info.MemoryLimit || !info.PidsLimit || !info.CpuCfsQuota) throw Error('Rootless Docker with seccomp and CPU/memory/PID enforcement is required');
    await this.command(['image', 'inspect', this.options.image], '', signal);
  }
  private isolation(name: string, network: string): string[] {
    return dockerIsolation(name, network, this.prefix);
  }
  async invoke(id: string, invocation: Invocation, signal: AbortSignal): Promise<Outcome> {
    signal.throwIfAborted();
    const stage = Object.hasOwn(this.options.stages, id) ? this.options.stages[id] : undefined; if (!stage) throw Error('Unregistered container capability');
    const suffix = randomUUID(), name = `${this.prefix}-${id}-${suffix}`, proxy = `${name}-egress`, network = `${name}-network`;
    let output: string | undefined;
    const inputs: string[] = [];
    for (const dependency of stage.dependencies) {
      const volume = this.volumes.get(dependency); if (!volume) throw Error(`Required artifact is missing: ${dependency}`);
      inputs.push('--mount', `type=volume,src=${volume},dst=/inputs/${dependency},readonly`);
    }
    await this.check(signal);
    try {
      if (stage.networkHosts.length) {
        this.resources.networks.add(network); await this.command(['network', 'create', '--internal', network], '', signal);
        this.resources.containers.add(proxy);
        await this.command(['create', ...this.isolation(proxy, 'bridge'), '--env', `ALLOWED_HOSTS=${stage.networkHosts.join(',')}`,
          this.options.image, 'node', '/factory/proxy.cjs'], '', signal);
        await this.command(['network', 'connect', '--alias', 'egress', network, proxy], '', signal);
        await this.command(['start', proxy], '', signal);
        let ready = false;
        for (let i = 0; i < 30; i++) {
          if ((await this.command(['logs', proxy], '', signal)).includes('proxy-ready')) { ready = true; break; }
          await new Promise(resolve => setTimeout(resolve, 100)); signal.throwIfAborted();
        }
        if (!ready) throw Error('Container egress proxy did not start');
      }
      const args = ['create', '-i', ...this.isolation(name, stage.networkHosts.length ? network : 'none'), ...inputs];
      if (stage.output) {
        output = `${name}-artifacts`; this.resources.volumes.add(output);
        await this.command(['volume', 'create', output], '', signal);
        args.push('--mount', `type=volume,src=${output},dst=/out`);
      }
      if (stage.networkHosts.length) args.push('--env', 'npm_config_registry=http://egress:8080/npm/');
      args.push(this.options.image, 'node', '/factory/stage.cjs');
      this.resources.containers.add(name); await this.command(args, '', signal);
      // Record effective isolation, not just the requested flags, before starting the worker.
      const inspection = JSON.parse(await this.command(['inspect', name], '', signal))[0];
      await this.options.record({ type: 'container-created', capability: id, name, image: inspection.Image,
        user: inspection.Config.User, security: inspection.HostConfig, mounts: inspection.Mounts, networkHosts: stage.networkHosts });
      const raw = await this.command(['start', '--attach', '--interactive', name], JSON.stringify({ capability: id, invocation }), signal, 240000);
      const state = JSON.parse(await this.command(['inspect', '--format', '{{json .State}}', name], '', signal));
      if (state.ExitCode !== 0 || state.OOMKilled) throw Error('Container exited unsuccessfully');
      const result = JSON.parse(raw) as { outcome: Outcome; receipt?: unknown };
      if (!result.outcome || typeof result.outcome.ok !== 'boolean') throw Error('Invalid container result');
      await this.options.record({ type: 'container-result', capability: id, name, state, receipt: result.receipt, outcome: result.outcome });
      // Promote an artifact only after the worker completed. Older artifacts are never mounted writable.
      if (result.outcome.ok && output) this.volumes.set(id, output);
      return result.outcome;
    } finally {
      // Killing the CLI is NOT enough: remove the owned container to stop all child processes.
      for (const container of [name, proxy]) if (this.resources.containers.has(container)) {
        try { await this.command(['rm', '--force', container]); }
        catch (error) { if (!(error instanceof Error) || !error.message.includes('No such container')) throw error; }
        this.resources.containers.delete(container);
      }
      if (this.resources.networks.has(network)) {
        try { await this.command(['network', 'rm', network]); }
        catch (error) { if (!(error instanceof Error) || !/not found|No such network/.test(error.message)) throw error; }
        this.resources.networks.delete(network);
      }
    }
  }
  async dispose(): Promise<void> {
    const errors: unknown[] = [];
    for (const [kind, names] of [['container', this.resources.containers], ['network', this.resources.networks], ['volume', this.resources.volumes]] as const) {
      for (const name of names) try { await this.command(kind === 'container' ? ['rm', '--force', name] : [kind, 'rm', name]); names.delete(name); } catch (error) { if (error instanceof Error && /No such container|No such volume|No such network|network .* not found/.test(error.message)) names.delete(name); else errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Docker cleanup failed; owned resources need attention');
  }
}
