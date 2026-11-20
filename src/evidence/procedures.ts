// Chronological preparation for an explicitly selected sample, not intent-based search.
export interface ProcedureRecord {
  ref: string;
  sessionId: string;
  sequence: number;
  at: string;
  role: string;
  text: string;
}
export interface ProcedurePacket {
  sessionId: string;
  before: string;
  records: (ProcedureRecord & { clipped: boolean })[];
  limitations: string[];
}
export interface ProcedureEvidenceRequest {
  sessionId: string;
  before: string;
  refs: string[];
  signal: AbortSignal;
}
export interface ProcedureEvidenceDependencies {
  /** Fresh current permission, baseline/window and original-byte checks on EVERY read. */
  read(ref: string, signal: AbortSignal): Promise<ProcedureRecord>;
  cleanText(value: string, limit: number): string;
}

/** Source identities are explicit host-selected scope, not guessed project restrictions.
 * No model calls or storage. The host owns capture, accounting and later revalidation. */
export async function prepareProcedureEvidence(request: ProcedureEvidenceRequest, dependencies: ProcedureEvidenceDependencies): Promise<ProcedurePacket> {
  const { sessionId, before, refs, signal } = request;
  signal.throwIfAborted();
  if (!sessionId || !Number.isFinite(Date.parse(before)) || !refs.length || refs.length > 8 ||
    refs.some(ref => typeof ref !== 'string' || !ref || ref.length > 160) || new Set(refs).size !== refs.length) {
    throw new Error('Invalid procedure evidence sample; select one to eight distinct originals.');
  }
  const records: ProcedurePacket['records'] = [];
  for (const ref of refs) {
    signal.throwIfAborted();
    const record = await dependencies.read(ref, signal);
    signal.throwIfAborted();
    if (record.ref !== ref || record.sessionId !== sessionId || !Number.isFinite(Date.parse(record.at)) ||
      Date.parse(record.at) > Date.parse(before) || !Number.isSafeInteger(record.sequence) ||
      (records.length && record.sequence <= records[records.length - 1].sequence)) {
      throw new Error('Procedure original is outside the captured session, order or cutoff.');
    }
    const text = dependencies.cleanText(record.text, Number.MAX_SAFE_INTEGER);
    const clipped = text.length > 4000;
    // Keep the closing qualification as well as the start; never claim complete records.
    records.push({ ...record, role: dependencies.cleanText(record.role, 80),
      text: clipped ? text.slice(0, 3000) + '\n[Middle omitted from this original]\n' + text.slice(-1000) : text, clipped });
  }
  const packet: ProcedurePacket = { sessionId, before, records, limitations: [
    'Explicit small chronological sample of indexed active originals, not a complete session or task.',
    'Session order alone does not prove a prerequisite. A request or assistant claim does not prove execution.',
    'Corrections or outcomes may occur outside this sample. Repeated records are not independent task examples.',
    ...(records.some(record => record.clipped) ? ['Long originals retain only their beginning and ending; the middle is omitted.'] : []),
  ] };
  if (new TextEncoder().encode(JSON.stringify(packet)).byteLength > 140000) throw new Error('Procedure evidence exceeds the packet byte limit.');
  return packet;
}
