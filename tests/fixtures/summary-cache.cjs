// Frozen synthetic v1/v2 persisted data. Do not regenerate these keys through
// current SummaryTree methods: changing historical lookup must fail the test.
const records = [
  { type: 'session', version: 3, id: 'frozen-cache-proof', cwd: '/synthetic/cache-compatibility', timestamp: '2026-01-01T00:00:00.000Z' },
  { type: 'message', id: 'question', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'Check the export tests.' } },
  { type: 'message', id: 'result', parentId: 'question', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', content: 'Export tests passed. Deployment remains unverified.' } },
];
const output = { observations: [{ topic: '/synthetic/cache-compatibility', state: 'reported_done', summary: 'Export tests passed. Deployment remains unverified.', evidence: ['Kbd8690d6c4ca08746d8a'] }], limitations: [] };
const caches = [
  { version: 'sync-tree-v1', model: 'test/cheap', key: '9ec777e10fa8c90140c6f71b7020bc64fbcf5abf25127fdc959d8a2e50f76475' },
  { version: 'sync-tree-v2-short-labels', model: 'openai/gpt-6-luna', key: 'd07b4eae4024a7ee3da561fc4b66e675534b6c1a62a18bf573fbd4f6b8d33f53' },
];
module.exports = { records, output, caches };
