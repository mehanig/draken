const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../src'), folder = path.join(root, 'evidence');
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(path.join(dir, item.name)) : item.name.endsWith('.ts') ? [path.join(dir, item.name)] : []);
}
function imports(file) {
  const result = [], tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  function visit(node) {
    const literal = node.moduleSpecifier || (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(tree) === 'require') ? node.arguments[0] : undefined);
    if (literal && ts.isStringLiteral(literal)) result.push({ name: literal.text, code: node.getText(tree) });
    ts.forEachChild(node, visit);
  }
  visit(tree); return result;
}

test('application code imports evidence only through its public entry point', () => {
  for (const file of files(root)) {
    if (file.startsWith(folder + path.sep)) continue;
    for (const item of imports(file)) {
      const target = path.resolve(path.dirname(file), item.name);
      if (target.startsWith(folder + path.sep)) assert.equal(target, path.join(folder, 'index'), `${file}: ${item.name}`);
    }
  }
  assert.deepEqual(Object.keys(require('../dist/evidence')).sort(), ['DISCUSSION_HISTORY_BYTES', 'prepareEvidence']);
});

test('evidence preparation cannot import conversation state, providers, storage writes or answer generation', () => {
  // Exact shared dependencies: prepared search/original reads, pure formatting,
  // and data types. Adding a dependency requires an explicit boundary review.
  const allowed = new Map([
    [path.join(root, 'memory/service'), /\b(?:readHistory|searchPreparedHistory)\b/],
    [path.join(root, 'memory/types'), /\b(?:HistoryQuery|HistoryResults)\b/],
    [path.join(root, 'sync/normalize'), /\bcleanText\b/],
  ]);
  for (const file of files(folder)) for (const item of imports(file)) {
    const target = path.resolve(path.dirname(file), item.name);
    if (target.startsWith(folder + path.sep)) continue;
    assert.ok(allowed.has(target), `Forbidden evidence dependency: ${file}: ${item.name}`);
    const names = item.code.match(/\{([^}]+)\}/)?.[1].split(',').map(name => name.trim().replace(/^type /, ''));
    assert.ok(names?.length, 'Use named imports, not an unrestricted dependency object');
    for (const name of names) assert.match(name, new RegExp(`^(?:${allowed.get(target).source.replaceAll('\\b', '')})$`));
  }
});

test('text and native voice cannot bypass preparation with their own archive lookup', () => {
  for (const relative of ['sync/manager.ts', 'voice/live.ts']) {
    const dependencies = imports(path.join(root, relative));
    assert.ok(dependencies.some(item => item.name === '../evidence' && /prepareEvidence/.test(item.code)));
    for (const item of dependencies) {
      assert.doesNotMatch(item.name, /memory\/(?:context|selection|packet)$/);
      if (item.name.endsWith('/memory/service')) {
        const names = item.code.match(/\{([^}]+)\}/)?.[1].split(',').map(name => name.trim());
        assert.ok(names?.length, 'No namespace imports that could bypass evidence preparation');
        for (const name of names) assert.ok(['historyProgress', 'stopHistory'].includes(name), `Unexpected caller dependency: ${name}`);
      }
    }
  }
});
