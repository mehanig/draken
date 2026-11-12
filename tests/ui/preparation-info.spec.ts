import { test, expect } from '@playwright/test';

test('Home separates local indexing from explicit briefing preparation and retained usage without enabling work or capture', async ({ page }) => {
  let mutations = 0;
  page.on('request', request => { if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method())) mutations++; });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => { throw Error('Unexpected microphone capture'); } } });
  });
  await page.setViewportSize({ width: 320, height: 844 }); await page.goto('/');
  const details = page.locator('.home-preparation-info');
  await expect(details).not.toHaveAttribute('open', '');
  await details.locator('summary').click();
  await expect(details).toContainText('Automatic local indexing');
  await expect(details).toContainText('Settings → Automatically index history');
  await expect(details).toContainText('checking once a minute and indexing batches at 64 source changes');
  await expect(details).toContainText('Smaller tails wait for explicit foreground preparation; there is no timed flush');
  await expect(details).toContainText('makes no provider model calls and creates no syncs, summaries or briefings');
  await expect(details).toContainText('Only your Sync with Draken or Chat instead action creates a snapshot');
  await expect(details).toContainText('CPU, memory and disk');
  await expect(details).toContainText('136 MB');
  await expect(details).toContainText('new installations automatically');
  await expect(details).toContainText('Existing installations keep their previous choice, including off');
  await expect(details).toContainText('quota or API billing');
  await expect(details).toContainText('does not edit or delete original agent logs');
  await expect(details).toContainText('Settings → Preparation usage');
  await expect(details).toContainText('including past automatic work, retries and failed work');
  await expect(details).toContainText('existing snapshots or notes');
  await expect(details).toContainText('Not total spending, a provider invoice or account quota');
  await expect(details).toContainText('Chat, voice, standalone post-conversation recaps and local machine/network costs are excluded');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await details.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(details).not.toHaveAttribute('open', '');
  expect(mutations).toBe(0);
});
