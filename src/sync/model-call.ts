import { getDb } from '../db/schema';
import { HttpError } from '../errors';
import type { ModelCallMetric, SyncModels } from '../types';
import { invokePi } from './pi';
import { isBatchSummaryModel, LUNA_BATCH, promptTokens, summaryTokens } from './summary-budget';

export async function modelCall(payload: unknown, system: string, options: {
  models: SyncModels; runId: number; signal: AbortSignal; table?: 'sync_runs' | 'background_runs';
  final?: boolean; reserveAnswer?: boolean; accounting?: boolean;
}): Promise<string> {
  const { models, runId, signal, final = false, reserveAnswer = false, accounting = true, table = 'sync_runs' } = options;
  signal.throwIfAborted();
  const db = getDb(), model = final ? models.final : models.summary, large = !final && isBatchSummaryModel(model);
  const prompt = JSON.stringify(payload), estimatedTokens = promptTokens(prompt, system);
  if (large && estimatedTokens > LUNA_BATCH.requestTokens) throw new HttpError(400, 'Summary request exceeds its token safety budget; cached work is intact.');
  if (final && isBatchSummaryModel(models.summary) && estimatedTokens > LUNA_BATCH.finalTokens) throw new HttpError(400, 'The final input exceeds its compact token budget; no larger or more expensive request was substituted. Cached summaries are intact.');
  const limit = models.max_invocations - (reserveAnswer ? 1 : 0), started = Date.now();
  const request = payload as { task?: string; stage?: string; repair?: unknown };
  const pending: ModelCallMetric = { started_at: new Date(started).toISOString(), task: request.task || 'unknown', stage: request.stage || null,
    repair: Boolean(request.repair), model, elapsed_ms: 0, input_characters: prompt.length, input_tokens_estimate: estimatedTokens,
    output_characters: null, output_tokens_estimate: null, status: 'running' };
  const claimed = db.prepare(`UPDATE ${table} SET invocations=invocations+1,
    metrics_json=json_insert(metrics_json,'$[#]',json(?)) WHERE id=? AND invocations<?
    RETURNING json_array_length(metrics_json)-1 AS metric_index`).get(JSON.stringify(pending), runId, limit) as { metric_index: number } | undefined;
  if (!claimed) throw new HttpError(409, 'Invocation budget reached. Completed summaries are cached. Raise the limit and retry; nothing was marked covered.');
  let response: string | undefined, usage: ModelCallMetric['accounting'];
  try {
    response = await invokePi(prompt, { model, system, signal, thinking: final ? 'medium' : 'off', largeSummary: large,
      onAccounting: accounting ? value => { usage = value; } : undefined });
    signal.throwIfAborted();
    return response;
  } finally {
    const metric: ModelCallMetric = { ...pending, finished_at: new Date().toISOString(), ...(usage ? { accounting: usage } : {}),
      elapsed_ms: Date.now() - started, output_characters: response?.length ?? null,
      output_tokens_estimate: response === undefined ? null : summaryTokens(response),
      status: signal.aborted ? 'cancelled' : response !== undefined ? 'completed' : 'failed' };
    db.prepare(`UPDATE ${table} SET metrics_json=json_set(metrics_json,?,json(?)) WHERE id=?`).run(`$[${claimed.metric_index}]`, JSON.stringify(metric), runId);
  }
}
