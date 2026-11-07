import fs from 'fs';
import path from 'path';

/** Run npm's JS entry under the current Node, never a Windows command shim or
 * a shell command. Paths with spaces/metacharacters remain individual argv. */
export function npmCli(env: NodeJS.ProcessEnv = process.env, node = process.execPath): string {
  const candidates = [env.npm_execpath,
    path.join(path.dirname(node), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(node), '../lib/node_modules/npm/bin/npm-cli.js')];
  for (const directory of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of ['npm', 'npm.cmd']) {
      try {
        const file = fs.realpathSync(path.join(directory, name));
        candidates.push(file, path.join(path.dirname(file), 'node_modules/npm/bin/npm-cli.js'),
          path.join(directory, 'node_modules/npm/bin/npm-cli.js'));
      } catch { /* Try the other known npm installation layouts. */ }
    }
  }
  const found = candidates.find(file => {
    try { return file && path.basename(file) === 'npm-cli.js' && fs.statSync(file).isFile(); } catch { return false; }
  });
  if (!found) throw new Error('npm was not found. Install Node.js 22.19+ with npm, then run setup again.');
  return found;
}
