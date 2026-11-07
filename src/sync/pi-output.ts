import { createHash } from 'crypto';
import type { PiAccounting } from '../types';

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; usd: number | null };
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function usage(value: any): Usage | undefined {
  if (!value || !['input', 'output', 'cacheRead', 'cacheWrite'].every(key => count(value[key]))) return;
  const reasoning = value.reasoning ?? 0;
  if (!count(reasoning) || reasoning > value.output) return;
  const total = value.input + value.output + value.cacheRead + value.cacheWrite;
  if (!Number.isSafeInteger(total) || total === 0) return; // Pi also emits zero-filled unknown usage.
  const costs = value.cost, fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'];
  const valid = costs && fields.every(key => typeof costs[key] === 'number' && Number.isFinite(costs[key]) && costs[key] >= 0 && costs[key] <= 1e6);
  const sum = valid ? costs.input + costs.output + costs.cacheRead + costs.cacheWrite : 0;
  // Zero catalog rates are indistinguishable from unavailable pricing here.
  const usd = valid && costs.total > 0 && Math.abs(sum - costs.total) <= Math.max(1e-9, costs.total * 1e-6) ? costs.total : null;
  return { input: value.input, output: value.output, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite, reasoning, usd };
}

/** Strict LF-framed pi JSON protocol. Retains answer text and numeric accounting,
 * never prompts, thinking, signatures, raw events or provider error payloads. */
export class PiOutput {
  private pending = '';
  private wireBytes = 0;
  private active = false;
  private settled = false;
  private aborted = false;
  private streamedChars = 0;
  private streamedBytes = 0;
  private latest?: Usage;
  private lastEnd = '';
  private answer = '';
  private stopReason = '';
  private error = '';
  private incomplete = false;
  private priced = 0;
  private unpriced = 0;
  private usd = 0;
  private totals = { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0 };
  private models = new Set<string>();
  constructor(private maxOutput: number, private byteLimit: boolean) {}
  private outputLimit(text: string) {
    if ((this.byteLimit ? Buffer.byteLength(text) : text.length) > this.maxOutput) throw new Error('pi produced too much output. No incomplete result was saved.');
  }
  push(chunk: string) {
    this.wireBytes += Buffer.byteLength(chunk);
    if (this.wireBytes > 64 * 1024 ** 2) throw new Error('pi JSON stream exceeded its safety limit');
    this.pending += chunk;
    let at: number;
    while ((at = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, at).replace(/\r$/, ''); this.pending = this.pending.slice(at + 1);
      if (Buffer.byteLength(line) > 8 * 1024 ** 2) throw new Error('pi JSON record exceeded its safety limit');
      if (!line.trim()) continue;
      let event: any; try { event = JSON.parse(line); } catch { throw new Error('Invalid pi JSON event stream'); }
      this.event(event);
    }
    if (Buffer.byteLength(this.pending) > 8 * 1024 ** 2) throw new Error('pi JSON record exceeded its safety limit');
  }
  private add(value?: Usage) {
    if (this.priced + this.unpriced >= 512) throw new Error('Too many pi usage records');
    if (value && ![this.totals.input + value.input, this.totals.output + value.output, this.totals.cache_read + value.cacheRead, this.totals.cache_write + value.cacheWrite].every(count)) value = undefined;
    if (!value) { this.unpriced++; return; }
    this.totals.input += value.input; this.totals.output += value.output;
    this.totals.cache_read += value.cacheRead; this.totals.cache_write += value.cacheWrite; this.totals.reasoning += value.reasoning;
    if (value.usd === null) this.unpriced++;
    else { this.priced++; this.usd += value.usd; }
  }
  private event(event: any) {
    if (!event || typeof event.type !== 'string') throw new Error('Invalid pi JSON event');
    if (event.type.startsWith('tool_execution_')) throw new Error('Unexpected tool activity in tool-free pi invocation');
    if (event.type === 'agent_start') { this.settled = false; return; }
    if (event.type === 'message_start' && event.message?.role === 'assistant') {
      if (this.active) throw new Error('Overlapping pi assistant messages');
      this.active = true; this.latest = undefined; this.streamedChars = this.streamedBytes = 0; this.settled = false;
    } else if (event.type === 'message_update') {
      if (!this.active) throw new Error('Unexpected pi assistant update');
      this.latest = usage(event.usage) || this.latest;
      const update = event.assistantMessageEvent;
      if (update?.type === 'text_delta') {
        if (typeof update.delta !== 'string') throw new Error('Invalid pi text delta');
        this.streamedChars += update.delta.length; this.streamedBytes += Buffer.byteLength(update.delta);
        if ((this.byteLimit ? this.streamedBytes : this.streamedChars) > this.maxOutput) throw new Error('pi produced too much output. No incomplete result was saved.');
      }
    } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const message = event.message, key = createHash('sha256').update(JSON.stringify(message)).digest('hex');
      if (!this.active && key === this.lastEnd) return; // Never count a repeated final event twice.
      if (!this.active) throw new Error('Unexpected pi assistant completion');
      this.active = false; this.lastEnd = key;
      this.add(usage(message.usage)); this.latest = undefined;
      if (this.models.size < 32 && [message.provider, message.model].every(value => typeof value === 'string' && /^[\w./:@+-]{1,160}$/.test(value))) this.models.add(`${message.provider}/${message.model}`);
      if (!Array.isArray(message.content)) throw new Error('Invalid pi assistant content');
      const text = message.content.filter((part: any) => part.type === 'text').map((part: any) => {
        if (typeof part.text !== 'string') throw new Error('Invalid pi assistant text'); return part.text;
      }).join('');
      this.outputLimit(text); this.answer = text;
      this.stopReason = message.stopReason;
      this.error = typeof message.errorMessage === 'string' ? message.errorMessage.slice(0, 1500) : '';
    } else if (event.type === 'compaction_end') {
      this.add(usage(event.result?.usage));
    } else if (event.type === 'agent_settled') {
      if (typeof event.aborted !== 'boolean') throw new Error('Invalid pi settlement');
      this.settled = true; this.aborted = event.aborted;
    }
    // message/turn/agent_end repeat the same response: account only message_end.
  }
  finish(transportComplete: boolean): PiAccounting {
    if (this.active) { this.add(this.latest); this.active = false; this.incomplete = true; }
    const complete = transportComplete && !this.pending.trim() && this.settled && !this.aborted && !this.incomplete && this.unpriced === 0 && this.priced > 0;
    return { source: 'pi-usage/catalog-pricing', cost_usd: this.priced ? this.usd : null, complete,
      responses: this.priced + this.unpriced, tokens: { ...this.totals }, models: [...this.models] };
  }
  result(): string {
    if (this.pending.trim() || !this.settled || this.incomplete) throw new Error('pi ended before its JSON run settled. No incomplete result was saved.');
    if (this.aborted || this.stopReason !== 'stop') throw new Error(this.error || `pi response ended with ${this.aborted ? 'aborted' : this.stopReason || 'no completed message'}. No incomplete result was saved.`);
    if (!this.answer.trim()) throw new Error('pi returned no response. Coverage did not advance.');
    return this.answer.trim();
  }
}
