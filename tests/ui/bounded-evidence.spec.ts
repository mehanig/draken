import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

test('starting and opening chat transfers no originals; citations fetch one excerpt and explicit browsing fetches metadata pages', async ({ page }) => {
  const overview = await (await page.request.get('/api/overview')).json();
  expect(path.basename(path.dirname(overview.session_root))).toMatch(/^draken-browser-/);
  const id = randomUUID(), timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(overview.session_root, id + '.jsonl'), [
    { type: 'session', version: 3, id, timestamp, cwd: '/synthetic/bounded-evidence' },
    ...Array.from({ length: 60 }, (_, i) => ({ type: 'message', id: `${id}-${i}`, parentId: i ? `${id}-${i - 1}` : null, timestamp,
      message: { role: 'assistant', content: `Long original ${i}: ` + 'Source detail; not deployment verification. '.repeat(220) } })),
  ].map(JSON.stringify).join('\n') + '\n');
  const reads: string[] = [], responses: Promise<any>[] = [];
  page.on('request', request => { if (request.url().includes('/evidence?')) reads.push(request.url()); });
  page.on('response', response => {
    if (/\/api\/syncs\/(?:\d+|start-chat)$/.test(new URL(response.url()).pathname)) responses.push(response.json());
  });
  let syncId = 0;
  try {
  await page.goto('/'); await page.getByRole('button', { name: 'Chat instead', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message Draken' })).toBeEnabled({ timeout: 60000 });
  syncId = Number(new URL(page.url()).pathname.split('/')[2]);
  await page.reload(); await expect(page.getByRole('textbox', { name: 'Message Draken' })).toBeEnabled();
  expect(reads).toEqual([]);
  for (const response of await Promise.all(responses)) {
    const sync = response.sync || response;
    expect(sync.items).toEqual([]); expect(sync.context).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(100_000);
  }
  const citation = page.getByRole('button', { name: /^Inspect evidence E\d+$/ }).first();
  await expect(citation).toBeVisible();
  await citation.click(); await expect(page.locator('.evidence-body pre')).toBeVisible();
  expect(reads).toHaveLength(1); expect(reads[0]).toContain('ref=');
  await citation.click(); await expect.poll(() => reads.length).toBe(2);
  await expect(page.locator('.evidence-body pre')).toBeVisible();
  await page.getByRole('button', { name: 'Back to evidence list' }).click();
  await page.getByRole('textbox', { name: 'Filter evidence metadata' }).fill('/synthetic/bounded-evidence');
  const panel = page.getByRole('region', { name: 'Snapshot evidence' });
  await expect(panel.locator('.pagination')).toContainText('60 entries');
  await expect(panel.getByRole('button', { name: /^Read evidence/ })).toHaveCount(25);
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(panel.locator('.pagination')).toContainText('2 / 3');
  const selected = panel.getByRole('button', { name: /^Read evidence/ }).first();
  const selectedRef = (await selected.getAttribute('aria-label'))!.split(' ').pop();
  await selected.click(); await expect(panel.locator('pre')).toBeVisible();
  expect((await panel.locator('pre').textContent())!.length).toBe(4000);
  await panel.getByRole('button', { name: 'Later text' }).click();
  await expect(panel).toContainText('Characters 4001–');
  const expected = await (await page.request.get(`/api/syncs/${syncId}/evidence?ref=${selectedRef}&offset=4000`)).json();
  await expect(panel.locator('pre')).toHaveText(expected.item.text);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { if (syncId) await page.request.post(`/api/syncs/${syncId}/discard`); }
});
