// Local planning estimates, never provider billing/usage claims. OpenAI publishes
// 1,050,000 context / 128,000 output for GPT-6 Luna, but the installed pi chat
// catalog advertises 272,000. Stay below that smaller window, including output
// and framing headroom; do not modify pi's catalog or assume long-context access.
export const LUNA_BATCH = {
  version: 'sync-tree-v3-token-batches',
  inputTokens: 96_000,
  inputBytes: 1_000_000,
  entries: 2_000,
  plannedRequestTokens: 160_000,
  requestTokens: 192_000,
  requestBytes: 1_500_000,
  outputBytes: 64_000,
  rootTokens: 12_000,
  rootReferences: 96,
  finalTokens: 64_000,
} as const;
export const isBatchSummaryModel = (model: string | undefined) => model === 'openai/gpt-6-luna';
let tokenizer: typeof import('gpt-tokenizer/cjs/encoding/o200k_base') | undefined;
/** o200k is a planning estimate for GPT-6, not a verified server tokenizer.
 * Special-token-looking source text remains ordinary untrusted text. */
export function summaryTokens(text: string): number {
  if (!tokenizer) {
    tokenizer = require('gpt-tokenizer/cjs/encoding/o200k_base');
    tokenizer!.setMergeCacheSize(10_000);
  }
  return tokenizer!.countTokens(text, { disallowedSpecial: new Set<string>() });
}
export function promptTokens(prompt: string, system: string): number {
  // Reserve 20% for tokenizer/framing differences plus fixed session overhead.
  return Math.ceil(summaryTokens(system + '\n' + prompt) * 1.2) + 8192;
}
