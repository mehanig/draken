/** Frames complete JSON objects, not partial strings. Pretty-printing is harmless;
 * prose, arrays, incomplete objects and extra data are rejected. References are
 * still checked by the caller before any sentence is synthesized. */
export class VoiceAnswerStream {
  private buffer = '';
  private started = false;
  private fenced = false;
  private closed = false;
  private count = 0;
  constructor(private accept: (json: string) => void) {}
  feed(delta: string) {
    this.buffer += delta;
    if (this.buffer.length > 6000) throw new Error('The spoken reply format was too large');
    while ((this.buffer = this.buffer.trimStart())) {
      if (this.closed) throw new Error('Unexpected text after the spoken reply');
      if (!this.started && this.buffer[0] === '`') {
        const end = this.buffer.indexOf('\n');
        if (end < 0) return;
        if (!/^```(?:json|jsonl|ndjson)?\s*$/.test(this.buffer.slice(0, end))) throw new Error('Invalid spoken reply wrapper');
        this.started = true; this.fenced = true; this.buffer = this.buffer.slice(end + 1); continue;
      }
      if (this.fenced && this.buffer[0] === '`') {
        if (this.buffer.length < 3) return;
        if (!this.buffer.startsWith('```')) throw new Error('Invalid spoken reply wrapper');
        this.closed = true; this.buffer = this.buffer.slice(3); continue;
      }
      if (this.buffer[0] !== '{') throw new Error('The next sentence was not valid JSON and was not spoken');
      let depth = 0, quoted = false, escape = false, end = -1;
      for (let index = 0; index < this.buffer.length; index++) {
        const char = this.buffer[index];
        if (quoted) { if (escape) escape = false; else if (char === '\\') escape = true; else if (char === '"') quoted = false; }
        else if (char === '"') quoted = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) { end = index + 1; break; }
      }
      if (end < 0) return;
      const object = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end); this.started = true;
      this.accept(object); this.count++;
    }
  }
  finish() {
    if (this.buffer.trim() || !this.count || (this.fenced && !this.closed)) throw new Error('The spoken reply was incomplete');
  }
}
