import fs from 'node:fs';
import path from 'node:path';
import { digest } from '../sync/normalize';
import type { WorkflowLocation } from './types';

/** Inspect Git metadata only: no commands, hooks, remote URLs or project-name guesses. */
export function workflowLocation(workspace: string): WorkflowLocation {
  const location = (kind: WorkflowLocation['kind'], directory: string, identity = directory): WorkflowLocation =>
    ({ kind, key: digest(JSON.stringify([kind, identity])), path: directory, name: path.basename(directory) || directory });
  const smallFile = (file: string) => {
    if (fs.statSync(file).size > 4096) throw Error('Git metadata file is too large');
    return fs.readFileSync(file, 'utf8').trim();
  };
  try {
    if (!path.isAbsolute(workspace)) throw Error('Working folder is not absolute');
    const folder = fs.realpathSync(workspace);
    if (!fs.statSync(folder).isDirectory()) throw Error('Working folder is not a directory');
    for (let directory = folder; ; directory = path.dirname(directory)) {
      const marker = path.join(directory, '.git');
      let stat: fs.Stats | undefined;
      try { stat = fs.lstatSync(marker); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (stat) {
        let git = marker;
        if (stat.isFile()) {
          const value = smallFile(marker);
          if (!value.startsWith('gitdir: ')) throw Error('Invalid Git directory pointer');
          git = path.resolve(directory, value.slice(8));
        } else if (!stat.isDirectory()) throw Error('Unsupported Git marker');
        git = fs.realpathSync(git);
        if (!fs.statSync(path.join(git, 'HEAD')).isFile()) throw Error('Missing Git HEAD');
        let shared: string | undefined;
        try { shared = smallFile(path.join(git, 'commondir')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const common = shared === undefined ? git : fs.realpathSync(path.resolve(git, shared));
        if (!fs.statSync(path.join(common, 'objects')).isDirectory()) throw Error('Missing Git objects');
        const root = path.basename(common) === '.git' ? path.dirname(common) : directory;
        const identity = fs.statSync(common);
        return location('repository', root, JSON.stringify([common, identity.dev, identity.ino, identity.birthtimeMs]));
      }
      if (path.dirname(directory) === directory) break;
    }
    return location('folder', folder);
  } catch { return location('unavailable', workspace || 'Unknown location'); }
}
