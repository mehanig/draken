import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativePeer } from './native-fixture';

async function inventory(page: Page) {
  const value = await (await page.request.get('/api/overview')).json();
  expect(path.basename(path.dirname(value.session_root))).toMatch(/^draken-browser-/);
  return value;
}

async function openSources(page: Page) {
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByText('Agents & sessions', { exact: true }).click();
  return dialog;
}

test('a queued close event cannot dismiss a newly reopened settings dialog', async ({ page }) => {
  await page.goto('/');
  const trigger = page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  for (let cycle = 0; cycle < 3; cycle++) {
    await trigger.click(); await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter'); await expect(dialog).toBeVisible();
    // Native close events are queued: the previous close can arrive after showModal().
    await dialog.evaluate(element => element.dispatchEvent(new Event('close')));
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close settings' }).click();
    await expect(dialog).not.toBeVisible();
  }
});

test('settings inventory shows recorded sources; scan, selection and missing-source states remain explicit', async ({ page }) => {
  await nativePeer(page);
  const before = await inventory(page), homeBefore = await (await page.request.get('/api/home')).json();
  await page.request.patch('/api/settings/auto-index', { data: { enabled: false } });
  const id = randomUUID(), timestamp = new Date().toISOString(), file = path.join(before.session_root, `${id}.jsonl`);
  const malformed = path.join(before.session_root, 'inventory-malformed.jsonl');
  const content = [
    { type: 'session', version: 3, id, timestamp, cwd: '/synthetic/settings-inventory/project-with-a-long-workspace-name' },
    { type: 'session_info', id: 'label', name: 'Inventory fixture', timestamp },
    { type: 'message', id: 'message', parentId: null, timestamp, message: { role: 'user', content: 'Inspect these synthetic session sources; deployment not checked.' } },
  ].map(JSON.stringify).join('\n') + '\n';
  fs.writeFileSync(file, content); fs.writeFileSync(malformed, '{invalid}\n');
  const mutations: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET') mutations.push(new URL(request.url()).pathname); });
  try {
    await page.goto('/'); const dialog = await openSources(page), pi = dialog.getByRole('region', { name: 'pi', exact: true });
    const scan = dialog.getByRole('button', { name: 'Scan enabled agents', exact: true });
    await expect(pi.getByText(before.session_root, { exact: true })).toBeVisible(); await expect(scan).toBeEnabled();
    const row = pi.locator('.session-source').filter({ hasText: id });
    await expect(row).toHaveCount(0); expect(mutations).toEqual([]);
    await expect(dialog.getByRole('switch', { name: 'Enable Claude Code history' })).not.toBeChecked();
    await expect(dialog.getByRole('switch', { name: 'Enable Codex CLI history' })).not.toBeChecked();
    await expect(dialog).toContainText('Directory presence is not an installation check');
    await scan.click(); await expect(row).toBeVisible();
    await expect(row).toContainText('Inventory fixture'); await expect(row).toContainText(file);
    await expect(row).toContainText('/synthetic/settings-inventory/project-with-a-long-workspace-name');
    await expect(row).toContainText('Last recorded change:'); await expect(row).toContainText('1 unreviewed entry');
    await expect(dialog.getByRole('list', { name: 'Scan warnings' })).toContainText('inventory-malformed.jsonl');
    const selected = row.getByRole('checkbox'); await expect(selected).toBeChecked(); await expect(selected).toBeEnabled();
    await selected.uncheck(); await expect(row).toContainText('Excluded');
    await expect.poll(async () => (await inventory(page)).sessions.find((session: any) => session.id === id).included).toBe(0);
    await expect(selected).toBeEnabled(); await selected.check();
    await expect.poll(async () => (await inventory(page)).sessions.find((session: any) => session.id === id).included).toBe(1);
    await expect(scan).toBeEnabled(); fs.renameSync(file, file + '.hidden'); await scan.click();
    await expect(row).toContainText('unavailable at last scan'); await expect(selected).toBeDisabled();
    fs.renameSync(file + '.hidden', file); await expect(scan).toBeEnabled(); await scan.click(); await expect(selected).toBeEnabled();
    await expect(row).not.toContainText('unavailable at last scan');
    await page.setViewportSize({ width: 320, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await row.scrollIntoViewIfNeeded(); await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeInViewport();
    await page.screenshot({ path: '.test-artifacts/settings-sources-mobile.png' });
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
    const homeAfter = await (await page.request.get('/api/home')).json();
    expect(homeAfter.syncs.map((sync: any) => sync.id)).toEqual(homeBefore.syncs.map((sync: any) => sync.id)); expect(homeAfter.covered).toBe(homeBefore.covered);
    expect(mutations).toEqual(['/api/scan', `/api/sessions/${id}`, `/api/sessions/${id}`, '/api/scan', '/api/scan']);
    expect(await page.evaluate(() => (window as any).__captures)).toBe(0);
  } finally {
    if (fs.existsSync(file + '.hidden')) fs.renameSync(file + '.hidden', file);
    fs.rmSync(malformed, { force: true });
  }
});

test('source settings handle an empty inventory, failed changes and foreground work without claiming other agents are connected', async ({ page }) => {
  await nativePeer(page); const before = await inventory(page), home = await (await page.request.get('/api/home')).json();
  let sessions: any[] = [], busy = false, reads = 0;
  await page.route('**/api/overview', route => { reads++; return route.fulfill({ json: { ...before, sessions, session_root: '/synthetic/pi/sessions' } }); });
  await page.route('**/api/home', route => route.fulfill({ json: { ...home, busy, active_call: false } }));
  await page.route('**/api/scan', route => route.fulfill({ status: 503, json: { error: 'Synthetic scan failure' } }));
  await page.route('**/api/sessions/settings-fixture', route => route.fulfill({ status: 503, json: { error: 'Synthetic selection failure' } }));
  await page.goto('/'); const dialog = await openSources(page), scan = dialog.getByRole('button', { name: 'Scan enabled agents' });
  const reopen = async () => {
    await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); const previous = reads;
    await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click(); await expect.poll(() => reads).toBeGreaterThan(previous);
  };
  await expect(dialog).toContainText('No pi sessions recorded yet.'); await expect(scan).toBeEnabled();
  await scan.click(); await expect(dialog.getByRole('alert')).toHaveText('Synthetic scan failure');
  await reopen(); await expect(dialog.getByRole('alert')).toHaveText('Synthetic scan failure');
  sessions = [{ id: 'settings-fixture', agent: 'pi', external_id: 'settings-fixture', name: 'Synthetic session', cwd: '/synthetic/work', path: '/synthetic/pi/sessions/fixture.jsonl', included: 1, missing: 0, pending: 2, modified_at: new Date().toISOString() }];
  await reopen(); const selected = dialog.getByRole('checkbox'); await expect(selected).toBeEnabled(); await selected.click();
  await expect(dialog.getByRole('alert')).toHaveText('Synthetic selection failure'); await expect(selected).toBeChecked();
  await reopen(); await expect(dialog.getByRole('alert')).toHaveText('Synthetic selection failure'); await expect(selected).toBeChecked();
  busy = true; await reopen(); await expect(scan).toBeDisabled(); await expect(selected).toBeDisabled();
  await expect(dialog).toContainText('Source changes are paused');
  await expect(dialog.getByRole('switch', { name: 'Enable Codex CLI history' })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__captures)).toBe(0);
});

test('Codex and Claude history opt-ins persist and scan real synthetic transcripts without starting summaries or capture', async ({ page }) => {
  await nativePeer(page); const before = await inventory(page), home = await (await page.request.get('/api/home')).json();
  const { codexLog, claudeLog } = require('../fixtures/agent-logs.cjs');
  for (const id of ['codex', 'claude']) {
    const directory = before.agents.find((agent: any) => agent.id === id).roots[0].path;
    expect(path.dirname(directory)).toBe(path.dirname(before.session_root));
    fs.writeFileSync(path.join(directory, 'multi-agent-ui.jsonl'), (id === 'codex' ? codexLog('multi-agent-ui') : claudeLog('multi-agent-ui')).map(JSON.stringify).join('\n') + '\n');
    await page.request.patch(`/api/agents/${id}`, { data: { enabled: false } });
  }
  try {
    await page.goto('/'); let dialog = await openSources(page);
    for (const name of ['Codex CLI', 'Claude Code']) {
      const region = dialog.getByRole('region', { name, exact: true }), toggle = region.getByRole('switch');
      await expect(toggle).toBeEnabled(); await expect(toggle).not.toBeChecked(); await expect(region.locator('.session-source')).toHaveCount(0);
      await toggle.check(); await expect.poll(async () => (await inventory(page)).agents.find((agent: any) => agent.name === name).enabled).toBe(true);
    }
    expect((await inventory(page)).sessions.filter((session: any) => session.agent !== 'pi')).toHaveLength(0);
    await page.reload(); dialog = await openSources(page);
    await expect(dialog.getByRole('switch', { name: 'Enable Codex CLI history' })).toBeChecked(); await expect(dialog.getByRole('switch', { name: 'Enable Claude Code history' })).toBeChecked();
    await dialog.getByRole('button', { name: 'Scan enabled agents' }).click();
    for (const name of ['Codex CLI', 'Claude Code']) await expect(dialog.getByRole('region', { name, exact: true }).locator('.session-source')).toHaveCount(1);
    const codex = dialog.getByRole('region', { name: 'Codex CLI', exact: true });
    await codex.getByRole('checkbox').uncheck(); await expect.poll(async () => (await inventory(page)).sessions.find((session: any) => session.id === 'codex:multi-agent-ui').included).toBe(0);
    await expect(codex.getByRole('switch')).toBeEnabled(); await codex.getByRole('switch').uncheck(); await expect(codex.getByRole('checkbox')).toBeDisabled();
    const after = await (await page.request.get('/api/home')).json(); expect(after.syncs.map((sync: any) => sync.id)).toEqual(home.syncs.map((sync: any) => sync.id)); expect(after.covered).toBe(home.covered);
    expect(await page.evaluate(() => (window as any).__captures)).toBe(0);
  } finally { for (const id of ['codex', 'claude']) await page.request.patch(`/api/agents/${id}`, { data: { enabled: false } }); }
});
