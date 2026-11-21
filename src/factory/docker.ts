/** Host-selected isolation. Repository/model input cannot add mounts or Docker flags. */
export function dockerIsolation(name: string, network: string, run: string): string[] {
  return ['--name', name, '--label', `draken.factory.run=${run}`, '--read-only', '--user', '65532:65532', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--pids-limit=512', '--memory=4096m',
    '--memory-swap=4096m', '--cpus=2',
    '--log-driver=json-file', '--log-opt', 'max-size=8m', '--log-opt', 'max-file=1', '--ulimit', 'nofile=1024:1024',
    '--network', network, '--ipc=private', '--init', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1024m',
    '--env', 'HOME=/tmp/home', '--env', 'DRAKEN_DATA_DIR=/tmp/data', '--env', 'DRAKEN_PI_SESSIONS_DIR=/tmp/no-sessions'];
}
export function assertDockerHost(info: { SecurityOptions?: string[]; MemoryLimit?: boolean; PidsLimit?: boolean; CpuCfsQuota?: boolean }, host: string, image: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(image) || !host.startsWith('unix:///')) throw Error('A pinned image ID and local Docker socket are required');
  if (!info.SecurityOptions?.includes('name=rootless') || !info.SecurityOptions?.includes('name=seccomp,profile=builtin')
    || !info.MemoryLimit || !info.PidsLimit || !info.CpuCfsQuota) throw Error('Rootless Docker with seccomp and CPU/memory/PID enforcement is required');
}
