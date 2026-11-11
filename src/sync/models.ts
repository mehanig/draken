import type { SyncModels } from '../types';

export function defaultModels(): SyncModels {
  const limit = Number(process.env.DRAKEN_PI_MAX_INVOCATIONS || 120);
  return {
    summary: process.env.DRAKEN_PI_SUMMARY_MODEL || 'openai/gpt-6-luna',
    final: process.env.DRAKEN_PI_FINAL_MODEL || process.env.DRAKEN_PI_MODEL || 'openai/gpt-6-astra',
    max_invocations: Number.isInteger(limit) ? Math.max(1, Math.min(limit, 500)) : 120,
  };
}
