import fs from 'node:fs';
import path from 'node:path';
import { realtimeRoot, nativeStatus } from './native.mjs';
import { createProbeServer } from './probe-server.mjs';

process.umask(0o077);
let browser, lab, stopping = false;
const onSignal = signal => {
  if (stopping) return; stopping = true;
  void Promise.allSettled([browser?.close(), lab?.close()]).then(() => process.exit(signal === 'SIGINT' ? 130 : 143));
};
process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
try {
  const flags = process.argv.slice(2);
  if (flags.length !== 1 || !['--check', '--allow-provider'].includes(flags[0])) throw new Error('Use --check, or explicitly --allow-provider for one bounded synthetic audio test.');
  const status = await nativeStatus();
  if (flags[0] === '--check') console.log(JSON.stringify(status, null, 2));
  else {
    if (!status.readyForProbe) throw new Error('Native ChatGPT sign-in is missing or the pinned helper is unavailable. Run npm run voice:realtime:setup, then npm run voice:realtime:login. No provider request was made.');
    const { chromium } = await import('@playwright/test');
    lab = await createProbeServer(); browser = await chromium.launch();
    const context = await browser.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${lab.token}` } });
    // Do not let page HTTP requests carry the lab credential to any other origin.
    await context.route('**/*', route => new URL(route.request().url()).origin === lab.origin ? route.continue() : route.abort());
    const page = await context.newPage(); const pageErrors = [];
    page.on('pageerror', () => pageErrors.push('Browser runtime error.'));
    await page.goto(lab.origin); await page.getByRole('button', { name: 'Run synthetic call' }).click();
    await page.waitForFunction(() => window.voiceResult?.completed, {}, { timeout: 85_000 });
    const result = await page.evaluate(() => window.voiceResult);
    result.errors.push(...pageErrors);
    result.success = result.success && result.localCleanup && result.helperCleanup && result.questions.length === 2 && result.audioFrames > 10 && !result.errors.length;
    result.audioVerified = result.success;
    result.authentication = 'native-chatgpt-only'; result.syntheticOnly = true;
    result.interruptionVerified = false; result.realSyncVerified = false; result.quotaAccountingKnown = false;
    const dir = path.join(realtimeRoot, 'reports'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const report = path.join(dir, `voice-${Date.now()}.json`); fs.writeFileSync(report, JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ success: result.success, setupMs: result.setupMs, spokenTurns: result.questions.length,
      receivedAudioFrames: result.audioFrames, transcripts: result.transcripts.length, localCleanup: result.localCleanup, helperCleanup: result.helperCleanup, report }, null, 2));
    if (!result.success) process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await browser?.close(); await lab?.close(); process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); }
