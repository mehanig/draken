#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { startServer } from './server';
import { serverTarget } from './server-state';
import { probeServer } from './server-status';
import { launchTray } from './tray/launcher';
import { doctor, installPi, loginPi } from './pi/setup';

const version = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version;
const args = process.argv.slice(2);
async function main() {
  if (!args.length) return startServer();
  if (args.length === 1 && args[0] === 'tray') return launchTray();
  if (args.length === 1 && args[0] === '--tray-server' && process.send) return startServer(true);
  if (args.length === 1 && args[0] === '--tray-worker' && process.send) {
    const { runTrayWorker } = await import('./tray/worker');
    return runTrayWorker();
  }
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) { console.log(`draken ${version}`); return; }
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(`Draken ${version} — read-only sync across pi, Codex and Claude sessions

Usage:
  draken                  Start the server in this terminal; Ctrl+C stops it
  draken tray             Background tray companion (macOS / Windows desktop)
  draken status           Find and check this data directory's last server
  draken doctor           Check pi/model credential configuration, without inference
  draken setup [--yes]     Install and select Draken's private, pinned pi runtime
  draken login             Open pi's own /login interface for the selected runtime
  draken voice setup       Install the pinned native voice helper
  draken voice login       Separate official ChatGPT voice sign-in
  draken voice status      Check native helper/sign-in metadata

First use: draken setup → draken login → draken voice setup → draken voice login
Then run draken, open its printed URL, and choose Settings → Agents & sessions.
Existing configured pi works without a private install. No provider authentication
is reimplemented by Draken. Installing the npm package does not start a server.

Run setup/login as the server's user with the same environment:
DRAKEN_DATA_DIR                Private state (default: ~/.draken)
DRAKEN_PI_BIN                  Explicit pi executable; overrides private selection
PI_CODING_AGENT_DIR            Existing/external pi config; managed pi is isolated
DRAKEN_PI_SUMMARY_MODEL        Summary model (default: openai/gpt-6-luna)
DRAKEN_PI_FINAL_MODEL          Final model (default: openai/gpt-6-astra)
DRAKEN_PI_MODEL                Legacy final-model fallback
DRAKEN_PI_SESSIONS_DIR         Pi history source, not the summarization runtime
DRAKEN_CODEX_SESSIONS_DIR / DRAKEN_CLAUDE_SESSIONS_DIR
                               Optional history roots; enable in Settings
DRAKEN_HOST / DRAKEN_PORT      Bind address/port (default: 127.0.0.1:40333)

Loopback needs no dashboard login. LAN bindings require authentication:
DRAKEN_USERNAME / DRAKEN_PASSWORD / DRAKEN_JWT_SECRET; use trusted HTTPS.
DRAKEN_NO_AUTH=false also requires dashboard login on loopback.
Scanning works without pi; summarization needs pi and model credentials.
Native voice has a separate account. No startup action captures audio or calls models.`);
    return;
  }
  if (args[0] === 'setup' && (args.length === 1 || args.length === 2 && args[1] === '--yes')) return installPi(args[1] === '--yes');
  if (args[0] === 'login' && args.length === 1) return loginPi();
  if (args[0] === 'doctor' && args.length === 1) return doctor();
  if (args[0] === 'voice' && args.length === 2) {
    if (args[1] === 'login' && !process.stdin.isTTY) throw new Error('Run draken voice login in an interactive terminal on the server.');
    const { voiceSetup } = require('../voice/realtime/setup.mjs') as { voiceSetup(action: string): Promise<void> };
    return voiceSetup(args[1]);
  }
  if (args[0] === 'status' && args.length === 1) {
    const target = serverTarget(), url = target.url;
    try {
      await probeServer(target);
      console.log(`Draken is responding at ${url}.\nOpen ${target.open}\nThis checks connectivity${target.instance ? ' and the saved server instance' : ''}, not summary/voice readiness. Use draken doctor for pi setup.`);
    } catch { console.error(`Draken was not confirmed at ${url}. It may be stopped, or the saved address belongs to an old instance. Start it with draken, or check the server log. If you use a custom data directory, set DRAKEN_DATA_DIR to the same directory.`); process.exitCode = 1; }
    return;
  }
  throw new Error(`Unknown arguments: ${args.join(' ')}. Use draken --help.`);
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Draken could not complete the command.'); process.exitCode = 1; });
