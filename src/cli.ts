#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { startServer } from './server';

const version = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version;
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log(`draken ${version}`);
} else if (args.includes('--help') || args.includes('-h')) {
  console.log(`Draken ${version} — sync across your pi sessions

Usage: draken [--help | --version]

Local loopback use needs no dashboard login or auth environment variables.
LAN/remote bindings require authentication.

DRAKEN_NO_AUTH=false            Require login even on loopback
DRAKEN_USERNAME / DRAKEN_PASSWORD / DRAKEN_JWT_SECRET
                               Dashboard authentication
DRAKEN_HOST                    Bind address (default: 127.0.0.1)
DRAKEN_PORT                    Port (default: 40333)
DRAKEN_DATA_DIR                Local state (default: ~/.draken)
DRAKEN_PI_SESSIONS_DIR         Source logs (default: ~/.pi/agent/sessions)
DRAKEN_PI_BIN                  pi executable (default: pi)
DRAKEN_PI_SUMMARY_MODEL        Summary model (default: openai/gpt-6-luna)
DRAKEN_PI_FINAL_MODEL          Final model (default: openai/gpt-6-astra)
DRAKEN_PI_MODEL                Legacy final-model fallback
DRAKEN_PI_TIMEOUT_MS           Model request timeout (default: 180000)

Indexing and evidence review work without pi installed. Briefing/discussion require
pi 1.4+ configured with a model and credentials. No tasks are executed.
`);
} else if (args.length) {
  console.error(`Unknown arguments: ${args.join(' ')}. Use --help.`);
  process.exitCode = 1;
} else {
  try { startServer(); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
