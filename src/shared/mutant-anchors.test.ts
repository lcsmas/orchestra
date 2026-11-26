// #665 — the PR step that checks every mutant anchor (scripts/ci/mutant-anchors.mjs, loader scripts/lib/mutant-anchors.mjs). A fixture rig with a stale anchor fails, a valid one passes,
// nothing of the rig runs; the registry is pinned to .github/ci-rigs.json and to the rig scripts, so a new mutant rig or list can never be skipped silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { isMutantRig, readRigFile } from './ci-rigs.ts';
import { createWalker, repoTree } from './ci-closure.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lib = await import(pathToFileURL(path.join(root, 'scripts/lib/mutant-anchors.mjs')).href);
const registry = JSON.parse(fs.readFileSync(path.join(root, 'scripts/ci/mutant-anchors.json'), 'utf8'));
const driver = path.join(root, 'scripts/ci/mutant-anchors.mjs');
const nodeArgs = ['--experimental-strip-types', '--no-warnings'];

// ── the matcher and the shapes ───────────────────────────────────────────────────────────────────────────────────────────────────────────
test('occurrences / staleAnchors: exactly once, a regex counts its matches, `min` is "at least"', () => {
  assert.equal(lib.occurrences('a b a', 'a'), 2);
  assert.equal(lib.occurrences('a b a', 'z'), 0);
  assert.equal(lib.occurrences('a b a', ''), 0);
  assert.equal(lib.occurrences('xx1 xx2', /xx\d/), 2);
  const files: Record<string, string> = { 'f.ts': 'one two two' };
  const read = (f: string) => files[f] ?? null;
  const stale = lib.staleAnchors([
    { id: 'ok', file: 'f.ts', find: 'one' }, { id: 'twice', file: 'f.ts', find: 'two' }, { id: 'gone', file: 'f.ts', find: 'three' }, { id: 'nofile', file: 'g.ts', find: 'x' }, { id: 'nth', file: 'f.ts', find: 'two', min: 2 },
  ], read);
  assert.deepEqual(stale.map((s: { id: string; n: number }) => [s.id, s.n]), [['twice', 2], ['gone', 0], ['nofile', 0]]);
});

test('anchorsOf: the shapes the rigs use, and a shape it does not know throws', () => {
  const o = { dir: 'src/shared', file: 'src/shared/x.ts', root: '/r' };
  assert.deepEqual(lib.anchorsOf(['m1', 'src/a.ts', 'FROM', 'TO'], 0, o), [{ id: 'm1', file: 'src/a.ts', find: 'FROM' }]);
  assert.deepEqual(lib.anchorsOf(['m2', 'src/a.ts', [['F1', 'T1'], ['F2', 'T2']]], 0, o).map((a: { find: string }) => a.find), ['F1', 'F2']);
  assert.deepEqual(lib.anchorsOf({ id: 'm3', file: 'b.ts', find: 'F', to: 'T' }, 0, o), [{ id: 'm3', file: 'src/shared/b.ts', find: 'F' }]);
  assert.deepEqual(lib.anchorsOf({ name: 'm4', find: 'F', put: () => 'T', extra: [{ find: 'G', put: () => 'U' }, 'an arm name'] }, 0, o).map((a: { find: string; file: string }) => [a.find, a.file]), [['F', 'src/shared/x.ts'], ['G', 'src/shared/x.ts']]);
  assert.deepEqual(lib.anchorsOf({ id: 'm5', edits: [['src/a.ts', 'F', 'T'], ['src/b.ts', 'G', 'U']] }, 0, o).map((a: { file: string }) => a.file), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(lib.anchorsOf(['m6', [['src/a.ts', 'F', 'T']]], 0, o).map((a: { file: string }) => a.file), ['src/a.ts']);
  assert.deepEqual(lib.anchorsOf(['m7', 'a code string', 'T'], 0, { file: 'f.ts', root: '/r' }), [{ id: 'm7', file: 'f.ts', find: 'a code string' }]); // [name, from, to] of the list's file
  assert.deepEqual(lib.anchorsOf(['m8', '/r/src/a.ts', 'F', 'T'], 0, o).map((a: { file: string }) => a.file), ['src/a.ts']); // path.join(ROOT, …) is relative to the tree
  assert.equal(lib.anchorsOf(['m9', '/swarm: code that starts with a slash', 'T'], 0, { file: 'f.ts', root: '/r' })[0].file, 'f.ts');
  assert.throws(() => lib.anchorsOf({ id: 'x', surprise: true }, 4, { root: '/r' }), /mutant #4: unrecognised shape/);
  assert.throws(() => lib.anchorsOf(42, 0, o), /unrecognised shape/);
  assert.throws(() => lib.anchorsOf({ id: 'e', file: 'a.ts', find: '' }, 0, o), /empty or non-string anchor/);
});

// ── a fixture rig: stale fails, valid passes, nothing of the rig runs ─────────────────────────────────────────────────────────────────────
function fixture(name: string, mutants: string, extra = ''): { dir: string; reg: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mutant-anchors-${name}-`));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'target.ts'), 'export const alpha = () => 1;\nexport const beta = () => 2;\nexport const beta2 = () => 2;\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts":{}}');
  // the rig's runner follows the list: a call that RUNS the rig would drop this marker (the loader must never reach it)
  fs.writeFileSync(path.join(dir, 'scripts', 'fx-mutants.mjs'), `import fs from 'node:fs';\nconst T = 'src/target.ts';\n${extra}\nconst mutants = [\n${mutants}\n];\nfs.writeFileSync(new URL('./RIG-RAN', import.meta.url), 'ran');\nprocess.exit(9);\n`);
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ scripts: { 'scripts/fx-mutants.mjs': { lists: ['mutants'] } }, exempt: {} }));
  return { dir, reg };
}
const runDriver = (f: { dir: string; reg: string }) => spawnSync(process.execPath, [...nodeArgs, driver, '--all', '--root', f.dir, '--registry', f.reg, '--no-build'], { encoding: 'utf8', cwd: root });

test('fixture rig, valid anchors: the step passes and the rig never runs', () => {
  const f = fixture('valid', "  ['A1', T, 'alpha = () => 1', 'alpha = () => 0'],\n  { id: 'A2', file: T, find: 'export const beta = ', to: 'x' },");
  try {
    const r = runDriver(f);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /OK: 2 anchors/);
    assert.equal(fs.existsSync(path.join(f.dir, 'scripts', 'RIG-RAN')), false, 'the rig script was executed');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('fixture rig, a stale anchor: the step fails and names the mutant and the file; an anchor found twice fails too', () => {
  const f = fixture('stale', "  ['A1', T, 'alpha = () => 1', 'x'],\n  ['MOVED', T, 'export const gamma = () => 3', 'x'],\n  { id: 'TWICE', file: T, find: 'beta', to: 'x' },");
  try {
    const r = runDriver(f);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /::error::mutant anchor — .*scripts\/fx-mutants\.mjs: mutant MOVED anchors 0× in src\/target\.ts/);
    assert.match(r.stdout, /mutant TWICE anchors 2× in src\/target\.ts/);
    assert.doesNotMatch(r.stdout, /mutant A1/);
    assert.equal(fs.existsSync(path.join(f.dir, 'scripts', 'RIG-RAN')), false);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('fixture rig, a shape the loader does not know: the step fails (never skips)', () => {
  const f = fixture('shape', "  { id: 'ODD', what: 'ever' },");
  try {
    const r = runDriver(f);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /unrecognised shape/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('the list reads only what it depends on: a rig constant it uses is evaluated, a throwing statement it does not use is not', () => {
  const f = fixture('closure', "  ['C1', T, PRE + 'alpha', 'x'],", "const PRE = 'export const ';\nconst boom = (() => { throw new Error('the rig body ran'); });\nboom();");
  try {
    const r = runDriver(f);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /OK: 1 anchors/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// ── the selection: a PR that touches an anchored file selects its mutant rig (the #623 move out of a PR run is not applied here) ─────────────
test('selection: keepMutants keeps the mutant rig the changed file selects; without it the PR run moves it out', async () => {
  const { currentSelection } = await import(pathToFileURL(path.join(root, 'scripts/ci/selection.mjs')).href);
  const file = readRigFile(root);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutant-anchors-sel-'));
  const changedFile = path.join(dir, 'changed.txt'); fs.writeFileSync(changedFile, 'src/shared/fanout-record.ts\n');
  const was = process.env.CI_PATH_SELECTION; const wasFull = process.env.CI_FULL_REASON;
  process.env.CI_PATH_SELECTION = '1'; delete process.env.CI_FULL_REASON;
  try {
    assert.ok(currentSelection(root, file, { changedFile, keepMutants: true }).ran.some((r: { id: string }) => r.id === 'test:fanout-record-mutants'));
    assert.ok(!currentSelection(root, file, { changedFile }).ran.some((r: { id: string }) => r.id === 'test:fanout-record-mutants'));
  } finally { if (was === undefined) delete process.env.CI_PATH_SELECTION; else process.env.CI_PATH_SELECTION = was; if (wasFull !== undefined) process.env.CI_FULL_REASON = wasFull; fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── the registry is pinned to the rigs and to the scripts ───────────────────────────────────────────────────────────────────────────────
const walker = createWalker(repoTree(root), JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts ?? {});
const ciMutantRigs = readRigFile(root).rigs.filter((r) => r.class === 'RUNS_IN_CI' && isMutantRig(r.id));

test('every RUNS_IN_CI mutant rig reaches a registered script, or is exempt with a reason', () => {
  for (const rig of ciMutantRigs) {
    const files = walker.closure(rig.command).files;
    const reached = Object.keys(registry.scripts).filter((s) => files.has(s));
    if (reached.length) { assert.ok(!(rig.id in registry.exempt), `${rig.id} is registered AND exempt`); continue; }
    assert.ok(typeof registry.exempt[rig.id] === 'string' && registry.exempt[rig.id].trim(), `${rig.id}: reaches no script of scripts/ci/mutant-anchors.json and has no "exempt" reason`);
  }
  for (const id of Object.keys(registry.exempt)) assert.ok(ciMutantRigs.some((r) => r.id === id), `exempt rig ${id} is not a RUNS_IN_CI mutant rig of .github/ci-rigs.json`);
});

test('every registered script exists; "own" scripts carry --check-anchors; the others register every mutant list they declare', () => {
  const require = createRequire(path.join(root, 'package.json'));
  const ts = require('typescript');
  for (const [script, spec] of Object.entries<{ check?: string; lists?: Array<string | { name: string }> }>(registry.scripts)) {
    const text = fs.readFileSync(path.join(root, script), 'utf8'); // throws when the script is gone
    if (spec.check === 'own') { assert.ok(text.includes("'--check-anchors'"), `${script}: registry says own but no --check-anchors`); continue; }
    assert.ok(spec.lists?.length, `${script}: neither "check": "own" nor "lists"`);
    const named = new Set(spec.lists.map((l) => (typeof l === 'string' ? l : l.name)));
    const sf = ts.createSourceFile(script, text, ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
      const name = d.name.getText();
      let init = d.initializer; while (init && (ts.isAsExpression(init) || ts.isParenthesizedExpression(init))) init = init.expression;
      if (init && ts.isArrayLiteralExpression(init) && init.elements.length >= 3 && /^(?:[A-Z_]*MUTANTS|mutants|M)$/.test(name)) assert.ok(named.has(name), `${script}: top-level mutant list ${name} is not in the registry's lists`);
    }
  }
});

test('the real tree today: the loader reads every list, and for the rigs with their own --check-anchors it reads the same number of anchors', async () => {
  const mod = await import(pathToFileURL(driver).href + '?probe');
  for (const [script, spec] of Object.entries<{ check?: string; lists?: unknown[] }>(registry.scripts)) {
    if (spec.check !== 'own') {
      const anchors = await mod.scriptAnchors(root, script, spec);
      assert.ok(anchors.length >= 5, `${script}: only ${anchors.length} anchors read`);
      continue;
    }
    const own = spawnSync(process.execPath, [...nodeArgs, path.join(root, script), '--check-anchors'], { cwd: root, encoding: 'utf8' });
    const total = Number(/ANCHORS: \d+\/(\d+)/.exec(own.stdout)?.[1]);
    assert.ok(total > 0, `${script} --check-anchors printed no total: ${own.stdout}${own.stderr}`);
    const mine = await mod.scriptAnchors(root, script, { lists: ['MUTANTS'] });
    assert.equal(mine.length, total, `${script}: the loader reads ${mine.length} anchors, the rig's own check ${total}`);
  }
});
