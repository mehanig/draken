import path from 'path';
import { availableParallelism } from 'os';
import { Worker } from 'worker_threads';
import { LocalEmbedder } from './model';
import type { Embedder, ReportHistory } from './types';

type Pending = { id: number; resolve(vector: Float32Array): void; reject(error: Error): void };
type Lane = { worker: Worker; pending?: Pending; dead?: boolean };
const failure = () => new Error('Local embedding worker failed; no other runtime or model was substituted');

/** At most two model copies and six kernel threads. Small/constrained machines
 * keep one lane. All lanes die with their owning history process on cancellation.
 * Workers are lazy: a warm-cache query needs only one, and a read needs none. */
export class EmbeddingPool implements Embedder {
  readonly parallelism: { workers: number; threads: number };
  private files: LocalEmbedder;
  private lanes: Lane[] = [];
  private sequence = 0;
  private busy = false;
  private epoch = 0;
  private retiring: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {
    const cpus = availableParallelism(), memory = process.availableMemory();
    const workers = cpus >= 12 && memory >= 4 * 1024 ** 3 ? 2 : 1;
    const perLane = workers === 2 ? 3 : Math.max(1, Math.min(4, Math.floor(cpus / 2)));
    this.parallelism = { workers, threads: workers * perLane };
    this.files = new LocalEmbedder(directory);
  }
  get fingerprint() { return this.files.fingerprint; }
  ready() { return this.files.ready(); }
  setup(report?: ReportHistory, allowDownload = true) { return this.files.setup(report, allowDownload); }
  private lane(index: number): Lane {
    if (this.lanes[index]) { if (this.lanes[index].dead) throw failure(); return this.lanes[index]; }
    const worker = new Worker(path.join(__dirname, 'embedding-worker.js'), {
      workerData: { directory: this.directory, threads: this.parallelism.threads / this.parallelism.workers },
      execArgv: [], env: { PATH: process.env.PATH, LANG: process.env.LANG, SYSTEMROOT: process.env.SYSTEMROOT },
      stdout: true, stderr: true,
    });
    worker.stdout.resume(); worker.stderr.resume();
    const lane: Lane = { worker }; this.lanes[index] = lane;
    const fail = () => { lane.dead = true; const pending = lane.pending; lane.pending = undefined; pending?.reject(failure()); };
    worker.on('error', fail); worker.on('exit', fail);
    worker.on('message', (message: any) => {
      const pending = lane.pending;
      if (!pending) return;
      if (message?.id !== pending.id || message.error || !(message.vector instanceof ArrayBuffer) || message.vector.byteLength !== 384 * 4) { fail(); return; }
      const vector = new Float32Array(message.vector);
      if (vector.some(value => !Number.isFinite(value))) { fail(); return; }
      lane.pending = undefined; pending.resolve(vector);
    });
    return lane;
  }
  private run(index: number, text: string, query: boolean): Promise<Float32Array> {
    const lane = this.lane(index);
    return new Promise((resolve, reject) => {
      if (lane.pending) { reject(failure()); return; }
      const id = ++this.sequence; lane.pending = { id, resolve, reject };
      try { lane.worker.postMessage({ id, text, query }); }
      catch { lane.pending = undefined; reject(failure()); }
    });
  }
  async embed(text: string, query: boolean): Promise<Float32Array> { return (await this.work([text], query))[0]; }
  embedMany(texts: string[], parallel = true): Promise<Float32Array[]> { return this.work(texts, false, parallel); }
  private async work(texts: string[], query: boolean, parallel = false): Promise<Float32Array[]> {
    if (this.busy || texts.length > 8 || texts.some(text => typeof text !== 'string' || text.length > 16000)) throw new Error('Invalid or overlapping embedding batch');
    this.busy = true; const epoch = this.epoch;
    try {
      await this.retiring;
      if (epoch !== this.epoch) throw failure();
      let next = 0; const vectors = new Array<Float32Array>(texts.length);
      await Promise.all(Array.from({ length: Math.min(parallel ? this.parallelism.workers : 1, texts.length) }, async (_, lane) => {
        while (next < texts.length) { if (epoch !== this.epoch) throw failure(); const index = next++; vectors[index] = await this.run(lane, texts[index], query); }
      }));
      if (epoch !== this.epoch) throw failure();
      return vectors;
    } catch (error) { await this.close(); throw error; }
    finally { this.busy = false; }
  }
  async close() {
    this.epoch++;
    const lanes = this.lanes; this.lanes = [];
    this.retiring = Promise.all([this.retiring, ...lanes.map(lane => {
      lane.pending?.reject(failure()); lane.pending = undefined; return lane.worker.terminate();
    })]);
    await this.retiring;
  }
}
