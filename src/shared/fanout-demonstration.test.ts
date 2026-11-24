// #572 — the demonstration rule, pure: the word floor, the three texts pairwise different, `observed` cites a PRODUCT file:line that exists on the head.
// Mutants of each clause: scripts/e2e-fanout-switches.mjs (#572 arms).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMONSTRATION_WORD_FLOOR, citationsOf, classifyDemonstration, classifyPath, demonstrationAccepted, isProductPath, textRefusal, wordsOf, type Demonstration } from './fanout-demonstration.ts';

const HEAD = 'a'.repeat(40);
const GOOD = { input: 'GET /orders?limit=0 as an authenticated user', observed: 'src/orders/service.ts:42 returns every order instead of an empty page', expected: 'the ticket says limit=0 must return an empty page' };
const onHead = (...files: string[]) => (_h: string, p: string): boolean => files.includes(p);
const cls = (d: Partial<typeof GOOD>, ctx: Parameters<typeof classifyDemonstration>[1] = { head: HEAD, fileOnHead: onHead('src/orders/service.ts') }): Demonstration => classifyDemonstration({ ...GOOD, ...d }, ctx);

test('the floor is 5 words: 4 fails and 5 passes — for each of the three fields (observed: its file:line does not count)', () => {
  assert.equal(DEMONSTRATION_WORD_FLOOR, 5);
  assert.equal(wordsOf('one two three four'), 4);
  assert.equal(wordsOf('  a — b  ...  c '), 3, 'punctuation alone is not a word');
  assert.ok(demonstrationAccepted(cls({})), 'the good one');
  for (const f of ['input', 'expected'] as const) {
    assert.match(cls({ [f]: 'one two three four' }).refusal ?? '', new RegExp(`^${f} has 4 word\\(s\\), the floor is 5`), f);
    assert.equal(cls({ [f]: 'one two three four five' }).refusal, undefined, `${f}: 5 words pass`);
  }
  assert.match(cls({ observed: 'src/orders/service.ts:42 returns every order today' }).refusal ?? '', /^observed has 4 word\(s\) besides its file:line, the floor is 5/, 'observed: the citation is not a word');
  assert.equal(cls({ observed: 'src/orders/service.ts:42 returns every order at once' }).refusal, undefined, 'observed: 5 words beside the citation pass');
});

test('must-FAIL: a blank / missing / whitespace-only field is refused with its name — recorded, never accepted', () => {
  for (const f of ['input', 'observed', 'expected'] as const) {
    for (const v of ['', '   \n\t ']) {
      const d = cls({ [f]: v });
      assert.match(d.refusal ?? '', new RegExp(`^${f} is (blank|missing)`), `${f} ${JSON.stringify(v)}`);
      assert.equal(demonstrationAccepted(d), false);
      assert.equal(d.file, undefined, 'nothing accepted: no file');
    }
  }
  assert.match(classifyDemonstration({ input: GOOD.input, expected: GOOD.expected } as never, { head: HEAD, fileOnHead: onHead('src/orders/service.ts') }).refusal ?? '', /^observed is blank or missing/);
});

test('must-FAIL: identical fields — all three, or any two (case and spacing ignored) — are refused', () => {
  const same = 'GET /orders?limit=0 returns every single order';
  assert.match(cls({ input: same, observed: same, expected: same }).refusal ?? '', /are the same text/);
  assert.match(cls({ input: 'The   ticket SAYS limit=0 must return an empty page' }).refusal ?? '', /^input and expected are the same text/);
  assert.match(cls({ expected: 'src/orders/service.ts:42 returns every order instead of an empty page' }).refusal ?? '', /^observed and expected are the same text/);
  assert.match(cls({ observed: GOOD.input }).refusal ?? '', /^input and observed are the same text/);
  assert.equal(textRefusal(GOOD), null);
});

test('must-FAIL: `observed` on a test file, a spec, a doc, a vendored file — or no file:line at all — is refused naming what it cited', () => {
  const ctx = { head: HEAD, fileOnHead: onHead('src/orders/service.test.ts', 'docs/orders.md', 'src/orders/service.ts', 'node_modules/x/index.js') };
  const obs = (cite: string): string => `${cite} returns every order instead of an empty page`;
  for (const [cite, kind] of [['src/orders/service.test.ts:7', 'test'], ['docs/orders.md:3', 'docs'], ['node_modules/x/index.js:1', 'vendored']] as const) {
    const d = cls({ observed: obs(cite) }, ctx);
    assert.match(d.refusal ?? '', new RegExp(`cites only ${cite.split(':')[0].replace(/[.]/g, '\\.')} \\(${kind}\\)`), cite);
    assert.equal(demonstrationAccepted(d), false);
  }
  assert.match(cls({ observed: 'the orders service returns every order instead of an empty page' }, ctx).refusal ?? '', /^observed names no file:line/);
  assert.match(cls({ observed: 'src/orders/service.ts returns every order instead of an empty page' }, ctx).refusal ?? '', /^observed names no file:line/, 'a file with no line is not a file:line');
  // a test file cited BESIDE a product one: the product one counts
  assert.equal(cls({ observed: obs('src/orders/service.test.ts:7 and src/orders/service.ts:42') }, ctx).file, 'src/orders/service.ts');
});

test('must-FAIL: `observed` on a file ABSENT from the head, an unreadable head, a ticket with no head — refused with that reason', () => {
  assert.match(cls({}, { head: HEAD, fileOnHead: onHead('src/other.ts') }).refusal ?? '', /^src\/orders\/service\.ts does not exist on head aaaaaaaa/);
  assert.match(cls({}, { head: HEAD, fileOnHead: () => null }).refusal ?? '', /cannot read src\/orders\/service\.ts on head aaaaaaaa \(not fetched\?\)/);
  assert.match(cls({}, { head: null, fileOnHead: onHead('src/orders/service.ts') }).refusal ?? '', /^the ticket has no recorded head/);
  assert.match(cls({}, { head: HEAD }).refusal ?? '', /no git/);
  const ok = cls({});
  assert.deepEqual([ok.file, ok.head, ok.refusal], ['src/orders/service.ts', HEAD, undefined]);
});

test('the product / test / docs rule: ONE classification', () => {
  const product = ['src/orders/service.ts', 'lib/a.py', 'main.go', 'app/Latest.ts', 'src/integration/stripe.ts', 'src/testing-utils.ts', 'Dockerfile', 'package.json', 'src/contest.ts', 'scripts/release.sh'];
  const test_ = ['src/a.test.ts', 'src/a.spec.tsx', 'test/helper.ts', 'tests/a.py', 'src/__tests__/a.ts', 'src/a.e2e-spec.ts', 'src/a.int-spec.ts', 'tests/test_x.py', 'pkg/x_test.go', 'spec/models/x_spec.rb', 'app/FooTest.java', 'app/FooTests.cs', 'conftest.py', 'src/a.stories.tsx', 'src/__snapshots__/a.snap', 'e2e/login.ts', 'src/fixtures/x.json', 'scripts/e2e-fanout.mjs', 'cypress/e2e/a.cy.ts'];
  const docs = ['README.md', 'docs/codebase-map/git.md', 'CHANGELOG', 'src/notes.txt', 'docs/x.ts', 'LICENSE', 'guide.rst'];
  const vendored = ['node_modules/x/a.js', 'dist/a.js', 'src/vendor/a.js', 'coverage/a.js'];
  for (const p of product) assert.equal(classifyPath(p), 'product', p);
  for (const p of test_) assert.equal(classifyPath(p), 'test', p);
  for (const p of docs) assert.equal(classifyPath(p), 'docs', p);
  for (const p of vendored) assert.equal(classifyPath(p), 'vendored', p);
  assert.equal(isProductPath('./src/orders/service.ts'), true);
});

test('citations: file:line and file:a-b, relative only, deduped; `..` and prose that merely looks like one are not files', () => {
  assert.deepEqual(citationsOf('see src/a.ts:12 and ./src/b.js:3-9 and src/a.ts:99'), [{ path: 'src/a.ts', line: 12 }, { path: 'src/b.js', line: 3 }]);
  assert.deepEqual(citationsOf('reads ../../etc/passwd.x:1 and http://host:80 and v1.2:3 and a.b.c'), []);
  assert.deepEqual(citationsOf('Order.ts:7'), [{ path: 'Order.ts', line: 7 }]);
});

test('a hand-edited stored demonstration cannot smuggle itself in: blank / short / identical texts, a test file, no file / head, or a refusal all read NOT accepted', () => {
  const ok = cls({});
  assert.equal(demonstrationAccepted(ok), true);
  assert.equal(demonstrationAccepted(undefined), false);
  assert.equal(demonstrationAccepted({ ...ok, input: ' ' }), false);
  assert.equal(demonstrationAccepted({ ...ok, expected: 'too short' }), false);
  assert.equal(demonstrationAccepted({ ...ok, expected: ok.input }), false);
  assert.equal(demonstrationAccepted({ ...ok, file: 'src/a.test.ts', observed: 'src/a.test.ts:1 returns every order instead of an empty page' }), false);
  assert.equal(demonstrationAccepted({ ...ok, file: 'src/other.ts' }), false, 'the file is not the one observed cites');
  assert.equal(demonstrationAccepted({ ...ok, head: undefined }), false);
  assert.equal(demonstrationAccepted({ ...ok, file: undefined }), false);
  assert.equal(demonstrationAccepted({ ...ok, refusal: 'x' }), false);
});
