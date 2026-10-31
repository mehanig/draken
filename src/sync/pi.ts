import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getDataDir } from '../db/schema';
import { cleanText } from './normalize';
import { HttpError } from './store';
import { PiTextStream } from './pi-stream';

export interface PiRequest {
  system: string;
  model?: string;
  signal?: AbortSignal;
  thinking?: 'off' | 'low' | 'medium';
  timeoutMs?: number;
  onText?: (delta: string) => void;
  /** Use pi's JSON event protocol without exposing deltas; does not constrain model formatting. */
  jsonOutput?: boolean;
}

const children = new Set<ChildProcess>();
export function stopManagerProcesses(): void {
  for (const child of children) child.kill('SIGTERM');
}

/** One tool-free invocation. Prompts travel on stdin, never through a shell or argv. */
export async function invokePi(prompt: string, request: PiRequest): Promise<string> {
  if (request.signal?.aborted) throw new HttpError(409, 'Generation cancelled');
  if (prompt.length > 300000) throw new HttpError(400, 'Model input exceeds the safety limit; no evidence was marked covered.');
  const cwd = path.join(getDataDir(), 'manager');
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const args = [
    ...(request.onText || request.jsonOutput ? ['--mode', 'json'] : ['--print']), '--no-session', '--no-tools', '--no-extensions', '--no-mcp', '--no-skills',
    '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--offline',
    '--thinking', request.thinking || 'low', '--system-prompt', request.system,
  ];
  if (request.model) args.push('--model', request.model);
  const env = { ...process.env };
  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.DRAKEN_PI_BIN || 'pi', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    children.add(child);
    let stdout = '';
    const stream = request.onText || request.jsonOutput ? new PiTextStream(request.onText) : undefined;
    let stderr = '';
    let failure = '';
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = (message: string) => {
      if (failure) return;
      failure = message;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
      killTimer.unref();
    };
    const abort = () => terminate(stream ? 'Voice reply interrupted. Only confirmed playback is retained.' : 'Generation cancelled. Completed summaries were cached; coverage did not advance.');
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    const configured = Number(request.timeoutMs ?? process.env.DRAKEN_PI_TIMEOUT_MS ?? 180000);
    const timeout = setTimeout(() => terminate(stream ? 'The voice reply timed out. You can ask again.' : 'pi timed out. Retry to reuse completed summaries.'),
      Number.isFinite(configured) ? Math.max(1000, Math.min(configured, 600000)) : 180000);
    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      request.signal?.removeEventListener('abort', abort);
      children.delete(child);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (failure) return;
      if (stream) {
        try { stream.feed(chunk); } catch (error) { terminate(cleanText(error instanceof Error ? error.message : 'Invalid pi event stream', 500)); }
      } else {
        if (stdout.length + chunk.length > 64000) return terminate('pi produced too much output. No incomplete result was saved.');
        stdout += chunk;
      }
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => {
      cleanup();
      reject(new HttpError(502, `Cannot start pi. Install pi 1.4+ or set DRAKEN_PI_BIN. ${error.message}`));
    });
    child.on('close', code => {
      cleanup();
      if (failure) return reject(new HttpError(502, failure));
      if (code !== 0) return reject(new HttpError(502, `pi failed (${code ?? 'signal'}). ${cleanText(stderr, 1500) || 'Check model access and pi login.'}`));
      if (stream) {
        try { stdout = stream.finish(); } catch (error) { return reject(new HttpError(502, error instanceof Error ? error.message : 'Incomplete pi event stream')); }
      }
      if (!stdout.trim()) return reject(new HttpError(502, 'pi returned no response. Coverage did not advance.'));
      resolve(stdout.trim());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}
