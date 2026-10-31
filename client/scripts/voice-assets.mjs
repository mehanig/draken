import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'public/voice-assets');
fs.mkdirSync(output, { recursive: true });
for (const [packageName, names] of [
  ['@ricky0123/vad-web', ['silero_vad_v5.onnx', 'vad.worklet.bundle.min.js']],
  ['onnxruntime-web', ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']],
]) {
  for (const name of names) fs.copyFileSync(path.join(root, 'node_modules', packageName, 'dist', name), path.join(output, name));
}
// The published npm packages omit these standalone notices. Preserve upstream
// licenses alongside the redistributed model/worklet/WASM (onnxruntime v1.22.0).
fs.cpSync(path.join(root, 'scripts/voice-licenses'), path.join(output, 'licenses'), { recursive: true });
// All detector assets are same-origin; no CDN or browser speech-recognition service.
