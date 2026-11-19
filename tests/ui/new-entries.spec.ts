import { test, expect } from '@playwright/test';

for (const newEntries of [1253, 0, undefined]) {
  test(`Home headlines new entries, not the carried backlog (${newEntries})`, async ({ page }) => {
    let mutations = 0;
    page.on('request', request => { if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method())) mutations++; });
    await page.route('**/api/home', route => route.fulfill({ json: {
      syncs: [], available: 25592, new_entries: newEntries, included_unreviewed: 0, covered: 619,
      busy: false, active_call: false, next_cursor: null,
    } }));
    await page.goto('/');
    await expect(page.getByLabel('New activity')).toHaveText(`${newEntries ?? '—'} new entries to prepare`);
    await expect(page.getByLabel('New activity')).not.toContainText('25592');
    await expect(page.getByLabel('Sync tracking')).not.toBeVisible();
    await expect(page.getByText('New entries have not been included in an earlier sync.', { exact: false })).not.toBeVisible();
    await page.getByLabel('About activity and preparation', { exact: true }).click();
    await expect(page.getByText('completed preparation is reused.', { exact: false })).toBeVisible();
    await expect(page.getByLabel('Sync tracking')).toContainText(`${newEntries === undefined ? '—' : 25592 - newEntries} carried forward, unreviewed`);
    await expect(page.getByLabel('Sync tracking')).toContainText('619 reviewed');
    await expect(page.getByText('Review is manual.', { exact: false })).toBeVisible();
    await page.waitForTimeout(4200);
    expect(mutations).toBe(0);
  });
}
