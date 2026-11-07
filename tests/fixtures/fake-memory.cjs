// Test-only module mocks. Never imported by production code and no runtime env
// switch can select them. Ordinary tests must not download/run a real model.
const service = require('../../dist/memory/service');
service.prepareHistory = async () => {};
service.searchHistory = async () => ({ mode: 'hybrid', results: [], limitations: 'Synthetic empty historical lookup.' });

// Browser fixtures exercise the actual automatic index/ranking/reader against
// synthetic rows, replacing only local embedding inference. The explicit real
// model qualification does not import this fixture.
exports.useIndexedHistory = () => {
  const Database = require('better-sqlite3');
  const { getDb } = require('../../dist/db/schema');
  const { HistoryIndex } = require('../../dist/memory/index');
  let index;
  const current = () => index ||= new HistoryIndex(new Database(':memory:'), getDb(), {
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
  service.prepareHistory = async before => current().prepare({ before });
  service.searchHistory = async query => current().search(service.validateHistoryQuery(query));
  service.readHistory = async (ref, offset = 0) => current().read(ref, offset);
};
