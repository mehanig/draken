#!/usr/bin/env node

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

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
