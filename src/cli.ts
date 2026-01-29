#!/usr/bin/env node

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Handle --version and --help before anything else
const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'));
  console.log(`draken v${pkg.version}`);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'));
  console.log(`
  Draken v${pkg.version} - Claude Code Dashboard

  Usage: draken [options]

  Options:
    -v, --version    Show version
    -h, --help       Show this help

  Environment Variables:
    DRAKEN_USERNAME     Username for dashboard auth
    DRAKEN_PASSWORD     Password for dashboard auth
    DRAKEN_JWT_SECRET   Secret for JWT tokens
    DRAKEN_NO_AUTH      Set to 'true' to disable auth
    DRAKEN_PORT         Server port (default: 40333)
    DRAKEN_DATA_DIR     Data directory (default: ~/.draken)

  Claude Authentication (one required):
    ANTHROPIC_API_KEY   API key for Claude
    - or run: claude login

  Examples:
    DRAKEN_NO_AUTH=true draken
    DRAKEN_USERNAME=admin DRAKEN_PASSWORD=secret DRAKEN_JWT_SECRET=xyz draken
`);
  process.exit(0);
}

// Check for required environment variables
const noAuth = process.env.DRAKEN_NO_AUTH === 'true';
if (!noAuth) {
  const required = ['DRAKEN_USERNAME', 'DRAKEN_PASSWORD', 'DRAKEN_JWT_SECRET'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    console.log('\n  Draken - Claude Code Dashboard\n');
    console.log('  Authentication is required. Set these environment variables:');
    missing.forEach(key => console.log(`    - ${key}`));
    console.log('\n  Or disable auth for local development:');
    console.log('    DRAKEN_NO_AUTH=true npx draken\n');
    process.exit(1);
  }
}

// Check for Claude authentication
const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const hasOAuth = fs.existsSync(path.join(claudeConfigDir, '.credentials.json'));
const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

if (!hasOAuth && !hasApiKey) {
  console.log('\n  Draken - Claude Code Dashboard\n');
  console.log('  Claude authentication required. Choose one:');
  console.log('    1. Run: claude login');
  console.log('    2. Set: ANTHROPIC_API_KEY=your-key\n');
  process.exit(1);
}

// Import and start the server
import('./server');
