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
  await expect(details).toContainText('Settings → Automatically prepare history');
  await expect(details).toContainText('local indexing followed by paid summary caching');
  await expect(details).toContainText('idle minute checks, including small tails');
  await expect(details).toContainText('Saved opt-outs are preserved');
  await expect(details).toContainText('paid failures require an explicit retry');
  await expect(details).toContainText('No background option creates a sync, starts audio, edits originals or notes, or marks work reviewed');
  await expect(details).toContainText('Settings → Preparation usage');
  await expect(details).toContainText('including past automatic work, retries and failed work');
  await expect(details).toContainText('Not total spending, a provider invoice or account quota');
  await expect(details).toContainText('Chat, voice, standalone post-conversation recaps and local machine/network costs are excluded');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await details.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(details).not.toHaveAttribute('open', '');
  expect(mutations).toBe(0);
});
