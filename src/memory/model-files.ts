// Metadata only: safe to inspect readiness without loading an inference runtime.
export const MODEL = 'Xenova/multilingual-e5-small';
export const REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
export const MODEL_ID = `${MODEL}@${REVISION}/q8-mean-normalized-v1`;
export const FILES = [
  { name: 'onnx/model_quantized.onnx', size: 118308185, sha: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193' },
  { name: 'tokenizer.json', size: 17082730, sha: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' },
  { name: 'tokenizer_config.json', size: 443, sha: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b' },
];
