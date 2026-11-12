import fs from 'fs';
import path from 'path';
import { Tokenizer } from '@huggingface/tokenizers';
import type * as Ort from 'onnxruntime-web';
import { FILES } from './model-files';
import { verifyModelFiles } from './model-assets';
import { EMBEDDING_DIMENSIONS } from './embedding-contract';
const ort: typeof Ort = require('onnxruntime-web/wasm');

export class LocalEmbedder {
  private session?: Ort.InferenceSession;
  private tokenizer?: Tokenizer;
  constructor(private directory: string, private threads: number) {
    if (!Number.isSafeInteger(threads) || threads < 1 || threads > 4) throw new Error('Invalid embedding thread budget');
  }
  private async load() {
    if (this.session) return;
    await verifyModelFiles(this.directory);
    // WASM is deliberately used on the server: no CUDA installer or browser bundle.
    // The owning pool caps combined CPU use across isolated inference lanes.
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
    // Long code and multilingual passages must contribute beyond their prefix.
    const pooled = new Float32Array(EMBEDDING_DIMENSIONS); let weight = 0;
    for (let start = 0; start < encoded.ids.length; start += 480) {
      const ids = [0, ...encoded.ids.slice(start, start + 480), 2];
      const input = new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]);
      const mask = new ort.Tensor('int64', new BigInt64Array(ids.length).fill(1n), [1, ids.length]);
      const segment = new ort.Tensor('int64', new BigInt64Array(ids.length), [1, ids.length]);
      const result = await this.session!.run({ input_ids: input, attention_mask: mask,
        ...(this.session!.inputNames.includes('token_type_ids') ? { token_type_ids: segment } : {}) });
      const output = result.last_hidden_state;
      if (!output || output.dims[2] !== EMBEDDING_DIMENSIONS || !(output.data instanceof Float32Array)) throw new Error('Unexpected embedding output');
      for (let token = 0; token < ids.length; token++) for (let d = 0; d < EMBEDDING_DIMENSIONS; d++) pooled[d] += output.data[token * EMBEDDING_DIMENSIONS + d];
      weight += ids.length;
      for (const tensor of Object.values(result)) tensor.dispose(); input.dispose(); mask.dispose(); segment.dispose();
    }
    let norm = 0;
    for (let d = 0; d < EMBEDDING_DIMENSIONS; d++) { pooled[d] /= weight; norm += pooled[d] ** 2; }
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm === 0) throw new Error('Invalid embedding');
    for (let d = 0; d < EMBEDDING_DIMENSIONS; d++) pooled[d] /= norm;
    return pooled;
  }
}
