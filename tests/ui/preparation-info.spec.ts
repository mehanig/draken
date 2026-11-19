import { test, expect } from '@playwright/test';

test.use({ hasTouch: true });

test('Home keeps optional help closed; keyboard and touch disclosures never start work or capture', async ({ page }) => {
  let mutations = 0;
  page.on('request', request => { if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method())) mutations++; });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => { throw Error('Unexpected microphone capture'); } } });
  });
  await page.setViewportSize({ width: 320, height: 844 }); await page.goto('/');
  const summary = page.getByLabel('About activity and preparation', { exact: true });
  const details = summary.locator('..');
  const explanation = details.getByText('New entries have not been included', { exact: false });
  await expect(details).not.toHaveAttribute('open', '');
  await expect(explanation).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Chat instead', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sync with Draken', exact: true })).toBeVisible();
  await summary.focus(); await page.keyboard.press('Enter');
  await expect(explanation).toBeVisible();
  await expect(details).toContainText('Review is manual');
  await expect(details).toContainText('quota or API billing');
  await expect(details).toContainText('estimates, not invoices or total chat and voice spending');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(details).not.toHaveAttribute('open', ''); await expect(summary).toBeFocused();
  await page.keyboard.press('Space'); await expect(explanation).toBeVisible();
  await page.keyboard.press('Space'); await expect(explanation).not.toBeVisible();
  const box = await summary.boundingBox(); expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
  await summary.tap(); await expect(explanation).toBeVisible();
  await summary.tap(); await expect(explanation).not.toBeVisible();
  await page.screenshot({ path: '.test-artifacts/minimal-home-mobile.png', fullPage: true });
  expect(mutations).toBe(0);
});
