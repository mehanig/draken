import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDataDir } from '../data-dir';
import { privateDirectory } from '../pi/runtime';
import { defaultModels } from '../sync/models';
import { invokePi } from '../sync/pi';
import { capturePilot, listPilotSessions } from './evidence-host';
import { createPilot, initPilotStore, loadPilot, recoverPilotStore, runPilot } from './backfill';

export async function workflowPilot(args: string[]): Promise<void> {
  if (!args.length || args.includes('--help')) {
    console.log(`Workflow identifier pilot — original-based extraction, no execution

  draken workflow-pilot --list
      List permitted indexed session metadata. No model calls or source writes.
  draken workflow-pilot --session ID [--records 16] [--model PROVIDER/MODEL]
      Freeze at most 24 tail records from ONE session and print a pilot ID.
      This captures metadata only. No provider call until --run is supplied.
  draken workflow-pilot --resume PILOT_ID --run [--retry]
      Verify originals and extract at most 8 records per batch; max 3 Pi
      invocations over the lifetime of the pilot, including failed attempts.
      --retry explicitly permits retrying a previously failed/interrupted batch.
      Cached results are reverified before reuse. No automatic retries by the host.

Store/reports: <DRAKEN_DATA_DIR>/workflow-pilot/ (private, separate SQLite).
The source draken.db is opened read-only. Nothing is scanned, imported, reviewed,
published or executed in your repositories. Model inference uses provider quota.
The invocation limit is NOT an exact dollar/provider-request limit; runtime-internal
provider retry/compaction behavior may add requests. Results are a partial sample.
No --all option or background processing. Use --resume for the SAME captured sample.`);
    return;
  }
  const values = new Map<string, string>(), flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (values.has(name) || flags.has(name)) throw new Error('Duplicate pilot option.');
    if (['--list', '--run', '--retry'].includes(name)) flags.add(name);
    else if (['--session', '--records', '--model', '--resume'].includes(name) && args[i + 1] && !args[i + 1].startsWith('--')) values.set(name, args[++i]);
    else throw new Error(`Unknown or incomplete pilot option: ${name}`);
  }
  if (flags.has('--list') && args.length !== 1) throw new Error('--list cannot be combined with extraction options.');
  if (!flags.has('--list') && Boolean(values.get('--session')) === Boolean(values.get('--resume'))) throw new Error('Select exactly one --session or --resume.');
  if (values.has('--resume') && (values.has('--records') || values.has('--model'))) throw new Error('Resume retains the captured model and sample.');
  if (flags.has('--retry') && (!flags.has('--run') || !values.has('--resume'))) throw new Error('--retry requires --resume and --run.');
  const source = new Database(path.join(getDataDir(), 'draken.db'), { readonly: true, fileMustExist: true });
  let lock: Database.Database | undefined, store: Database.Database | undefined;
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Workflow pilot cancelled.'));
  try {
    source.pragma('query_only = ON'); source.pragma('busy_timeout = 5000');
    const schema = source.prepare("SELECT value FROM sync_settings WHERE key='storage_schema'").get() as { value: string } | undefined;
    if (schema?.value !== 'pointer-v2') throw new Error('Pilot requires an already prepared pointer-v2 database; it will not migrate the application.');
    if (flags.has('--list')) { console.log(JSON.stringify(listPilotSessions(source), null, 2)); return; }
    const dir = path.join(getDataDir(), 'workflow-pilot'); privateDirectory(dir, true);
    for (const name of ['owner.sqlite', 'pilot.sqlite']) {
      const file = path.join(dir, name);
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Pilot database must not be a symlink.');
      const fd = fs.openSync(file, 'a', 0o600); fs.closeSync(fd); fs.chmodSync(file, 0o600);
    }
    lock = new Database(path.join(dir, 'owner.sqlite')); lock.pragma('busy_timeout = 0');
    try { lock.exec('BEGIN EXCLUSIVE'); } catch { throw new Error('Another workflow pilot owns this store. Wait for it to stop.'); }
    store = new Database(path.join(dir, 'pilot.sqlite')); store.pragma('foreign_keys = ON'); store.pragma('journal_mode = WAL');
    initPilotStore(store); recoverPilotStore(store);
    const job = values.has('--resume') ? loadPilot(store, values.get('--resume')!) : createPilot(store, source.name,
      capturePilot(source, values.get('--session')!, Number(values.get('--records') || 16), new Date().toISOString()), values.get('--model') || defaultModels().summary);
    console.log(JSON.stringify({ pilot: job.id, model: job.model, session: job.capture.sessionId, cutoff: job.capture.before,
      records: job.capture.originals.length, omitted: job.capture.omittedRecords, maximumPiInvocations: 3, spent: job.calls,
      refs: job.capture.originals.map(item => item.ref) }, null, 2));
    if (!flags.has('--run')) { console.log(`No inference started. Inspect this selection; run: draken workflow-pilot --resume ${job.id} --run`); return; }
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const report = path.join(dir, `pilot-${job.id}.md`);
    if (fs.existsSync(report)) fs.unlinkSync(report);
    const markdown = await runPilot(source, store, job, (prompt, request) => invokePi(prompt, { ...request,
      onAccounting: value => request.onAccounting(value), timeoutMs: 180000 }), controller.signal, flags.has('--retry'));
    controller.signal.throwIfAborted();
    fs.writeFileSync(report, markdown, { flag: 'wx', mode: 0o600 });
    console.log(`Private report: ${report}\nStopped after this sample. No further sessions queued.`);
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    store?.close(); lock?.close(); source.close();
  }
}
