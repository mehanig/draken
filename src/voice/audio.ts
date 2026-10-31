import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getDataDir } from '../db/schema';
import { HttpError } from '../sync/store';

interface AudioResult { text?: string; audio?: string; duration?: number; elapsed_ms: number }
interface Job {
  id: number; payload: Record<string, unknown>; resolve: (value: AudioResult) => void; reject: (error: Error) => void;
  aborted: boolean; cleanup: () => void;
}
export function audioConfig() {
  const dir = process.env.DRAKEN_VOICE_DATA_DIR || path.join(getDataDir(), 'voice');
  const python = process.env.DRAKEN_VOICE_PYTHON || path.join(dir, 'venv/bin/python');
  const worker = process.env.DRAKEN_VOICE_WORKER || path.join(__dirname, '../../voice/worker.py');
  const installed = fs.existsSync(python) && fs.existsSync(worker) && (Boolean(process.env.DRAKEN_VOICE_WORKER) ||
    ['kokoro-v1.0.int8.onnx', 'voices-v1.0.bin', 'whisper-base.en/model.bin', 'whisper-base.en/tokenizer.json']
      .every(file => fs.existsSync(path.join(dir, 'models', file))));
  return { dir, python, worker, installed };
}

/** One warm CPU worker, bounded queue, no files containing microphone audio. */
class LocalAudio {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private rejectStart?: (error: Error) => void;
  private ready = false;
  private queue: Job[] = [];
  private active?: Job;
  private sequence = 0;
  private timer?: NodeJS.Timeout;
  private lastError = '';

  status() { return { installed: audioConfig().installed, state: this.ready ? 'ready' : this.starting ? 'loading' : this.lastError ? 'error' : 'cold', error: this.lastError }; }
  async warm(): Promise<void> {
    if (this.ready) return;
    if (this.starting) return this.starting;
    const config = audioConfig();
    if (!config.installed) throw new HttpError(503, 'Local audio is not installed. Run npm run voice:setup on the Draken server.');
    this.lastError = '';
    this.starting = new Promise<void>((resolve, reject) => {
      this.rejectStart = reject;
      const child = spawn(config.python, [config.worker], {
        cwd: getDataDir(), stdio: ['pipe', 'pipe', 'pipe'], shell: false,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', PYTHONUNBUFFERED: '1',
          HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', DRAKEN_VOICE_DATA_DIR: config.dir,
          DRAKEN_VOICE_THREADS: process.env.DRAKEN_VOICE_THREADS || '4', DRAKEN_VOICE_SPEAKER: process.env.DRAKEN_VOICE_SPEAKER || 'af_heart' },
      });
      this.child = child;
      let buffer = '';
      this.timer = setTimeout(() => this.stop('Local audio startup timed out. Try the call again.'), 90000);
      this.timer.unref();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (data: string) => {
        if (this.child !== child) return;
        buffer += data;
        if (buffer.length > 8_000_000) return this.stop('Local audio returned too much data.');
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          let event: any;
          try { event = JSON.parse(line); } catch { this.stop('Local audio returned an invalid response.'); return; }
          if (event.type === 'ready') {
            clearTimeout(this.timer); this.ready = true; this.starting = undefined; this.rejectStart = undefined; resolve(); this.pump();
          } else if (event.type === 'error') this.stop('Local audio could not load its models. Run npm run voice:setup and retry.');
          else if (this.active && event.id === this.active.id) {
            clearTimeout(this.timer);
            const job = this.active; this.active = undefined; job.cleanup();
            if (!job.aborted) event.error ? job.reject(new HttpError(502, 'Local speech processing failed. Please try a shorter turn.')) : job.resolve(event);
            this.pump();
          }
        }
      });
      // Drain diagnostics without storing potentially sensitive third-party messages.
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => { if (this.child === child) this.stop('The local audio worker disconnected. Try the call again.'); });
      child.on('error', () => { if (this.child === child) this.stop('Could not start local audio. Check the Python runtime.'); });
      child.on('exit', () => { if (this.child === child) this.stop('Local audio stopped. Try the call again.'); });
    });
    return this.starting;
  }

  private pump() {
    if (!this.ready || this.active || !this.child) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    this.timer = setTimeout(() => this.stop('Local speech processing timed out. Try a shorter turn.'), 45000);
    this.timer.unref();
    this.child.stdin.write(JSON.stringify({ id: job.id, ...job.payload }) + '\n');
  }

  async request(payload: Record<string, unknown>, signal?: AbortSignal): Promise<AudioResult> {
    if (signal?.aborted) throw new HttpError(409, 'Audio request cancelled');
    await this.warm();
    if (signal?.aborted) throw new HttpError(409, 'Audio request cancelled');
    if (this.queue.length >= 4) throw new HttpError(429, 'Local audio is busy. Please wait a moment.');
    return new Promise((resolve, reject) => {
      const job: Job = { id: ++this.sequence, payload, resolve, reject, aborted: false, cleanup: () => signal?.removeEventListener('abort', abort) };
      const abort = () => {
        job.aborted = true; this.queue = this.queue.filter(item => item !== job); job.cleanup();
        reject(new HttpError(409, 'Audio request cancelled'));
        // Native inference finishes locally; its late result is discarded. It never starts pi.
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (payload.op === 'transcribe') this.queue.unshift(job); else this.queue.push(job);
      this.pump();
    });
  }

  stop(reason = 'Local audio stopped') {
    const child = this.child; this.child = undefined; this.ready = false;
    clearTimeout(this.timer);
    const error = new HttpError(503, reason);
    this.lastError = reason; this.rejectStart?.(error); this.starting = undefined; this.rejectStart = undefined;
    for (const job of [...this.queue, ...(this.active ? [this.active] : [])]) { job.cleanup(); job.reject(error); }
    this.queue = []; this.active = undefined;
    if (child) {
      child.kill('SIGTERM');
      const kill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1500); kill.unref();
    }
  }
}
export const localAudio = new LocalAudio();
