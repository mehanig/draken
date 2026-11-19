import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

test('activity window shows ignored sessions, requires confirmation before widening, and applies narrowing immediately', async ({ page }) => {
  const overview = await (await page.request.get('/api/overview')).json();
  expect(path.basename(path.dirname(overview.session_root))).toMatch(/^draken-browser-/);
  const id = randomUUID(), timestamp = new Date(Date.now() - 20 * 86400000).toISOString();
  const file = path.join(overview.session_root, id + '.jsonl');
  fs.writeFileSync(file, [
    { type: 'session', version: 3, id, cwd: '/synthetic/window', timestamp },
    { type: 'message', id: 'm', parentId: null, timestamp, message: { role: 'user', content: 'Old window fixture; deployment not checked.' } },
  ].map(JSON.stringify).join('\n') + '\n');
  await page.request.patch('/api/settings/auto-index', { data: { enabled: false } });
  await page.request.patch('/api/settings/activity-window', { data: { days: 7 } });
  await page.request.post('/api/scan');
  let writes = 0;
  page.on('request', request => { if (request.method() === 'PATCH' && request.url().includes('/settings/activity-window')) writes++; });
  try {
    await page.goto('/'); await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await dialog.getByText('Agents & sessions', { exact: true }).click();
    const select = dialog.getByRole('combobox', { name: 'Session activity window', exact: true });
    const row = dialog.locator('.session-source').filter({ hasText: id });
    await expect(select).toHaveValue('7'); await expect(row).toContainText('Outside activity window');
    await expect(row).toHaveClass(/session-ignored/); await expect(row).toContainText('First message:');
    await expect(row).toContainText('Last message:'); await expect(row).toContainText('Old window fixture');
    page.once('dialog', async confirm => { expect(confirm.message()).toContain('additional discovered sessions'); await confirm.dismiss(); });
    await select.selectOption('30'); await expect(select).toBeEnabled(); await expect(select).toHaveValue('7');
    expect(writes).toBe(0); expect((await (await page.request.get('/api/settings/activity-window')).json()).days).toBe(7);
    page.once('dialog', confirm => confirm.accept()); await select.selectOption('30');
    await expect(select).toHaveValue('30'); await expect(row).not.toHaveClass(/session-ignored/); await expect(row).toContainText('Included');
    expect(writes).toBe(1);
    await select.selectOption('7'); await expect(select).toHaveValue('7'); await expect(row).toContainText('Outside activity window');
    await row.getByRole('checkbox').uncheck(); await expect(row).toContainText('Manually excluded');
    page.once('dialog', confirm => confirm.accept()); await select.selectOption('all');
    await expect(select).toHaveValue('all'); await expect(row).toContainText('Manually excluded'); await expect(row).toHaveClass(/session-ignored/);
    await page.setViewportSize({ width: 320, height: 844 });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await row.scrollIntoViewIfNeeded(); await page.screenshot({ path: '.test-artifacts/activity-window-mobile.png' });
    await page.route('**/api/settings/activity-window', route => route.request().method() === 'PATCH'
      ? route.fulfill({ status: 500, json: { error: 'Synthetic activity-window save failure' } }) : route.continue());
    await select.selectOption('7');
    await expect(dialog.getByRole('alert')).toHaveText('Synthetic activity-window save failure');
    await page.waitForTimeout(4300); // Successful status polling must not hide a failed write.
    await expect(dialog.getByRole('alert')).toHaveText('Synthetic activity-window save failure'); await expect(select).toHaveValue('all');
  } finally {
    await page.request.patch('/api/settings/activity-window', { data: { days: 7 } });
    fs.rmSync(file, { force: true }); await page.request.post('/api/scan');
  }
});
