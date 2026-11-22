/** A bounded follow-through for one real user turn, never a second user message.
 * This is delivery state, not a claim that a model's answer is true or was heard.
 */
export class ReplyContinuation {
  private ready = false;
  private input = false;
  private busy = false;
  private acknowledged = false;
  private sent = false;
  private finished = false;
  private actionPending = false;
  private timer?: NodeJS.Timeout;
  private deadline?: NodeJS.Timeout;

  constructor(private readonly resume: () => Promise<void>, private readonly changed: (pending: boolean, error?: string) => void, private readonly question: () => string = () => '') {}

  lookupStarted() {
    if (!this.finished) { this.ready = false; clearTimeout(this.timer); this.changed(true); }
  }
  /** An application action needs its actual result even if speech answered early. */
  actionStarted() {
    clearTimeout(this.timer); clearTimeout(this.deadline);
    this.actionPending = true; this.finished = false; this.ready = false; this.sent = false;
    this.changed(true);
  }
  inputStarted() { if (!this.finished) { this.input = true; this.schedule(); } }
  contextReady() { if (!this.finished) { this.actionPending = false; this.ready = true; this.schedule(); } }
  response(text: string, final: boolean) {
    if (this.finished || !this.input) return;
    this.busy = !final;
    clearTimeout(this.timer);
    if (!final) return;
    if (this.actionPending) { this.acknowledged = true; return; }
    // A final transcript PART is not necessarily the end of an answer: V3
    // also emits short backchannels. Neither those nor a lookup promise is the
    // requested explanation.
    const plain = text.trim().replace(/[’‘]/g, "'").replace(/[‐‑‒–—]/g, '-');
    if (!plain) { this.schedule(); return; }
    const social = /^(?:(?:thanks|thank you|okay|ok|got it|yes|no|yep|nope|hello|hi|hey|bye|goodbye)(?: draken)?)[.!…\s]*$/i.test(this.question().trim());
    const acknowledgement = !social && plain.length <= 600 && (
      /(?:^|[.!?]\s+)(?:(?:sure|okay|ok|of course)[,\s—:-]+)?(?:i(?:'ll| will)|let me|let's)\s+(?:(?:just|quickly|first|now|briefly)\s+)*(?:check|look|search|review|pull|read|find|fetch|inspect|see|have a look)\b/i.test(plain) ||
      /(?:^|[.!?]\s+)i(?:'m| am)\s+(?:(?:just|currently|now)\s+)*(?:checking|looking|searching|reviewing|pulling|reading|finding|fetching|inspecting)\b/i.test(plain) ||
      /(?:^|[.!?]\s+)(?:checking|searching|looking up|pulling|picking up)\b/i.test(plain) ||
      /^(?:checking|searching|looking it up|okay|ok|sure(?: thing)?|alright|all right|got it|understood|certainly|you bet|will do|on it|one (?:moment|second|sec)|(?:hold|hang) on|mm[- ]?hmm|uh[- ]?huh|hmm|mhm)[.!?…]*$/i.test(plain)
    );
    if (!acknowledgement) { this.cancel(); return; }
    this.acknowledged = true;
    this.schedule();
  }
  cancel(error?: string) {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer); clearTimeout(this.deadline);
    this.changed(false, error);
  }
  private fail() {
    this.cancel('The lookup finished, but a completed voice answer was not confirmed. You can ask again; no automatic retry loop was started.');
  }
  private schedule() {
    if (this.finished || this.sent || !this.ready || !this.input || this.busy) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.finished || this.sent || this.busy) return;
      this.sent = true;
      this.deadline = setTimeout(() => this.fail(), 45_000); this.deadline.unref();
      void this.resume().catch(() => this.fail());
    }, this.acknowledged ? 400 : 1500);
    this.timer.unref();
  }
}
