const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '../src'), folder = path.join(root, 'evidence');
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(path.join(dir, item.name)) : item.name.endsWith('.ts') ? [path.join(dir, item.name)] : []);
}
function imports(file, text = fs.readFileSync(file, 'utf8')) {
  const result = [], tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  function visit(node) {
    let literal = node.moduleSpecifier;
    if (ts.isImportTypeNode(node)) literal = node.argument.literal;
    if (ts.isExternalModuleReference(node)) literal = node.expression;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(tree) === 'require')) literal = node.arguments[0] || node;
    if (literal) result.push({ name: ts.isStringLiteral(literal) ? literal.text : null, code: node.getText(tree) });
    ts.forEachChild(node, visit);
  }
  visit(tree); return result;
}
function assertInternal(file, dependencies) {
  for (const item of dependencies) {
    assert.ok(item.name?.startsWith('./') || item.name?.startsWith('../'), `External or computed evidence dependency: ${item.code}`);
    const target = path.resolve(path.dirname(file), item.name);
    assert.ok(target.startsWith(folder + path.sep), `Evidence dependency leaves the module: ${item.name}`);
  }
}

test('application code imports evidence only through its public entry point', () => {
  for (const file of files(root)) {
    if (file.startsWith(folder + path.sep)) continue;
    for (const item of imports(file)) {
      if (!item.name) continue;
      const target = path.resolve(path.dirname(file), item.name);
      if (target.startsWith(folder + path.sep)) assert.equal(target, path.join(folder, 'index'), `${file}: ${item.name}`);
    }
  }
  assert.deepEqual(Object.keys(require('../dist/evidence')).sort(), ['DISCUSSION_HISTORY_BYTES', 'prepareEvidence']);
});

test('evidence has no application, package or builtin imports, including type-only dependencies', () => {
  for (const file of files(folder)) assertInternal(file, imports(file));
});

test('the import rule rejects runtime, type-only, re-export and computed dependency escapes', () => {
  const file = path.join(folder, 'probe.ts');
  for (const code of [
    "import { readHistory } from '../memory/service';",
    "import type { HistoryQuery } from '../memory/types';",
    "export type { SyncDetail } from '../types';",
    "type T = import('../memory/types').HistoryQuery;",
    "import fs = require('node:fs');",
    "const x = require('../sync/normalize');",
    "const x = import(target);",
    "import x from './nested/../../memory/service';",
  ]) assert.throws(() => assertInternal(file, imports(file, code)), /dependency/i, code);
  assert.doesNotThrow(() => assertInternal(file, imports(file, "import type { EvidenceRequest } from './contracts';")));
});

test('text and native voice use public preparation with external application wiring', () => {
  for (const relative of ['sync/manager.ts', 'voice/live.ts']) {
    const dependencies = imports(path.join(root, relative));
    assert.ok(dependencies.some(item => item.name === '../evidence' && /prepareEvidence/.test(item.code)));
    assert.ok(dependencies.some(item => item.name === '../evidence-adapter'));
    for (const item of dependencies) {
      if (!item.name) continue;
      assert.doesNotMatch(item.name, /memory\/(?:context|selection|packet)$/);
      if (item.name.endsWith('/memory/service')) {
        const names = item.code.match(/\{([^}]+)\}/)?.[1].split(',').map(name => name.trim());
        assert.ok(names?.length, 'No namespace imports that could bypass evidence preparation');
        for (const name of names) assert.ok(['historyProgress', 'stopHistory'].includes(name), `Unexpected caller dependency: ${name}`);
      }
    }
  }
});

test('the evidence folder compiles and runs alone with two independent injected hosts', () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-evidence-alone-'));
  try {
    const source = path.join(isolated, 'source'), out = path.join(isolated, 'out');
    fs.cpSync(folder, source, { recursive: true });
    const program = ts.createProgram([path.join(source, 'index.ts')], {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true,
      lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'], types: [], outDir: out,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.deepEqual(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
    assert.equal(program.emit().emitSkipped, false);
    const script = `
      const assert = require('node:assert/strict');
      const { prepareEvidence } = require(${JSON.stringify(path.join(out, 'index.js'))});
      async function run(id) {
        const before = '2026-01-08T00:00:00Z', signal = new AbortController().signal, reads = [];
        const record = { ref: id, kind: 'original', session_id: id, sync_id: null, title: id, workspace: id,
          role: 'toolResult', at: '2026-01-07T00:00:00Z', qualification: 'Verified by host', text: 'private result '+id };
        const dependencies = {
          cleanText: (text, limit) => text.replaceAll('private', '[redacted]').slice(0, limit),
          search: async (query, actualSignal) => {
            assert.equal(actualSignal, signal); assert.equal(query.before, before); assert.equal(query.limit, 64);
            assert.equal(query.question, '[redacted] question '+id);
            return { mode: 'other-host', results: [{ ...record, offset: 0 }], limitations: '' };
          },
          read: async (ref, offset, actualSignal, cutoff) => {
            assert.equal(ref, id); assert.equal(actualSignal, signal); assert.equal(cutoff, before);
            reads.push(ref); return { record, offset, neighbors: [] };
          },
        };
        const result = await prepareEvidence({ question: 'private question '+id, before, signal,
          ask: async payload => {
            assert.equal(payload.candidates[0].ref, id); assert.ok(!JSON.stringify(payload).includes('private'));
            await Promise.resolve(); return '{"scope":"project","selected":["S1"]}';
          } }, dependencies);
        assert.equal(result.kind, 'ready'); assert.deepEqual(result.refs, [id]); assert.deepEqual(reads, [id]);
        assert.ok(!result.text.includes('private')); assert.ok(result.text.includes('[redacted] result '+id));
      }
      Promise.all([run('host-A'), run('host-B')]).catch(error => { console.error(error); process.exitCode = 1; });
    `;
    execFileSync(process.execPath, ['-e', script], { cwd: isolated, env: {}, timeout: 30000, stdio: 'pipe' });
  } finally { fs.rmSync(isolated, { recursive: true, force: true }); }
});
