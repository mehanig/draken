import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDataDir } from '../data-dir';
import { privateDirectory } from '../pi/runtime';
import { defaultModels } from '../sync/models';
import { invokePi } from '../sync/pi';
import { initProcessSchema } from '../db/process-schema';
import { evaluateMatchingCase, loadMatchingCases } from './matching';

export async function matchingPilot(args: string[]): Promise<void> {
  if (!args.length || args.includes('--help')) {
    console.log(`Workflow identity evaluation — shared parts do not merge workflows
  draken matching-pilot --cases FILE [--model MODEL] [--run]
Explicit manifest: at most eight historical or clearly labelled synthetic pairs.
Expected results are frozen before inference and are never sent to the model.
Without --run, print the plan only. With --run: at most sixteen invocations TOTAL (two eight-case model runs),
including failures, in workflow-pilot/matching-identity.sqlite (previous results are preserved).
Identity is separate from episode completeness and successful execution. No automatic retries,
no reset, no original-history expansion, no background enablement or execution.
Source permissions/bytes are checked for historical parents before reuse and after
inference. Provider-internal retries mean this is not a dollar/request cap.`);
    return;
  }
  const options = new Map<string, string>(); let run = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--run' && !run) run = true;
    else if (['--cases', '--model'].includes(key) && !options.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) options.set(key, args[++i]);
    else throw Error('Unknown, duplicate or incomplete matching-pilot option');
  }
  if (!options.has('--cases')) throw Error('Select an explicit cases manifest');
  const file = path.resolve(options.get('--cases')!), { manifest, hash } = loadMatchingCases(file);
  const model = options.get('--model') || defaultModels().summary;
  if (!model.trim() || model.length > 200) throw Error('Invalid model');
  console.log(JSON.stringify({ model, manifestHash: hash, cases: manifest.cases.map(c => ({ name: c.name, origin: [c.left.kind, c.right.kind], expected: c.expected })) }, null, 2));
  if (!run) { console.log('No inference started. Add --run to execute this frozen evaluation.'); return; }
  const dir = path.join(getDataDir(), 'workflow-pilot'); privateDirectory(dir, true);
  let store: Database.Database | undefined, lock: Database.Database | undefined;
  const controller = new AbortController(), stop = () => controller.abort();
  try {
    for (const name of ['matching-identity-owner.sqlite', 'matching-identity.sqlite']) {
      const file = path.join(dir, name);
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw Error('Matching store must not be a symlink');
      fs.closeSync(fs.openSync(file, 'a', 0o600)); fs.chmodSync(file, 0o600);
    }
    lock = new Database(path.join(dir, 'matching-identity-owner.sqlite')); lock.pragma('busy_timeout = 0');
    try { lock.exec('BEGIN EXCLUSIVE'); } catch { throw Error('Another matching evaluation owns this store'); }
    store = new Database(path.join(dir, 'matching-identity.sqlite')); store.pragma('foreign_keys = ON'); initProcessSchema(store);
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const results = [];
    for (let i = 0; i < manifest.cases.length; i++) {
      controller.signal.throwIfAborted();
      try {
        const result = await evaluateMatchingCase(store, file, hash, i, model, (prompt, request) => invokePi(prompt, { ...request, timeoutMs: 180000 }), controller.signal);
        results.push(result); console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        if (controller.signal.aborted) throw error;
        const failure = { name: manifest.cases[i].name, passed: false, error: error instanceof Error ? error.message : 'Comparison failed' };
        results.push(failure); console.log(JSON.stringify(failure));
      }
    }
    console.log(JSON.stringify({ passed: results.filter(r => r.passed).length, total: results.length, stopped: true }));
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); store?.close(); lock?.close(); }
}
