import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { availableParallelism } from 'os';
import { Tokenizer } from '@huggingface/tokenizers';
import type * as Ort from 'onnxruntime-web';
const ort: typeof Ort = require('onnxruntime-web/wasm');
import { historyUpdate, type Embedder, type ReportHistory } from './types';

// CPU-only text embeddings. No speech runtime, provider credentials, downloaded
// executable code or arbitrary model URLs. The owner prepares files on demand.
import { MODEL, REVISION, MODEL_ID, FILES } from './model-files';

export class LocalEmbedder implements Embedder {
  readonly fingerprint = MODEL_ID;
  private session?: Ort.InferenceSession;
  private tokenizer?: Tokenizer;
  constructor(private directory: string, private threads = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)))) {
    if (!Number.isSafeInteger(threads) || threads < 1 || threads > 4) throw new Error('Invalid embedding thread budget');
  }
  ready() { return FILES.every(file => { try { return fs.statSync(path.join(this.directory, file.name)).size === file.size; } catch { return false; } }); }
  private async verified(file: typeof FILES[number]) {
    const hash = createHash('sha256');
    try { for await (const chunk of fs.createReadStream(path.join(this.directory, file.name))) hash.update(chunk); return hash.digest('hex') === file.sha; }
    catch { return false; }
  }
  async setup(report?: ReportHistory, allowDownload = true) {
    const total = FILES.reduce((sum, file) => sum + file.size, 0);
    let completed = 0;
    for (const file of FILES) {
      if (await this.verified(file)) { completed += file.size; continue; }
      if (!allowDownload) throw new Error('Pinned embedding files are missing or damaged. Prepare history before calling.');
      const progress = (size: number) => report?.(historyUpdate('downloading', { downloaded_bytes: completed + size, download_total_bytes: total }));
      progress(0);
      const target = path.join(this.directory, file.name), temporary = target + '.part';
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 300000);
      try {
        const response = await fetch(`https://huggingface.co/${MODEL}/resolve/${REVISION}/${file.name}`, { signal: controller.signal });
        if (!response.ok || !response.body) throw new Error('Model download failed');
        const handle = fs.openSync(temporary, 'w', 0o600), hash = createHash('sha256'); let size = 0;
        try {
          for await (const chunk of response.body) {
            size += chunk.length; if (size > file.size) throw new Error('Model size mismatch');
            hash.update(chunk); fs.writeSync(handle, chunk); progress(size);
          }
        } finally { fs.closeSync(handle); }
        if (size !== file.size || hash.digest('hex') !== file.sha) throw new Error('Model checksum mismatch');
        fs.renameSync(temporary, target); completed += file.size;
      } finally { clearTimeout(timer); fs.rmSync(temporary, { force: true }); }
    }
  }
  private async load() {
    if (this.session) return;
    for (const file of FILES) if (!await this.verified(file)) throw new Error('Pinned embedding files are missing or damaged. Retry the history request to repair them.');
    // WASM is deliberately used on the server: no CUDA installer or browser bundle.
    // Each isolated embedding lane has one session and a bounded kernel budget.
    // The pool caps their combined CPU use, leaving capacity for other work.
    ort.env.wasm.numThreads = this.threads;
    ort.env.wasm.proxy = false;
    ort.env.logLevel = 'error';
    this.tokenizer = new Tokenizer(JSON.parse(fs.readFileSync(path.join(this.directory, 'tokenizer.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(this.directory, 'tokenizer_config.json'), 'utf8')));
    this.session = await ort.InferenceSession.create(fs.readFileSync(path.join(this.directory, FILES[0].name)), { executionProviders: ['wasm'], logSeverityLevel: 3 });
  }
  async embed(text: string, query: boolean): Promise<Float32Array> {
    await this.load();
    const encoded = this.tokenizer!.encode(`${query ? 'query' : 'passage'}: ${text}`, { add_special_tokens: false });
    // Pool ALL tokens in bounded windows, not just the prefix of long code or
    // multilingual text. Passage chunks are independently indexed as well.
    const pooled = new Float32Array(384); let weight = 0;
    for (let start = 0; start < encoded.ids.length; start += 480) {
      const ids = [0, ...encoded.ids.slice(start, start + 480), 2];
      const input = new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]);
      const mask = new ort.Tensor('int64', new BigInt64Array(ids.length).fill(1n), [1, ids.length]);
      const segment = new ort.Tensor('int64', new BigInt64Array(ids.length), [1, ids.length]);
      const result = await this.session!.run({ input_ids: input, attention_mask: mask,
        ...(this.session!.inputNames.includes('token_type_ids') ? { token_type_ids: segment } : {}) });
      const output = result.last_hidden_state;
      if (!output || output.dims[2] !== 384 || !(output.data instanceof Float32Array)) throw new Error('Unexpected embedding output');
      for (let token = 0; token < ids.length; token++) for (let d = 0; d < 384; d++) pooled[d] += output.data[token * 384 + d];
      weight += ids.length;
      for (const tensor of Object.values(result)) tensor.dispose(); input.dispose(); mask.dispose(); segment.dispose();
    }
    let norm = 0;
    for (let d = 0; d < 384; d++) { pooled[d] /= weight; norm += pooled[d] ** 2; }
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm === 0) throw new Error('Invalid embedding');
    for (let d = 0; d < 384; d++) pooled[d] /= norm;
    return pooled;
  }
}
