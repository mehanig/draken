import type { Page } from '@playwright/test';
import type { HistoryPage } from '../../src/memory/types';

export const sourceRefs = ['Haaaaaaaaaaaaaaaaaaaaaaaa', 'Hbbbbbbbbbbbbbbbbbbbbbbbb'];
export async function delayedSources(page: Page) {
  const reads: { ref: string; offset: number; aborted: boolean }[] = [], releases: (() => void)[] = [];
  await page.route('**/api/memory/records/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const read = { ref: url.pathname.split('/').at(-1)!, offset: Number(url.searchParams.get('offset')), aborted: false };
    reads.push(read);
    const failed = (value: typeof request) => { if (value === request) { read.aborted = true; page.off('requestfailed', failed); } };
    page.on('requestfailed', failed);
    if (read.offset) await new Promise<void>(resolve => releases.push(resolve));
    const value: HistoryPage = { record: { ref: read.ref, title: read.ref === sourceRefs[0] ? 'Source A' : 'Source B', kind: 'session', role: 'assistant',
      at: '2026-01-01T00:00:00.000Z', text: `Retained source at offset ${read.offset}`, qualification: 'Agent report, not independent verification.',
      session_id: 'synthetic-viewer', sync_id: null, origin_ref: null, workspace: '/synthetic/viewer' }, offset: read.offset, total: 8000, neighbors: [] };
    await route.fulfill({ json: value }).catch(() => {});
  });
  return { reads, release: () => releases.splice(0).forEach(resolve => resolve()) };
}
