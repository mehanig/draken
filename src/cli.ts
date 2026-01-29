#!/usr/bin/env node

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import https from 'https';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'));
const currentVersion = pkg.version;

/**
 * Check for updates (non-blocking, cached for 24h)
 */
async function checkForUpdates(): Promise<void> {
  const dataDir = process.env.DRAKEN_DATA_DIR || path.join(os.homedir(), '.draken');
  const cacheFile = path.join(dataDir, '.update-check');
  
  // Check cache (24 hour TTL)
  try {
    if (fs.existsSync(cacheFile)) {
      const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      const age = Date.now() - cache.timestamp;
      if (age < 24 * 60 * 60 * 1000) {
        // Cache still valid
        if (cache.latest && cache.latest !== currentVersion) {
          showUpdateMessage(cache.latest);
        }
        return;
      }
    }
  } catch {}

  // Fetch latest version from npm
  return new Promise((resolve) => {
    const req = https.get('https://registry.npmjs.org/draken/latest', { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const latest = JSON.parse(data).version;
          
          // Save to cache
          if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
          }
          fs.writeFileSync(cacheFile, JSON.stringify({ latest, timestamp: Date.now() }));
          
          if (latest !== currentVersion) {
            showUpdateMessage(latest);
          }
        } catch {}
        resolve();
      });
    });
    
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
  });
}

function showUpdateMessage(latest: string): void {
  console.log(`\n  📦 Update available: ${currentVersion} → ${latest}`);
  console.log(`     Run: npm i -g draken@latest\n`);
}

// Handle --version and --help before anything else
const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(`draken v${currentVersion}`);
  checkForUpdates().then(() => process.exit(0));
} else if (args.includes('--help') || args.includes('-h')) {

} else if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  Draken v${currentVersion} - Claude Code Dashboard

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

// Check for updates in background (non-blocking)
checkForUpdates();

// Import and start the server
import('./server');
