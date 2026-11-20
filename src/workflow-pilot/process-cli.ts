import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDataDir } from '../data-dir';
import { privateDirectory } from '../pi/runtime';
import { defaultModels } from '../sync/models';
import { invokePi } from '../sync/pi';
import { initProcessSchema } from '../db/process-schema';
import { capturePilot } from './evidence-host';
import { summarizeProcessSample, compareProcessSamples, PROCESS_PILOT_LIMIT } from './process';

export async function processPilot(args: string[]): Promise<void> {
  if (!args.length || args.includes('--help')) {
    console.log(`Process summarization v2 experiment (no background enablement)
  draken process-pilot --session ID --before ISO_DATE [--records 24] [--model MODEL] [--run]
  draken process-pilot --compare EXTRACTION:FRAGMENT EXTRACTION:FRAGMENT [--model MODEL] [--run]
Without --run, only print the selection. Source database is read-only.
Private store: workflow-pilot/process-v2.sqlite. ${PROCESS_PILOT_LIMIT} invocations TOTAL, including failures.
The previous process.sqlite is preserved unchanged; v1 artifacts are not reused as v2.
No automatic retry, reset, --all, execution, or raw-transcript storage. A runtime may make
additional provider requests internally; this is not a dollar cap.
Summary output and process facts are generated together. Comparison is a separate call.
Episode rows are explicitly marked fragments, not automatically reconciled workflows.`);
    return;
  }
  const options = new Map<string, string>(); let run = false; let compare: string[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--run' && !run) run = true;
    else if (arg === '--compare' && !compare && args[i + 1] && args[i + 2]) compare = [args[++i], args[++i]];
    else if (['--session', '--before', '--records', '--model'].includes(arg) && !options.has(arg) && args[i + 1] && !args[i + 1].startsWith('--')) options.set(arg, args[++i]);
    else throw Error('Unknown, duplicate or incomplete process-pilot option');
  }
  if (compare ? ['--session', '--before', '--records'].some(k => options.has(k)) : !options.has('--session') || !options.has('--before')) throw Error('Select a session and fixed cutoff OR two process fragments');
  const model = options.get('--model') || defaultModels().summary;
  if (!model.trim() || model.length > 200) throw Error('Invalid model');
  const source = new Database(path.join(getDataDir(), 'draken.db'), { readonly: true, fileMustExist: true });
  let lock: Database.Database | undefined, store: Database.Database | undefined;
  const controller = new AbortController(), stop = () => controller.abort();
  try {
    source.pragma('query_only = ON');
    const capture = compare ? undefined : capturePilot(source, options.get('--session')!, Number(options.get('--records') || 24), options.get('--before')!);
    const selections = compare?.map(s => { const at = s.indexOf(':'); if (at < 1 || at === s.length - 1) throw Error('Expected EXTRACTION:FRAGMENT'); return { extraction: s.slice(0, at), fragment: s.slice(at + 1) }; });
    console.log(JSON.stringify(capture ? { model, refs: capture.originals.map(o => o.ref), cutoff: capture.before, omitted: capture.omittedRecords } : { model, selections }, null, 2));
    if (!run) { console.log('No model call. Add --run to process this selection.'); return; }
    const dir = path.join(getDataDir(), 'workflow-pilot'); privateDirectory(dir, true);
    for (const name of ['process-v2-owner.sqlite', 'process-v2.sqlite']) {
      const file = path.join(dir, name);
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw Error('Process store must not be a symlink');
      fs.closeSync(fs.openSync(file, 'a', 0o600)); fs.chmodSync(file, 0o600);
    }
    lock = new Database(path.join(dir, 'process-v2-owner.sqlite')); lock.pragma('busy_timeout = 0');
    try { lock.exec('BEGIN EXCLUSIVE'); } catch { throw Error('Another process experiment owns this store'); }
    store = new Database(path.join(dir, 'process-v2.sqlite')); store.pragma('foreign_keys = ON'); initProcessSchema(store);
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const ask = (prompt: string, request: Parameters<typeof invokePi>[1]) => invokePi(prompt, { ...request, timeoutMs: 180000 });
    const result = capture
      ? await summarizeProcessSample(source, store, capture, model, ask, controller.signal)
      : await compareProcessSamples(source, store, selections!, model, ask, controller.signal);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    store?.close(); lock?.close(); source.close();
  }
}
