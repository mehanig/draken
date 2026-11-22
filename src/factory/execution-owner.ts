import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../data-dir';
import { HttpError } from '../errors';
let owner: string | null = null;
export function claimFactoryExecution(id: string): () => void {
  if (owner) throw new HttpError(409, 'A Factory execution is already active.');
  for (const folder of ['factory-runs', 'factory-workspaces']) {
    const root = path.join(getDataDir(), folder); if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root).filter(name => /^[a-f0-9-]{36}$/.test(name))) {
      const dir = path.join(root, entry), result = path.join(dir, 'work/result.json');
      if (!fs.existsSync(path.join(dir, 'request.json'))) continue;
      if (fs.existsSync(result)) {
        let status: unknown; try { status = JSON.parse(fs.readFileSync(result, 'utf8')).status; } catch {}
        if (!['completed', 'blocked', 'failed', 'cancelled'].includes(String(status))) throw new HttpError(409, 'A Factory run needs cleanup or inspection.');
        continue;
      }
      const exit = fs.existsSync(path.join(dir, 'exit.json'));
      const resources = fs.existsSync(path.join(dir, 'work/resources.json')) || fs.existsSync(path.join(dir, 'work/claim.json'));
      let cleaned = false;
      try { cleaned = JSON.parse(fs.readFileSync(path.join(dir, 'work/cleanup.json'), 'utf8')).completed === true; } catch {}
      if (!exit || (resources && !cleaned)) throw new HttpError(409, 'A Factory run is active or needs inspection.');
    }
  }
  owner = id; return () => { if (owner === id) owner = null; };
}
