import { test, expect } from '@playwright/test';

test('Home explains compaction and preparation-only estimates without enabling work or capture', async ({ page }) => {
  let mutations = 0;
  page.on('request', request => { if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method())) mutations++; });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => { throw Error('Unexpected microphone capture'); } } });
  });
  await page.setViewportSize({ width: 320, height: 844 }); await page.goto('/');
  const details = page.locator('.home-preparation-info');
  await expect(details).not.toHaveAttribute('open', '');
  await details.locator('summary').click();
  await expect(details).toContainText('Automatic compaction');
  await expect(details).toContainText('off by default');
  await expect(details).toContainText('does not edit or delete original agent logs');
  await expect(details).toContainText('Settings → Preparation usage');
  await expect(details).toContainText('Not total spending, a provider invoice or account quota');
  await expect(details).toContainText('Chat, voice, standalone post-conversation recaps and local machine/network costs are excluded');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await details.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(details).not.toHaveAttribute('open', '');
  expect(mutations).toBe(0);
});
