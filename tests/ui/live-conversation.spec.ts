import { test, expect, type Page } from '@playwright/test';
import { isFreePreviewRequest } from './preparation-preview-fixture';

async function fixture(page: Page, delayFull = false) {
  const before = new Date(Date.now() - 60000).toISOString();
  const state = { last_user_at: new Date().toISOString(), expires_at: new Date(Date.now() + 1800000).toISOString(),
    ended_at: null as string | null, history_before: before, available_before: before, update_state: 'up_to_date', error: '' };
  const sync = { id: 90001, status: 'open', busy: false, briefing: 'The initial briefing stays unchanged.',
    created_at: before, completed_at: null, decisions: '', carry_forward: '', item_count: 0, remaining_count: 0, previously_included_count: 0,
    snapshot_version: 2, snapshot_at: before, recap: '', recap_state: 'empty', recap_error: '', aggregation_cost: null,
    items: [], context: [], memory: [], history_since: null, models: { summary: 'openai/gpt-5-mini', final: 'openai/gpt-5', max_invocations: 30 },
    tree: { complete: true, busy: false, run: null, nodes: [] }, conversation: state,
    messages: [{ id: 90001, role: 'user', content: 'Earlier question', created_at: before },
      { id: 90002, role: 'assistant', content: 'Earlier answer stays unchanged.', created_at: before }] };
  const observed = { reads: 0, endedReads: 0, fullReads: 0, fail: false, mutations: [] as string[], freePreviews: [] as string[] };
  page.on('request', request => {
    if (!['GET', 'HEAD'].includes(request.method())) observed.mutations.push(new URL(request.url()).pathname);
    if (isFreePreviewRequest(request)) observed.freePreviews.push(new URL(request.url()).pathname);
  });
  const initialSync = structuredClone(sync);
  let releaseFull!: () => void;
  const fullReady = new Promise<void>(resolve => { releaseFull = resolve; });
  if (!delayFull) releaseFull();
  await page.route(`**/api/syncs/${sync.id}`, async route => {
    observed.fullReads++; await fullReady;
    return route.fulfill({ json: delayFull ? initialSync : sync });
  });
  await page.route(`**/api/syncs/${sync.id}/conversation`, route => {
    observed.reads++; if (state.ended_at) observed.endedReads++;
    return observed.fail ? route.fulfill({ status: 503, json: { error: 'Synthetic status failure' } }) : route.fulfill({ json: state });
  });
  await page.route(`**/api/syncs/${sync.id}/chat-readiness`, route => route.fulfill({ json: {
    ready: false, briefingReady: true, historyReady: false, preparing: false, before: null, error: '',
  } }));
  await page.clock.install();
  await page.goto(`/syncs/${sync.id}/chat`);
  return { state, sync, observed, releaseFull };
}

test('live status is small and read-only; pending updates do not block chat, overwrite drafts or imply review', async ({ page }) => {
  const { state, observed } = await fixture(page);
  const chat = page.getByRole('region', { name: 'Chat with Draken', exact: true });
  const indicator = chat.getByRole('status', { name: 'Conversation updates' });
  const input = page.getByRole('textbox', { name: 'Message Draken' });
  await expect(indicator).toHaveText('● Up to date'); await expect(input).toBeEnabled();
  await input.fill('Keep this unsent draft');
  await page.getByText('Decisions & carry-forward', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Decisions', exact: true }).fill('Unsaved local note');
  state.update_state = 'preparing'; await page.clock.runFor(3100);
  await expect(indicator).toContainText('Preparing new info'); await expect(input).toBeEnabled();
  state.update_state = 'new_info'; state.available_before = new Date().toISOString(); await page.clock.runFor(3100);
  await expect(indicator).toContainText('New info ready'); await expect(input).toHaveValue('Keep this unsent draft');
  await expect(page.getByRole('textbox', { name: 'Decisions', exact: true })).toHaveValue('Unsaved local note');
  await expect(chat).toContainText('Earlier answer stays unchanged.');
  expect(observed.fullReads).toBe(1); expect(observed.mutations).toEqual([]);
  observed.fail = true; await page.clock.runFor(3100);
  await expect(indicator).toContainText('Update status unavailable'); await expect(input).toBeEnabled();
  observed.fail = false; state.ended_at = new Date().toISOString(); await page.clock.runFor(3100);
  await expect(chat).toContainText('Session ended after 30 minutes');
  await expect(input).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Unsent message — copy it into a new sync' })).toHaveValue('Keep this unsent draft');
  await expect(page.getByRole('button', { name: 'Mark reviewed', exact: true })).toBeEnabled();
  expect(observed.mutations).toEqual([]);
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Start a new sync', exact: true }).click();
  await expect(page).toHaveURL(/\/chat$/);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Start a new sync', exact: true }).click();
  await expect(page).toHaveURL('/');
  const reads = observed.reads; await page.clock.runFor(9000); expect(observed.reads).toBe(reads);
  // Returning Home may request only the exact provider-free POST {}. All earlier
  // assertions still prohibit mutations while reading the ended conversation.
  expect(observed.mutations).toEqual(observed.freePreviews);
});

test('snapshot totals distinguish carried unreviewed entries from newly included work without starting preparation', async ({ page }) => {
  const { sync, observed } = await fixture(page);
  sync.item_count = 12; sync.previously_included_count = 8;
  await page.reload();
  await expect(page.getByLabel('Snapshot carry-forward')).toContainText('4 newly included · 8 carried forward (unreviewed at capture)');
  await expect(page.getByLabel('Snapshot carry-forward')).toContainText('Valid cached summaries and embeddings are reused');
  await expect(page.getByLabel('Snapshot carry-forward')).toContainText('missing or changed work still needs preparation');
  expect(observed.mutations).toEqual([]);
});

test('an ended metadata response survives a later stale initial snapshot response', async ({ page }) => {
  const { state, observed, releaseFull } = await fixture(page, true);
  state.ended_at = new Date().toISOString(); await page.clock.runFor(3100);
  await expect.poll(() => observed.endedReads).toBeGreaterThan(0);
  // Keep the original full response blocked while the metadata body is consumed.
  await page.waitForTimeout(100); releaseFull();
  await expect(page.getByRole('button', { name: 'Start a new sync', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message Draken' })).toHaveCount(0);
  const reads = observed.reads; await page.clock.runFor(10000);
  expect(observed.reads).toBe(reads); expect(observed.mutations).toEqual([]);
});

test('server-side idle expiry at send time preserves the rejected draft and offers a new sync without replaying it', async ({ page }) => {
  const { state, sync, observed } = await fixture(page);
  await page.route(`**/api/syncs/${sync.id}/chat/messages`, route => {
    state.ended_at = new Date().toISOString();
    return route.fulfill({ status: 410, json: { error: 'Session ended. Start a new sync to continue.' } });
  });
  const input = page.getByRole('textbox', { name: 'Message Draken' }); await expect(input).toBeEnabled();
  await input.fill('Question arriving just after idle expiry');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Session ended');
  await expect(page.getByRole('textbox', { name: 'Unsent message — copy it into a new sync' })).toHaveValue('Question arriving just after idle expiry');
  await expect(page.getByRole('region', { name: 'Chat with Draken', exact: true })).toContainText('Earlier answer stays unchanged.');
  expect(observed.mutations).toEqual([`/api/syncs/${sync.id}/chat/messages`]);
});
