// This dimension is part of the pinned model and persisted vector format.
export const EMBEDDING_DIMENSIONS = 384;
export const EMBEDDING_BYTES = EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT;
export const EMBEDDING_TEXT_LIMIT = 16000;

export function validEmbedding(value: unknown): value is Float32Array {
  return value instanceof Float32Array && value.length === EMBEDDING_DIMENSIONS && value.every(Number.isFinite);
}
