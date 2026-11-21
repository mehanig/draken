/** Host-selected isolation. Repository/model input cannot add mounts or Docker flags. */
export function dockerIsolation(name: string, network: string, run: string, engineering = false): string[] {
  return ['--name', name, '--label', `draken.factory.run=${run}`, '--read-only', '--user', '65532:65532', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', `--pids-limit=${engineering ? 512 : 128}`, `--memory=${engineering ? 4096 : 768}m`,
    `--memory-swap=${engineering ? 4096 : 768}m`, `--cpus=${engineering ? 2 : 1}`,
    '--log-driver=json-file', '--log-opt', 'max-size=8m', '--log-opt', 'max-file=1', '--ulimit', engineering ? 'nofile=1024:1024' : 'nofile=256:256',
    '--network', network, '--ipc=private', '--init', '--tmpfs', engineering ? '/tmp:rw,exec,nosuid,nodev,size=1024m' : '/tmp:rw,nosuid,nodev,noexec,size=256m',
    '--env', 'HOME=/tmp/home', '--env', 'DRAKEN_DATA_DIR=/tmp/data', '--env', 'DRAKEN_PI_SESSIONS_DIR=/tmp/no-sessions'];
}
export function assertDockerHost(info: { SecurityOptions?: string[]; MemoryLimit?: boolean; PidsLimit?: boolean; CpuCfsQuota?: boolean }, host: string, image: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(image) || !host.startsWith('unix:///')) throw Error('A pinned image ID and local Docker socket are required');
  if (!info.SecurityOptions?.includes('name=rootless') || !info.SecurityOptions?.includes('name=seccomp,profile=builtin')
    || !info.MemoryLimit || !info.PidsLimit || !info.CpuCfsQuota) throw Error('Rootless Docker with seccomp and CPU/memory/PID enforcement is required');
}
