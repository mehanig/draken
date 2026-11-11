import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getDataDir } from '../data-dir';
import { cleanText } from './normalize';
import { HttpError } from '../errors';
import { isBatchSummaryModel, LUNA_BATCH, promptTokens } from './summary-budget';
import { PiOutput } from './pi-output';
import type { PiAccounting } from '../types';
import { isolatedFlags, selectedPi } from '../pi/runtime';

export interface PiRequest {
  system: string;
  model?: string;
  signal?: AbortSignal;
  thinking?: 'off' | 'low' | 'medium';
  timeoutMs?: number;
  largeSummary?: boolean;
  onAccounting?(accounting: PiAccounting): void;
}

const children = new Map<ChildProcess, { stop(): void; done: Promise<void> }>();
let stopping = false;
export async function stopManagerProcesses(): Promise<void> {
  stopping = true;
  const owned = [...children.values()];
  for (const child of owned) child.stop();
  await Promise.all(owned.map(child => child.done));
}

/** One tool-free invocation, without a shell. The user payload uses stdin;
 * the fixed system prompt is a CLI argument. */
export async function invokePi(prompt: string, request: PiRequest): Promise<string> {
  if (stopping) throw new HttpError(503, 'Draken is stopping. No new model work can start.');
  if (request.signal?.aborted) throw new HttpError(409, 'Generation cancelled');
  const large = request.largeSummary === true;
  if (large && !isBatchSummaryModel(request.model)) throw new HttpError(400, 'Large summary requests require the configured Luna model.');
  if (large ? Buffer.byteLength(prompt) + Buffer.byteLength(request.system) > LUNA_BATCH.requestBytes : prompt.length > 300000) {
    throw new HttpError(400, 'Model input exceeds the safety limit; no evidence was marked covered.');
  }
  if (large && promptTokens(prompt, request.system) > LUNA_BATCH.requestTokens) throw new HttpError(400, 'Summary request exceeds its token safety budget; no evidence was marked covered.');
  const cwd = path.join(getDataDir(), 'manager');
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const args = [
    '--print', ...(request.onAccounting ? ['--mode', 'json'] : []), ...isolatedFlags,
    '--thinking', request.thinking || 'low', '--system-prompt', request.system,
  ];
  if (request.model) args.push('--model', request.model);
  let pi: ReturnType<typeof selectedPi>;
  try { pi = selectedPi(); } catch { throw new HttpError(503, 'Private pi is unavailable. Run draken setup, then draken login. No other runtime was substituted.'); }
  return new Promise((resolve, reject) => {
    const child = spawn(pi.binary, [...pi.prefix, ...args], { cwd, env: pi.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let exited!: () => void;
    const done = new Promise<void>(resolve => { exited = resolve; });
    const structured = request.onAccounting ? new PiOutput(large ? LUNA_BATCH.outputBytes : 64000, large) : undefined;
    let closed = false;
    let stdout = '';
    let outputBytes = 0;
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
    const abort = () => terminate('Generation cancelled. Completed summaries were cached; coverage did not advance.');
    children.set(child, { stop: abort, done });
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    const configured = Number(request.timeoutMs ?? process.env.DRAKEN_PI_TIMEOUT_MS ?? 180000);
    const timeout = setTimeout(() => terminate('pi timed out. Retry to reuse completed summaries.'),
      Number.isFinite(configured) ? Math.max(1000, Math.min(configured, 600000)) : 180000);
    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      request.signal?.removeEventListener('abort', abort);
      children.delete(child); exited();
    };
    const reportAccounting = (complete: boolean) => {
      try { if (structured) request.onAccounting!(structured.finish(complete)); return true; }
      catch { reject(new HttpError(502, 'Cannot retain pi usage metadata')); return false; }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (failure) return;
      if (structured) {
        try { structured.push(chunk); } catch (error) { terminate(error instanceof Error ? error.message : 'Invalid pi event stream'); }
        return;
      }
      outputBytes += Buffer.byteLength(chunk);
      if (large ? outputBytes > LUNA_BATCH.outputBytes : stdout.length + chunk.length > 64000) return terminate('pi produced too much output. No incomplete result was saved.');
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => {
      if (closed) return;
      if (child.pid) { terminate('pi process cleanup required after a process error.'); return; }
      closed = true;
      cleanup();
      if (!reportAccounting(false)) return;
      reject(new HttpError(502, `Cannot start pi. Run draken setup and draken login, or configure DRAKEN_PI_BIN with pi 1.4+. ${error.message}`));
    });
    child.on('close', code => {
      if (closed) return; closed = true;
      cleanup();
      if (!reportAccounting(code === 0 && !failure)) return;
      if (failure) return reject(new HttpError(502, failure));
      if (code !== 0) return reject(new HttpError(502, `pi failed (${code ?? 'signal'}). ${cleanText(stderr, 1500) || 'Check model access and pi login.'}`));
      if (structured) {
        try { resolve(structured.result()); } catch (error) { reject(new HttpError(502, cleanText(error instanceof Error ? error.message : 'Invalid pi response', 1500))); }
        return;
      }
      if (!stdout.trim()) return reject(new HttpError(502, 'pi returned no response. Coverage did not advance.'));
      resolve(stdout.trim());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}
