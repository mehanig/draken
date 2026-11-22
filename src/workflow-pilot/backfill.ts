import type Database from 'better-sqlite3';
import { digest } from '../sync/normalize';
import { PLAIN_ENGLISH } from '../plain-english';
import { extractProcedures, extractionMarkdown, validateExtraction, PROCEDURE_PROMPT, PROCEDURE_RECIPE, type ProcedureExtraction } from '../workflow-learning';
import { readPilotBatch, type PilotCapture } from './evidence-host';

export interface PilotJob { id: string; source: string; capture: PilotCapture; model: string; recipe: string; calls: number; status: string }
interface PilotModelRequest { model: string; signal: AbortSignal; system: string; onAccounting(value: unknown): void }
export type PilotModel = (prompt: string, request: PilotModelRequest) => Promise<string>;
const recipe = () => digest(JSON.stringify([PROCEDURE_RECIPE, PROCEDURE_PROMPT, PLAIN_ENGLISH]));

export function initPilotStore(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS workflow_pilot_jobs (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, capture_json TEXT NOT NULL, model TEXT NOT NULL, recipe TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workflow_pilot_attempts (
      id INTEGER PRIMARY KEY, job_id TEXT NOT NULL REFERENCES workflow_pilot_jobs(id), batch_key TEXT NOT NULL,
      status TEXT NOT NULL, usage_json TEXT, started_at TEXT NOT NULL, completed_at TEXT);
    CREATE TABLE IF NOT EXISTS workflow_pilot_artifacts (
      key TEXT PRIMARY KEY, recipe TEXT NOT NULL, model TEXT NOT NULL, dependencies_json TEXT NOT NULL,
      output_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workflow_pilot_batches (
      job_id TEXT NOT NULL REFERENCES workflow_pilot_jobs(id), ordinal INTEGER NOT NULL,
      artifact_key TEXT NOT NULL REFERENCES workflow_pilot_artifacts(key), PRIMARY KEY(job_id,ordinal));`);
}
export function createPilot(db: Database.Database, source: string, capture: PilotCapture, model: string): PilotJob {
  if (!model.trim() || model.length > 200) throw new Error('Select an explicit pilot model.');
  const { before: _cutoff, ...identity } = capture;
  const existing = db.prepare("SELECT id FROM workflow_pilot_jobs WHERE source=? AND model=? AND recipe=? AND json_remove(capture_json,'$.before')=json(?) LIMIT 1")
    .get(source, model, recipe(), JSON.stringify(identity)) as { id: string } | undefined;
  const id = existing?.id || digest(JSON.stringify([source, identity, model, recipe()])).slice(0, 24);
  db.prepare(`INSERT OR IGNORE INTO workflow_pilot_jobs(id,source,capture_json,model,recipe,created_at) VALUES (?,?,?,?,?,?)`)
    .run(id, source, JSON.stringify(capture), model, recipe(), new Date().toISOString());
  return loadPilot(db, id);
}
export function loadPilot(db: Database.Database, id: string): PilotJob {
  const row = db.prepare('SELECT * FROM workflow_pilot_jobs WHERE id=?').get(id) as any;
  if (!row) throw new Error('Unknown pilot ID.');
  if (row.recipe !== recipe()) throw new Error('Processor recipe changed. Keep this result; explicitly capture a new pilot to use the new recipe.');
  return { id: row.id, source: row.source, capture: JSON.parse(row.capture_json), model: row.model, recipe: row.recipe, calls: row.calls, status: row.status };
}
export function recoverPilotStore(db: Database.Database): void {
  db.prepare("UPDATE workflow_pilot_attempts SET status='interrupted',completed_at=? WHERE status='running'").run(new Date().toISOString());
  db.prepare("UPDATE workflow_pilot_jobs SET status='interrupted' WHERE status='running'").run();
}

/** One explicit pilot, max three paid calls, no automatic retry or whole-history mode.
 * Source is read-only. Store is a separate private database, never the app database. */
export async function runPilot(source: Database.Database, store: Database.Database, job: PilotJob, ask: PilotModel,
  signal: AbortSignal, retry = false): Promise<string> {
  if (job.source !== source.name) throw new Error('Pilot belongs to a different source database.');
  if (!job.capture.originals.length || job.capture.originals.length > 24) throw new Error('Invalid pilot sample size.');
  const outputs: { ordinal: number; key: string; value: ProcedureExtraction }[] = [];
  store.prepare("UPDATE workflow_pilot_jobs SET status='running' WHERE id=?").run(job.id);
  try {
    for (let offset = 0; offset < job.capture.originals.length; offset += 8) {
      signal.throwIfAborted();
      const entries = job.capture.originals.slice(offset, offset + 8);
      const input = await readPilotBatch(source, job.capture, entries, signal);
      const key = digest(JSON.stringify([job.source, job.recipe, job.model, entries, input]));
      const cached = store.prepare('SELECT output_json FROM workflow_pilot_artifacts WHERE key=?').get(key) as { output_json: string } | undefined;
      let value: ProcedureExtraction;
      if (cached) value = validateExtraction(cached.output_json, entries.map(item => item.ref));
      else {
        const previous = store.prepare('SELECT status FROM workflow_pilot_attempts WHERE job_id=? AND batch_key=? ORDER BY id DESC LIMIT 1').get(job.id, key) as { status: string } | undefined;
        if (previous && !retry) throw new Error('This batch already spent a call without a reusable result. Inspect it, then use --retry explicitly; spent calls remain counted.');
        const attempt = store.transaction(() => {
          const changed = store.prepare('UPDATE workflow_pilot_jobs SET calls=calls+1 WHERE id=? AND calls<3').run(job.id);
          if (!changed.changes) throw new Error('Pilot reached its total limit of three paid model invocations. No additional call started.');
          return Number(store.prepare("INSERT INTO workflow_pilot_attempts(job_id,batch_key,status,started_at) VALUES (?,?,'running',?)")
            .run(job.id, key, new Date().toISOString()).lastInsertRowid);
        })();
        try {
          value = await extractProcedures(input, async (payload, system) => ask(JSON.stringify(payload), {
            model: job.model, system, signal,
            onAccounting: usage => store.prepare('UPDATE workflow_pilot_attempts SET usage_json=? WHERE id=?').run(JSON.stringify(usage), attempt),
          }), signal);
          const checked = await readPilotBatch(source, job.capture, entries, signal);
          if (JSON.stringify(input) !== JSON.stringify(checked)) throw new Error('Evidence changed during extraction. Result was not admitted.');
          signal.throwIfAborted();
          store.transaction(() => {
            store.prepare('INSERT OR IGNORE INTO workflow_pilot_artifacts(key,recipe,model,dependencies_json,output_json,created_at) VALUES (?,?,?,?,?,?)')
              .run(key, job.recipe, job.model, JSON.stringify({ source: job.source, capture: job.capture, entries }), JSON.stringify(value), new Date().toISOString());
            store.prepare("UPDATE workflow_pilot_attempts SET status='completed',completed_at=? WHERE id=?").run(new Date().toISOString(), attempt);
          })();
        } catch (error) {
          store.prepare('UPDATE workflow_pilot_attempts SET status=?,completed_at=? WHERE id=?').run(signal.aborted ? 'cancelled' : 'failed', new Date().toISOString(), attempt);
          throw error;
        }
      }
      store.prepare('INSERT OR REPLACE INTO workflow_pilot_batches(job_id,ordinal,artifact_key) VALUES (?,?,?)').run(job.id, offset / 8, key);
      outputs.push({ ordinal: offset / 8 + 1, key, value });
    }
    for (const item of outputs) {
      const entries = job.capture.originals.slice((item.ordinal - 1) * 8, item.ordinal * 8);
      const input = await readPilotBatch(source, job.capture, entries, signal);
      if (digest(JSON.stringify([job.source, job.recipe, job.model, entries, input])) !== item.key) throw new Error('Evidence changed before report publication.');
    }
    signal.throwIfAborted();
    store.prepare("UPDATE workflow_pilot_jobs SET status='completed' WHERE id=?").run(job.id);
    const current = loadPilot(store, job.id);
    const usage = store.prepare('SELECT id,status,usage_json FROM workflow_pilot_attempts WHERE job_id=? ORDER BY id').all(job.id) as { id: number; status: string; usage_json: string | null }[];
    return [
      '# Workflow identifier — small original-based pilot', '',
      '**Private static export.** No commands were executed by the learning model. Not a reviewed workflow or proof of repeated practice.',
      'This file cannot enforce future source-permission revocation. Keep it private and remove it when its sources should no longer be retained.', '',
      `Pilot: \`${job.id}\` · Recipe: \`${PROCEDURE_RECIPE}\` · Model: \`${job.model.replace(/[`\r\n]/g, '')}\``,
      `Session: \`${job.capture.sessionId}\` · Cutoff: ${job.capture.before}`, '',
      `Captured ${job.capture.originals.length} tail records out of ${job.capture.eligibleRecords} eligible indexed records; ${job.capture.omittedRecords} omitted.`,
      `Paid model invocations across this pilot, including failures: ${current.calls}/3. Cache reuse adds no model call.`,
      'Batches were interpreted separately. Candidates can overlap or miss connections across boundaries. No cross-batch synthesis or summary-baseline comparison was run.', '',
      ...outputs.flatMap(item => [`## Batch ${item.ordinal}`, '', extractionMarkdown(item.value), '']),
      '## Original reference map', '', 'References identify indexed original records, not standalone proof of the model\'s interpretation.',
      ...job.capture.originals.map(item => `- ${item.ref}: indexed entry ${item.id}; session ${job.capture.sessionId}; captured identity ${item.identity.slice(0, 16)}.`), '',
      '## Usage receipts', '', 'Provider-reported usage / catalog estimates, not an invoice. Missing usage is unknown, not zero.', '',
      '```json', JSON.stringify(usage.map(item => ({ attempt: item.id, status: item.status, accounting: item.usage_json ? JSON.parse(item.usage_json) : 'unknown' })), null, 2), '```', '',
    ].join('\n');
  } catch (error) {
    store.prepare('UPDATE workflow_pilot_jobs SET status=? WHERE id=?').run(signal.aborted ? 'cancelled' : 'failed', job.id);
    throw error;
  }
}
