import fs from 'node:fs';
import Database from 'better-sqlite3';
import { digest, cleanText } from '../sync/normalize';
import { PLAIN_ENGLISH } from '../plain-english';
import { MATCHING_RECIPE, CONTRACT_MATCH_PROMPT, contractMatchInput, validateContractAssessment, decideContractMatch,
  validateProcess, validateProcessEvidence, type ContractMatchInput, type ContractDecision, type ContractAssessment } from '../workflow-learning';
import { readPilotBatch, type PilotCapture } from './evidence-host';
import type { PilotModel } from './backfill';

interface HistoricalSide { kind: 'historical'; store: string; extraction: string; fragment: string }
interface SyntheticSide { kind: 'synthetic'; fragment: unknown; records: { ref: string; role: string }[] }
interface EvaluationCase { name: string; expected: { sameWorkflow: boolean; relations: string[] }; left: HistoricalSide | SyntheticSide; right: HistoricalSide | SyntheticSide }
interface Manifest { cases: EvaluationCase[] }
/** Exact manifest bytes freeze expectations before any inference. They are NEVER sent to the model. */
export function loadMatchingCases(file: string): { manifest: Manifest; hash: string } {
  const text = fs.readFileSync(file, 'utf8');
  if (Buffer.byteLength(text) > 500000) throw Error('Matching cases exceed 500 KB');
  const value = JSON.parse(text) as Manifest;
  if (!value || !Array.isArray(value.cases) || !value.cases.length || value.cases.length > 8) throw Error('Select one to eight explicit comparison cases');
  const names = new Set<string>();
  for (const c of value.cases) {
    if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 150 || names.has(c.name)) throw Error('Invalid or duplicate case name'); names.add(c.name);
    if (!c.expected || typeof c.expected.sameWorkflow !== 'boolean' || !Array.isArray(c.expected.relations) || !c.expected.relations.length || c.expected.relations.some(r => !['same_workflow_candidate', 'shared_subprocedure', 'common_practice', 'different', 'insufficient'].includes(r))) throw Error('Invalid predeclared expected result');
    for (const s of [c.left, c.right]) {
      if (!s || !['historical', 'synthetic'].includes(s.kind)) throw Error('Explicit historical/synthetic origin required');
      if (s.kind === 'historical' && [s.store, s.extraction, s.fragment].some(x => typeof x !== 'string' || !x.trim())) throw Error('Historical input needs store, extraction and fragment');
      if (s.kind === 'synthetic' && (!Array.isArray(s.records) || s.records.length > 100 || s.records.some(r => !r || typeof r.ref !== 'string' || typeof r.role !== 'string'))) throw Error('Synthetic input requires source-role metadata');
    }
  }
  return { manifest: value, hash: digest(text) };
}
async function readMatchingSide(side: HistoricalSide | SyntheticSide, signal: AbortSignal): Promise<{ input: ContractMatchInput; identity: string }> {
  signal.throwIfAborted();
  if (side.kind === 'synthetic') {
    const value = validateProcess(JSON.stringify({ summary: 'Controlled comparison fixture, not historical evidence', fragments: [side.fragment], limitations: ['Synthetic example'] }), side.records.map(r => r.ref));
    validateProcessEvidence(value, side.records);
    return { input: contractMatchInput(value.fragments[0]), identity: digest(JSON.stringify(side)) };
  }
  const store = new Database(side.store, { readonly: true, fileMustExist: true });
  try {
    const row = store.prepare("SELECT output_json,source_dependencies_json FROM process_extractions WHERE id=? AND kind='summary' AND status='completed'").get(side.extraction) as { output_json: string; source_dependencies_json: string } | undefined;
    if (!row) throw Error('Missing completed historical extraction');
    const deps = JSON.parse(row.source_dependencies_json) as { source: string; captures: PilotCapture[] };
    const source = new Database(deps.source, { readonly: true, fileMustExist: true });
    try {
      const records = [];
      if (!Array.isArray(deps.captures) || !deps.captures.length || deps.captures.length > 3) throw Error('Invalid historical sample captures');
      for (const c of deps.captures) {
        if (!c.originals.length || c.originals.length > 24) throw Error('Historical samples require at most 24 originals per capture');
        for (let i = 0; i < c.originals.length; i += 8) records.push(...(await readPilotBatch(source, c, c.originals.slice(i, i + 8), signal)).records);
      }
      const output = validateProcessEvidence(validateProcess(row.output_json, records.map(r => r.ref)), records);
      const f = output.fragments.find(f => f.key === side.fragment); if (!f) throw Error('Unknown historical fragment');
      return { input: contractMatchInput(f), identity: digest(JSON.stringify([side, row, records])) };
    } finally { source.close(); }
  } finally { store.close(); }
}

/** Experiment: caller holds exclusive store lock. Sixteen lifetime calls for two model runs, no retries or silent resets. */
export async function evaluateMatchingCase(store: Database.Database, file: string, manifestHash: string, index: number, model: string, ask: PilotModel, signal: AbortSignal) {
  const current = loadMatchingCases(file); if (current.hash !== manifestHash) throw Error('Evaluation manifest changed');
  const c = current.manifest.cases[index]; if (!c) throw Error('Unknown comparison case');
  const prior = store.prepare('SELECT source_dependencies_json FROM process_extractions LIMIT 1').get() as { source_dependencies_json: string } | undefined;
  if (prior && JSON.parse(prior.source_dependencies_json).manifestHash !== manifestHash) throw Error('This store belongs to a different frozen evaluation manifest');
  const sides = [await readMatchingSide(c.left, signal), await readMatchingSide(c.right, signal)];
  const inputs = sides.map(s => s.input);
  // Ref numbers and expectation/case labels are absent on the wire; use local fact IDs instead.
  const wire = inputs.map(input => ({ ...input, facts: input.facts.map(({ refs: _refs, ...fact }) => fact) }));
  const payload = { task: 'compare_workflow_identity', left: wire[0], right: wire[1] };
  const recipe = digest(JSON.stringify([MATCHING_RECIPE, CONTRACT_MATCH_PROMPT, PLAIN_ENGLISH]));
  const inputKey = digest(JSON.stringify([manifestHash, sides, model]));
  const id = digest(JSON.stringify([recipe, inputKey]));
  const expected = c.expected;
  const finish = (decision: ContractDecision, cached: boolean) => ({ id, name: c.name, origin: [c.left.kind, c.right.kind], expected,
    passed: decision.sameWorkflow === expected.sameWorkflow && expected.relations.includes(decision.relation), decision, cached });
  const cached = store.prepare('SELECT status,output_json FROM process_extractions WHERE id=?').get(id) as { status: string; output_json: string } | undefined;
  if (cached) {
    if (cached.status !== 'completed') throw Error('Comparison attempt failed/interrupted; no automatic retry');
    const saved = JSON.parse(cached.output_json);
    return finish(decideContractMatch(validateContractAssessment(JSON.stringify(saved.assessment), inputs), inputs), true);
  }
  signal.throwIfAborted();
  store.transaction(() => {
    if ((store.prepare('SELECT COUNT(*) n FROM process_extractions').get() as { n: number }).n >= 16) throw Error('Matching evaluation reached its lifetime limit of sixteen invocations');
    store.prepare(`INSERT INTO process_extractions(id,kind,input_key,recipe_version,model,status,source_dependencies_json,created_at)
      VALUES (?,'comparison',?,?,?,'running',?,?)`).run(id, inputKey, recipe, model, JSON.stringify({ manifestHash, index, name: c.name, expected, sources: [c.left, c.right], sourceIdentities: sides.map(s => s.identity) }), new Date().toISOString());
  })();
  try {
    const raw = await ask(JSON.stringify(payload), { model, system: CONTRACT_MATCH_PROMPT, signal,
      onAccounting: usage => store.prepare('UPDATE process_extractions SET usage_json=? WHERE id=?').run(JSON.stringify(usage), id) });
    signal.throwIfAborted();
    if (loadMatchingCases(file).hash !== manifestHash) throw Error('Evaluation manifest changed during inference');
    const after = [await readMatchingSide(c.left, signal), await readMatchingSide(c.right, signal)];
    if (JSON.stringify(after) !== JSON.stringify(sides)) throw Error('Comparison source changed during inference');
    const assessment: ContractAssessment = validateContractAssessment(raw, inputs);
    const decision = decideContractMatch(assessment, inputs);
    signal.throwIfAborted();
    store.prepare("UPDATE process_extractions SET status='completed',output_json=?,completed_at=? WHERE id=?").run(JSON.stringify(decision), new Date().toISOString(), id);
    return finish(decision, false);
  } catch (error) {
    store.prepare('UPDATE process_extractions SET status=?,output_json=?,completed_at=? WHERE id=?').run(signal.aborted ? 'cancelled' : 'failed', JSON.stringify({ error: cleanText(error instanceof Error ? error.message : 'Matching failed', 1000) }), new Date().toISOString(), id);
    throw error;
  }
}
