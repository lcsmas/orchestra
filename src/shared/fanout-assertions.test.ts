// #540 — the pure assertion extractor + comparator: setup-only change accepted; reordered / renamed / modified / added / removed assertion refused; unknown shape fails closed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertionsHash, compareAssertions, compareFrozenSets, extractAssertions } from './fanout-assertions.ts';

const JS = `import test from 'node:test';
import assert from 'node:assert/strict';
import { thing } from '../src/thing.ts';

const fixture = { a: 1 };
test.beforeEach(() => { /* setup */ });

test('adds up', async (t) => {
  const r = thing(fixture);
  assert.equal(r.total, 3);
  assert.deepEqual(r.items, [1, 2]); // trailing comment
  await assert.rejects(
    () => thing(null),
    /bad input/,
  );
});

test('chained', () => {
  expect(thing(fixture))
    .toBe(3);
  assert.ok(\`template \${fixture.a + 1} text\`);
});
`;

const PY = `import pytest
from thing import thing

@pytest.fixture
def fx():
    return {"a": 1}

def test_adds_up(fx):
    r = thing(fx)
    assert r.total == 3
    assert r.items == [1, 2], "items"
    with pytest.raises(ValueError):
        thing(None)

class TestMore:
    def test_x(self):
        self.assertEqual(thing({}), 0)
`;

const stmts = (p: string, t: string): string[] => { const e = extractAssertions(p, t); assert.ok(e.ok, e.ok ? '' : e.why); return e.ok ? e.statements : []; };

test('JS: extracts assertions + declaration heads, multi-line statements joined, comments dropped', () => {
  assert.deepEqual(stmts('a.test.ts', JS), [
    "B:import test from 'node:test'",
    "B:import assert from 'node:assert/strict'",
    "D:test('adds up'",
    'D:cb:async (t) =>',
    'A:assert.equal(r.total, 3)',
    'A:assert.deepEqual(r.items, [1, 2])',
    'A:await assert.rejects(\n() => thing(null),\n/bad input/,\n)',
    "D:test('chained'",
    'D:cb:() =>',
    'A:expect(thing(fixture))\n.toBe(3)',
    'A:assert.ok(`template ${fixture.a + 1} text`)',
  ]);
});

test('JS: a setup-only change (fixture value, hook, helper, import, indentation, comments) is accepted', () => {
  const next = JS
    .replace('const fixture = { a: 1 };', 'const fixture = { a: 1 };\nlet db;\nasync function boot() { db = await open(); }')
    .replace('test.beforeEach(() => { /* setup */ });', 'test.beforeEach(async () => { await boot(); });\ntest.afterEach(() => db?.close());')
    .replace('const r = thing(fixture);', "const r = thing(fixture, { env: 'ci' }); // harness: env")
    .replace('import { thing }', "import { open } from './db.ts';\nimport { thing }")
    .replace('    () => thing(null),', '        () => thing(null),');
  assert.deepEqual(compareAssertions('a.test.ts', JS, next), { ok: true });
});

test('JS: modified / added / removed / reordered / renamed refused with the kind named', () => {
  const kind = (next: string): string => { const c = compareAssertions('a.test.ts', JS, next); assert.equal(c.ok, false); return c.ok ? '' : c.kind; };
  assert.equal(kind(JS.replace('assert.equal(r.total, 3)', 'assert.equal(r.total, 4)')), 'modified');
  assert.equal(kind(JS.replace('assert.equal(r.total, 3);', 'assert.equal(r.total, 3);\n  assert.ok(true);')), 'added');
  assert.equal(kind(JS.replace('  assert.deepEqual(r.items, [1, 2]); // trailing comment\n', '')), 'removed');
  assert.equal(kind(JS.replace('  assert.equal(r.total, 3);\n  assert.deepEqual(r.items, [1, 2]); // trailing comment', '  assert.deepEqual(r.items, [1, 2]);\n  assert.equal(r.total, 3);')), 'reordered');
  assert.equal(kind(JS.replace("test('adds up'", "test('adds ups'")), 'modified'); // a renamed test
  assert.equal(kind(JS.replace('assert.equal(r.total, 3)', 'assert.strictEqual(r.total, 3)')), 'modified'); // a renamed assertion call
  assert.equal(kind(JS.replace("test('adds up'", "test.skip('adds up'")), 'modified'); // a neutraliser
  assert.equal(kind(JS.replace('assert.equal(r.total, 3);', 'process.exit(0);\n  assert.equal(r.total, 3);')), 'added');
});

test('JS: strings, regex literals and templates that look like assertions or comments are not statements', () => {
  const src = "test('x', () => {\n  const s = 'assert.equal(1, 2)'; const re = /\\/\\* assert.ok(1) \\*\\//; const u = `a // ${'b'} assert.ok(2)`;\n  assert.ok(s);\n});\n";
  assert.deepEqual(stmts('b.test.js', src), ["D:test('x'", 'D:cb:() =>', 'A:assert.ok(s)']);
});

test('JS: compact one-liners and nested expect are found', () => {
  assert.deepEqual(stmts('c.test.ts', "it('a', () => expect(f()).toBe(1));\nit('b', async () => { await expect(g()).resolves.toBe(2); });\n"), ["D:it('a'", 'D:cb:() =>', 'A:expect(f()).toBe(1)', "D:it('b'", 'D:cb:async () =>', 'A:await expect(g()).resolves.toBe(2)']);
});

test('Python: extracts assert / with pytest.raises / unittest assert / def test / class Test, keeps indentation', () => {
  assert.deepEqual(stmts('t_test.py', PY), [
    'D:def test_adds_up(fx):',
    'A:    assert r.total == 3',
    'A:    assert r.items == [1, 2], "items"',
    'A:    with pytest.raises(ValueError):',
    'D:class TestMore:',
    'D:    def test_x(self):',
    'A:        self.assertEqual(thing({}), 0)',
  ]);
});

test('Python: setup-only change accepted; assertion change / reorder / neutraliser refused', () => {
  const ok = PY.replace('return {"a": 1}', 'return {"a": 1, "env": "ci"}').replace('r = thing(fx)', 'r = thing(fx)  # harness').replace('from thing import thing', 'import os\nfrom thing import thing');
  assert.deepEqual(compareAssertions('t_test.py', PY, ok), { ok: true });
  for (const bad of [PY.replace('== 3', '== 4'), PY.replace('def test_adds_up', '@pytest.mark.skip\ndef test_adds_up'), PY.replace('    assert r.total == 3\n    assert r.items == [1, 2], "items"', '    assert r.items == [1, 2], "items"\n    assert r.total == 3')]) {
    assert.equal(compareAssertions('t_test.py', PY, bad).ok, false);
  }
});

test('unknown shape fails closed: ruby, unlexable file, no assertion at all, no extension match', () => {
  for (const [p, t] of [['a_spec.rb', "it 'x' do\n  expect(1).to eq(1)\nend\n"], ['a.test.ts', "test('x', () => { assert.ok('unterminated);\n"], ['a.test.ts', 'const x = 1;\n'], ['a.sh', 'true']] as const) {
    assert.equal(extractAssertions(p, t).ok, false, p);
    const c = compareAssertions(p, t, t);
    assert.equal(c.ok, false);
    if (!c.ok) assert.equal(c.kind, 'unknown-shape');
  }
});

test('compareFrozenSets: same path set required; hash covers every file, changes with an assertion only', () => {
  const old = { 'a.test.ts': JS, 'b_test.py': PY };
  const same = compareFrozenSets(old, { 'a.test.ts': JS.replace('{ a: 1 }', '{ a: 1, b: 2 }'), 'b_test.py': PY });
  const ref = compareFrozenSets(old, old);
  assert.ok(same.ok && ref.ok);
  if (same.ok && ref.ok) assert.equal(ref.assertionsHash, same.assertionsHash);
  assert.equal(compareFrozenSets(old, { 'a.test.ts': JS }).ok, false);
  assert.equal(compareFrozenSets(old, { 'a.test.ts': JS.replace('r.total, 3', 'r.total, 5'), 'b_test.py': PY }).ok, false);
  assert.notEqual(assertionsHash({ x: ['A:a'] }), assertionsHash({ x: ['A:b'] }));
});

// ── pre-review (#540) false-accepts, each closed ───────────────────────────────────────────────────────────

const refuses = (p: string, a: string, b: string): void => { assert.equal(compareAssertions(p, a, b).ok, false, `${p}: ${b.slice(0, 80)}`); };

test('JS: skip / timeout OPTIONS after the title, t.test, and ctx.skip() neutralisers are refused', () => {
  const base = "test('a', async () => { assert.equal(f(), 1); });\n";
  refuses('a.test.ts', base, "test('a', { skip: true }, async () => { assert.equal(f(), 1); });\n");
  refuses('a.test.ts', base, "test('a', async () => { assert.equal(f(), 1); }, 0);\n");
  refuses('a.test.ts', "describe('d', () => { it('a', () => { assert.ok(1); }); });\n", "describe('d', { skip: true }, () => { it('a', () => { assert.ok(1); }); });\n");
  refuses('a.test.ts', "t.test('s', () => { assert.ok(1); });\n", "t.test('s', { skip: true }, () => { assert.ok(1); });\n");
  refuses('a.test.ts', base, base + "beforeEach(function () { this.skip(); });\n");
  refuses('a.test.ts', base, base + "test.beforeEach((ctx) => ctx.skip());\n");
  assert.deepEqual(compareAssertions('a.test.ts', base, "const s = 1;\ntest('a', async () => {\n  assert.equal(f(), 1);\n});\n"), { ok: true });
});

test('Python: module-level pytestmark skip / raise SkipTest neutralisers are refused', () => {
  const base = 'def test_a():\n    assert f() == 1\n';
  refuses('t_test.py', base, 'import pytest\npytestmark = pytest.mark.skip\n' + base);
  refuses('t_test.py', base, 'import unittest\ndef setup_module():\n    raise unittest.SkipTest("x")\n' + base);
});

test('assertion-shaped calls are READ as assertions (supertest .expect, sinon.assert, own assertFoo / expectOk helpers, mock.assert_called_with): a changed argument is refused, a setup edit passes', () => {
  const js = "test('a', async () => {\n  await request(app).get('/').expect(200);\n  sinon.assert.calledOnce(spy);\n  assertFoo(1);\n  expectOk(r);\n});\n";
  assert.deepEqual(extractAssertions('a.test.ts', js).ok, true);
  assert.deepEqual(compareAssertions('a.test.ts', js, `const boot = 1;\n${js}`), { ok: true });
  for (const [from, to] of [['expect(200)', 'expect(500)'], ['calledOnce', 'notCalled'], ['assertFoo(1)', 'assertFoo(2)'], ['expectOk(r)', 'expectOk(q)']]) refuses('a.test.ts', js, js.replace(from, to));
  const py = 'def test_a():\n    assert f() == 1\n    m.assert_called_with(1)\n';
  assert.equal(extractAssertions('t_test.py', py).ok, true);
  refuses('t_test.py', py, py.replace('with(1)', 'with(2)'));
  refuses('t_test.py', 'def test_a():\n    assert f() == 1\n    np.testing.assert_allclose(a, b)\n', 'def test_a():\n    assert f() == 1\n    np.testing.assert_allclose(a, c)\n');
});

test('whitespace INSIDE a multi-line string / template is part of the assertion (byte-exact); code-line indentation is not', () => {
  const t = (inner: string): string => `test('a', () => {\n  expect(x).toBe(\`${inner}\`);\n});\n`;
  refuses('a.test.ts', t('a\n    b'), t('a\nb'));
  refuses('a.test.ts', t('a\n\nb'), t('a\nb'));
  refuses('t_test.py', "def test_a():\n    assert x == '''a\n  b'''\n", "def test_a():\n    assert x == '''a\nb'''\n");
  assert.deepEqual(compareAssertions('a.test.ts', t('a\n    b'), t('a\n    b').replace('  expect', '      expect')), { ok: true });
});

test('declaration args: the CALLBACK body is not part of the head (setup edits inside it pass), options and trailing args are', () => {
  const a = "test('a', { timeout: 5 }, async () => {\n  const x = 1;\n  assert.equal(f(), 1);\n});\n";
  assert.deepEqual(compareAssertions('a.test.ts', a, a.replace('const x = 1;', 'const x = 2; await boot();')), { ok: true });
  refuses('a.test.ts', a, a.replace('timeout: 5', 'timeout: 6'));
  const b = "it('a', async () => {\n  assert.ok(f);\n}, 100);\n";
  assert.deepEqual(compareAssertions('a.test.ts', b, b.replace('assert.ok(f);', 'await boot();\n  assert.ok(f);')), { ok: true });
  refuses('a.test.ts', b, b.replace('100', '0'));
});

// ── the measured bypasses of the adversarial review (#540 MAJOR-1): every one-line edit that made the assertions vacuous is refused ───────────────

test('MAJOR-1 JS bypasses: runner / assert swapped or shadowed, control flow around an assertion, deferred / dead placement, process hooks, HTML comment', () => {
  const base = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { run } from './run.ts';\n\ntest('a', async (t) => {\n  const r = await run();\n  assert.equal(r, 5);\n});\ntest('b', async () => {\n  assert.equal(await run(), 6);\n});\n";
  const bad: Array<[string, string]> = [
    ['runner swapped', base.replace("import test from 'node:test';", 'const test = () => {};')],
    ['assert swapped', base.replace("import assert from 'node:assert/strict';", "import assert from './fake-assert.js';")],
    ['assert required elsewhere', base.replace("import assert from 'node:assert/strict';", "const assert = require('./fake.js');")],
    ['assert param shadow', base.replace('async (t) => {', 'async (assert) => {')],
    ['local assert shadow', base.replace('  const r = await run();', '  const assert = { equal() {} };\n  const r = await run();')],
    ['global assert assignment', base.replace('test(\'a\'', "globalThis.assert = { equal() {} };\ntest('a'")],
    ['return first', base.replace('  const r = await run();', '  return;\n  const r = await run();')],
    ['throw first', base.replace('  const r = await run();', '  throw 0;\n  const r = await run();')],
    ['if false', base.replace('  assert.equal(r, 5);', '  if (false) assert.equal(r, 5);')],
    ['and-short-circuit', base.replace('  assert.equal(r, 5);', '  0 && assert.equal(r, 5);')],
    ['try/catch', base.replace('  assert.equal(r, 5);', '  try { assert.equal(r, 5); } catch {}')],
    ['try/catch multi-line', base.replace('  assert.equal(r, 5);', '  try {\n    assert.equal(r, 5);\n  } catch {}')],
    ['deferred', base.replace('  assert.equal(r, 5);', '  setTimeout(() => assert.equal(r, 5), 0);')],
    ['labelled break', base.replace('  assert.equal(r, 5);', '  x: {\n    break x;\n    assert.equal(r, 5);\n  }')],
    ['void iife', base.replace('  assert.equal(r, 5);', '  void (() => {\n    assert.equal(r, 5);\n  });')],
    ['moved into a never-called function', base.replace('  assert.equal(r, 5);', '  function unused() {\n    assert.equal(r, 5);\n  }')],
    ['if line above', base.replace('  assert.equal(r, 5);', '  if (false)\n    assert.equal(r, 5);')],
    ['process hook', base.replace('test(\'a\'', "process.on('uncaughtException', () => {});\ntest('a'")],
    ['html comment', base.replace('  assert.equal(r, 5);', '  <!-- assert.equal(r, 5);')],
  ];
  for (const [what, text] of bad) { const c = compareAssertions('a.test.ts', base, text); assert.equal(c.ok, false, what); }
  // …while real setup changes still pass: an unrelated import, a helper with its own return, a new local, a hook
  const good = base.replace("import { run } from './run.ts';", "import { run } from './run.ts';\nimport { boot } from './db.ts';\nfunction helper() { return 1; }\nlet db;").replace('test(\'a\'', 'beforeEach(async () => { db = await boot(); });\ntest(\'a\'').replace('const r = await run();', 'const r = await run(db);');
  assert.deepEqual(compareAssertions('a.test.ts', base, good), { ok: true });
});

test('MAJOR-1 Python bypasses: assertion moved into an unused def, wrapped in try / if, return before it, a shadowing import', () => {
  const base = 'import pytest\nfrom run import run\n\ndef test_a():\n    r = run()\n    assert r == 5\n';
  const bad: Array<[string, string]> = [
    ['unused def', base.replace('    assert r == 5\n', '    def _unused():\n        assert r == 5\n')],
    ['return first', base.replace('    r = run()\n', '    return\n    r = run()\n')],
    ['raise skip', base.replace('    r = run()\n', '    raise RuntimeError\n    r = run()\n')],
    ['try wrap', base.replace('    assert r == 5\n', '    try:\n        assert r == 5\n    except Exception:\n        pass\n')],
    ['if wrap', base.replace('    assert r == 5\n', '    if False:\n        assert r == 5\n')],
  ];
  for (const [what, text] of bad) assert.equal(compareAssertions('t_test.py', base, text).ok, false, what);
  assert.deepEqual(compareAssertions('t_test.py', base, base.replace('from run import run', 'from run import run\nimport os\n\ndef helper():\n    return 1').replace('r = run()', 'r = run()  # harness')), { ok: true });
});

test('a helper DEFINITION named like an assertion (def assert_close, function expectOk) is not an unread assertion call', () => {
  const py = 'def assert_close(a, b):\n    assert abs(a - b) < 1\n\ndef test_a():\n    assert_close(1, 1)\n';
  assert.equal(extractAssertions('t_test.py', py).ok, true);
  assert.deepEqual(compareAssertions('t_test.py', py, py.replace('abs(a - b) < 1', 'abs(a - b) < 1  # tol')), { ok: true });
  refuses('t_test.py', py, py.replace('assert_close(1, 1)', 'assert_close(1, 2)'));
});

// ── re-review (#540) MAJOR: an assertion-NAMED definition / override is pinned in full ────────────────────────────────────────────────────────

test('assertion-named helper definitions are pinned: gutting expectOk (function / arrow), a Python def assertEqual … pass, TestCase.assertEqual = lambda, mock.patch.object are refused; a NEW helper with another name passes', () => {
  const js = "function expectOk(r) { if (r !== 5) throw new Error('bad'); }\ntest('a', () => {\n  expectOk(run());\n  assert.ok(1);\n});\n";
  refuses('a.test.ts', js, js.replace("{ if (r !== 5) throw new Error('bad'); }", '{ }'));
  refuses('a.test.ts', js, js.replace("function expectOk(r) { if (r !== 5) throw new Error('bad'); }", 'const expectOk = (r) => {};'));
  refuses('a.test.ts', js, js.replace("{ if (r !== 5) throw new Error('bad'); }", '{ return true; }'));
  assert.deepEqual(compareAssertions('a.test.ts', js, `function boot() { return 1; }\nconst expectedStatus = 201;\n${js}`), { ok: true });
  const py = 'import unittest\n\nclass TestA(unittest.TestCase):\n    def test_a(self):\n        self.assertEqual(f(), 1)\n';
  refuses('t_test.py', py, py.replace('    def test_a', '    def assertEqual(self, a, b):\n        pass\n\n    def test_a'));
  refuses('t_test.py', py, py + '\nunittest.TestCase.assertEqual = lambda *a: None\n');
  refuses('t_test.py', py, py.replace('    def test_a', "    @unittest.mock.patch.object(unittest.TestCase, 'assertEqual')\n    def test_a"));
  const withHelper = 'def assert_close(a, b):\n    assert abs(a - b) < 1\n\ndef test_a():\n    assert_close(1, 1)\n';
  refuses('t_test.py', withHelper, withHelper.replace('abs(a - b) < 1', 'True'));
  assert.deepEqual(compareAssertions('t_test.py', withHelper, withHelper.replace('abs(a - b) < 1', 'abs(a - b) < 1  # tol').replace('def test_a', 'def helper():\n    return 1\n\ndef test_a')), { ok: true });
});

test('changedLines: a reorder / indentation-only change is reported as such, not as "0 added, 0 removed"', async () => {
  const { changedLines } = await import('./fanout-assertions.ts');
  const a = 'const x = 1;\nlet y = x;\ntest("a", () => { assert.ok(y); });\n';
  const r = changedLines({ 'a.test.ts': a }, { 'a.test.ts': 'let y = x;\nconst x = 1;\ntest("a", () => { assert.ok(y); });\n' });
  assert.deepEqual([r.added, r.removed, r.reorderOnly], [0, 0, true]);
  assert.equal(changedLines({ 'a.test.ts': a }, { 'a.test.ts': a }).reorderOnly, false);
  assert.equal(changedLines({ 'a.test.ts': a }, { 'a.test.ts': `${a}let z = 1;\n` }).reorderOnly, false);
});
