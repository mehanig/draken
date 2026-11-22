import { test, expect } from '@playwright/test';

test('sessions flow with the page and ignored rows have a read-only keyboard toggle', async ({ page }) => {
  const overview = await (await page.request.get('/api/overview')).json();
  const session = (id: string, extra = {}) => ({
    id, external_id: id, agent: 'pi', name: id, cwd: '/synthetic/session-list',
    path: `/synthetic/session-list/${id}.jsonl`, included: 1, missing: 0,
    within_activity_window: true, pending: 1, first_message_at: '2026-01-01T12:00:00Z',
    last_message_at: '2026-01-02T12:00:00Z', last_message_preview: 'Synthetic recorded message.', ...extra,
  });
  const sessions = [
    ...Array.from({ length: 30 }, (_, index) => session(`active-${index}`)),
    session('excluded', { included: 0 }), session('missing', { missing: 1 }),
    session('aged', { within_activity_window: false }),
    session('undated', { within_activity_window: false, last_message_at: null }),
    session('disabled-agent', { agent: 'codex' }),
  ];
  await page.route('**/api/overview', route => route.fulfill({ json: {
    ...overview, sessions, agents: overview.agents.map((agent: any) => ({ ...agent, enabled: agent.id === 'pi' })),
  } }));
  const mutations: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method())) mutations.push(request.url()); });
  await page.goto('/settings');
  await page.getByText('Agents & sessions', { exact: true }).click();
  const pi = page.getByRole('region', { name: 'pi', exact: true });
  const list = pi.locator('.session-list');
  const rows = pi.locator('.session-source');
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(rows).toHaveCount(30);
    await expect(pi.locator('.session-ignored')).toHaveCount(0);
    const show = pi.getByRole('button', { name: 'Show ignored sessions', exact: true });
    await expect(show).toHaveAttribute('aria-expanded', 'false');
    await expect(show).toHaveAttribute('aria-controls', await list.getAttribute('id') as string);
    expect(await list.evaluate(element => ({ overflow: getComputedStyle(element).overflowY, maxHeight: getComputedStyle(element).maxHeight, fits: element.scrollHeight <= element.clientHeight + 1 }))).toEqual({ overflow: 'visible', maxHeight: 'none', fits: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight > innerHeight)).toBe(true);
    await show.focus(); await page.keyboard.press('Enter');
    await expect(rows).toHaveCount(34);
    await expect(pi.locator('.session-ignored')).toHaveCount(4);
    const hide = pi.getByRole('button', { name: 'Hide ignored sessions', exact: true });
    await expect(hide).toHaveAttribute('aria-expanded', 'true');
    await page.waitForTimeout(4200);
    await expect(rows).toHaveCount(34);
    const bounds = await list.boundingBox(), button = await hide.boundingBox();
    expect(button!.y).toBeGreaterThanOrEqual(bounds!.y + bounds!.height);
    await hide.focus(); await page.keyboard.press('Space');
    await expect(rows).toHaveCount(30);
  }
  const codex = page.getByRole('region', { name: 'Codex CLI', exact: true });
  await expect(codex.locator('.session-source')).toHaveCount(0);
  await codex.getByRole('button', { name: 'Show ignored sessions', exact: true }).click();
  await expect(codex.locator('.session-source')).toContainText('Agent disabled');
  await expect(codex.getByRole('checkbox', { name: /^Include disabled-agent/ })).toBeDisabled();
  await expect(pi.locator('.session-source')).toHaveCount(30);
  await expect(page.getByRole('region', { name: 'Claude Code', exact: true }).getByRole('button', { name: 'Show ignored sessions', exact: true })).toHaveCount(0);
  expect(mutations).toEqual([]);
});
