import fs from 'node:fs';
import path from 'node:path';
import { realtimeRoot, nativeStatus, stopNativeChecks } from './native.mjs';
import { createProbeServer } from './probe-server.mjs';

process.umask(0o077);
let browser, lab, browserClosing, checksClosing;
const controller = new AbortController();
const { signal } = controller;
const hold = setInterval(() => {}, 1000);
const stopChecks = () => {
  if (!checksClosing) { checksClosing = stopNativeChecks(); checksClosing.catch(() => {}); }
  return checksClosing;
};
const closeBrowser = () => {
  if (browser && !browserClosing) { browserClosing = browser.close(); browserClosing.catch(() => {}); }
  return browserClosing;
};
const onSignal = name => {
  if (signal.aborted) return;
  process.exitCode = name === 'SIGINT' ? 130 : 143;
  controller.abort();
  void stopChecks(); void closeBrowser(); void lab?.close().catch(() => {});
};
const active = () => { if (signal.aborted) throw new Error('Native voice probe cancelled.'); };
process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
try {
  const flags = process.argv.slice(2);
  if (flags.length !== 1 || !['--check', '--allow-provider'].includes(flags[0])) throw new Error('Use --check, or explicitly --allow-provider for one bounded synthetic audio test.');
  const status = await nativeStatus({ signal });
  active();
  if (flags[0] === '--check') console.log(JSON.stringify(status, null, 2));
  else {
    if (!status.readyForProbe) throw new Error('Native ChatGPT sign-in is missing or the pinned helper is unavailable. Run npm run voice:realtime:setup, then npm run voice:realtime:login. No provider request was made.');
    const { chromium } = await import('@playwright/test');
    active();
    lab = await createProbeServer();
    active();
    browser = await chromium.launch();
    active();
    const context = await browser.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${lab.token}` } });
    if (signal.aborted) { await context.close(); active(); }
    // Do not let page HTTP requests carry the lab credential to any other origin.
    await context.route('**/*', route => new URL(route.request().url()).origin === lab.origin ? route.continue() : route.abort());
    active();
    const page = await context.newPage(); const pageErrors = [];
    active();
    page.on('pageerror', () => pageErrors.push('Browser runtime error.'));
    await page.goto(lab.origin);
    active();
    await page.getByRole('button', { name: 'Run synthetic call' }).click();
    active();
    await page.waitForFunction(() => window.voiceResult?.completed, {}, { timeout: 85_000 });
    active();
    const result = await page.evaluate(() => window.voiceResult);
    active();
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
} catch (error) { console.error(signal.aborted ? 'Native voice probe cancelled.' : error.message); if (!signal.aborted) process.exitCode = 1; }
finally {
  const warning = setTimeout(() => console.error('Native probe cleanup is still pending. Keeping this terminal host alive.'), 10_000);
  const results = await Promise.allSettled([stopChecks(), closeBrowser(), lab?.close()]);
  clearTimeout(warning);
  if (results.some(result => result.status === 'rejected')) {
    process.exitCode = 1;
    console.error('Native probe cleanup could not be confirmed. Keeping this terminal host alive; no further operation will start.');
    await new Promise(() => {});
  }
  clearInterval(hold);
  process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
}
