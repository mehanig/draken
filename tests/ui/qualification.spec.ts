import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

test('real-provider qualification can validate its current-build fixture without a provider or local model', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-qualification-check-'));
  const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: home,
    DRAKEN_CODEX_SESSIONS_DIR: path.join(home, 'codex'), DRAKEN_CLAUDE_SESSIONS_DIR: path.join(home, 'claude') };
  // Keep browser installation discovery, not provider credentials or an alternate client build.
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PLAYWRIGHT_BROWSERS_PATH']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  let fixtureRoot: string | undefined;
  try {
    const { stdout } = await run(process.execPath, ['tests/live-voice-real.cjs', '--check'], { env, timeout: 25000 });
    const result = JSON.parse(stdout.trim());
    fixtureRoot = result.root;
    expect(result.fixtureReady).toBe(true);
    expect(result.providerStarted).toBe(false);
    expect(result.clientBuildHash).toBe(createHash('sha256').update(fs.readFileSync('public/index.html')).digest('hex'));
    expect(fs.existsSync(path.join(fixtureRoot!, 'memory'))).toBe(false);
  } finally {
    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
