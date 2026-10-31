/** pi 1.4 JSONL reader. Only assistant text is exposed, never thinking or source prompts. */
export class PiTextStream {
  private buffer = '';
  private total = 0;
  private started = false;
  private final = false;
  private settled = false;
  text = '';
  constructor(private onText: (delta: string) => void) {}

  feed(chunk: string): void {
    this.total += chunk.length;
    this.buffer += chunk;
    if (this.total > 4_000_000 || this.buffer.length > 1_000_000) throw new Error('pi event stream exceeded its safety limit');
    let end: number;
    // Unicode line/paragraph separators are legal inside JSON strings. Only LF frames records.
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, ''); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === 'message_start' && event.message?.role === 'assistant') {
        if (this.started) throw new Error('Unexpected additional assistant response in voice stream');
        this.started = true;
      }
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        if (!this.started || this.final) throw new Error('Invalid pi text stream order');
        const delta = event.assistantMessageEvent.delta;
        if (typeof delta !== 'string' || this.text.length + delta.length > 64000) throw new Error('pi produced too much text');
        this.text += delta; this.onText(delta);
      }
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        if (event.message.stopReason !== 'stop') throw new Error(`pi did not finish the voice reply successfully${typeof event.message.errorMessage === 'string' ? ': ' + event.message.errorMessage.slice(0, 1500) : ''}`);
        const authoritative = event.message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('');
        if (this.text && authoritative !== this.text) throw new Error('pi revised text that was already streamed');
        if (!this.text) { this.text = authoritative; this.onText(authoritative); }
        this.final = true;
      }
      if (event.type === 'agent_settled') {
        if (event.aborted || !this.final) throw new Error('pi voice response was interrupted');
        this.settled = true;
      }
      if (event.type === 'tool_execution_start' || event.type === 'auto_retry_start') throw new Error('Unexpected tool or retry in voice stream');
    }
  }
  finish(): string {
    if (this.buffer.trim() || !this.final || !this.settled || !this.text.trim()) throw new Error('Incomplete pi voice event stream');
    return this.text;
  }
}
