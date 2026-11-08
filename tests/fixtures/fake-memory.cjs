// Test-only module mocks. Never imported by production code and no runtime env
// switch can select them. Ordinary tests must not download/run a real model.
const service = require('../../dist/memory/service');
service.prepareHistory = async () => {};
service.historyReadiness = () => ({ ready: true, before: new Date().toISOString() });
service.searchHistory = async () => ({ mode: 'hybrid', results: [], limitations: 'Synthetic empty historical lookup.' });
service.searchPreparedHistory = (...args) => service.searchHistory(...args);

// Browser fixtures exercise the actual automatic index/ranking/reader against
// synthetic rows, replacing only local embedding inference. The explicit real
// model qualification does not import this fixture.
exports.useIndexedHistory = () => {
  const Database = require('better-sqlite3');
  const { getDb } = require('../../dist/db/schema');
  const { HistoryIndex } = require('../../dist/memory/index');
  const { indexReadiness } = require('../../dist/memory/readiness');
  let index, cache;
  const current = () => index ||= new HistoryIndex(cache = new Database(':memory:'), getDb(), {
    fingerprint: 'synthetic-browser-embeddings', ready: () => true, setup: async () => {},
    embed: async text => {
      const vector = new Float32Array(384);
      for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
        let hash = 0; for (const char of word) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
        vector[hash % 384]++;
      }
      const norm = Math.hypot(...vector) || 1; return vector.map(value => value / norm);
    },
  });
  service.prepareHistory = async (before, signal) => {
    const fs = require('node:fs');
    const control = process.env.DRAKEN_FAKE_CONTROL && fs.existsSync(process.env.DRAKEN_FAKE_CONTROL) ? JSON.parse(fs.readFileSync(process.env.DRAKEN_FAKE_CONTROL)) : {};
    if (control.historyDelay) await new Promise((resolve, reject) => {
      const stop = () => { clearTimeout(timer); reject(new Error('Cancelled')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, control.historyDelay);
      signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
    });
    if (signal?.aborted) throw new Error('Cancelled');
    await current().prepare({ before }, undefined, true);
  };
  service.historyReadiness = (capturedOnly = false) => cache ? indexReadiness(cache, getDb(), capturedOnly) : { ready: false, before: null };
  service.searchHistory = async query => current().search(service.validateHistoryQuery(query));
  service.searchPreparedHistory = async query => current().search(service.validateHistoryQuery(query), undefined, true);
  service.readHistory = async (ref, offset = 0, _signal, before) => current().read(ref, offset, before);
};
