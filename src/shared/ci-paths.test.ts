// #595 — path selection: a changed-file list in → the rigs to run + why out; the recall check (every rig's declared paths cover what its own command reaches), each with a must-FAIL arm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalker, repoTree, walkedDirs, type Tree } from './ci-closure.ts';
import { compressPaths, expandPaths, generatePaths, matchPaths, recallProblems, renderSelection, selectRigs, toWire, validatePatterns } from './ci-paths.ts';
import { readRigFile, validateRigs, requiredRigIds, type RigFile } from './ci-rigs.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ci = (id: string, paths?: string[]) => ({ id, command: `pnpm run ${id}`, class: 'RUNS_IN_CI' as const, ...(paths ? { paths } : {}) });
const fixture = (): RigFile => ({
  sharedPaths: ['package.json', '.github/workflows/**'],
  noRigPaths: ['docs/**', '**/*.test.ts'],
  rigs: [
    ci('test:a', ['src/a/**', '!**/*.test.ts', 'src/a/pinned.test.ts']),
    ci('test:b', ['src/b.ts', 'scripts/b.sh']),
    ci('test:always'),
    { id: 'test:local', command: 'x', class: 'LOCAL_ONLY', reason: 'r', paths: ['src/local/**'] },
  ],
});
const ids = (s: { ran: { id: string }[] }) => s.ran.map((r) => r.id).sort();

test('globs: ** crosses directories, * does not, a later entry overrides an earlier one (the last match wins)', () => {
  assert.ok(matchPaths(['src/**'], 'src/a/b/c.ts'));
  assert.ok(!matchPaths(['src/*'], 'src/a/b.ts'));
  assert.ok(matchPaths(['**/*.test.ts'], 'x.test.ts') && matchPaths(['**/*.test.ts'], 'a/b/x.test.ts'));
  assert.ok(!matchPaths(['src/**', '!**/*.test.ts'], 'src/x.test.ts'));
  assert.ok(matchPaths(['src/**', '!**/*.test.ts', 'src/x.test.ts'], 'src/x.test.ts'), 'an explicit re-include after the negation wins');
  assert.equal(matchPaths(['vite*.config.ts'], 'vite.cli.config.ts'), 'vite*.config.ts');
  assert.ok(!matchPaths(['a.b'], 'aXb'), 'a dot is a dot');
});

test('a change selects exactly the rigs whose paths it touches; the others are skipped with a reason', () => {
  const s = selectRigs(fixture(), ['src/a/x.ts']);
  assert.equal(s.mode, 'paths');
  assert.deepEqual(ids(s), ['test:a', 'test:always']);
  assert.deepEqual(s.skipped.map((r) => r.id), ['test:b']);
  assert.match(s.ran.find((r) => r.id === 'test:a')!.why, /changed: src\/a\/x\.ts/);
  assert.match(s.skipped[0].why, /no changed file in its paths/);
  assert.match(s.ran.find((r) => r.id === 'test:always')!.why, /runs always/);
});

test('a test file selects only the rig that declares it explicitly; a docs-only change selects only the always-rigs', () => {
  assert.deepEqual(ids(selectRigs(fixture(), ['src/a/other.test.ts'])), ['test:always']);
  assert.deepEqual(ids(selectRigs(fixture(), ['src/a/pinned.test.ts'])), ['test:a', 'test:always']);
  const docs = selectRigs(fixture(), ['docs/x.md']);
  assert.equal(docs.mode, 'paths'); assert.deepEqual(ids(docs), ['test:always']);
});

test('a shared file, an unclaimed file, the full flag and an unreadable list EACH run everything (the reason names why)', () => {
  const all = ['test:a', 'test:always', 'test:b'];
  const shared = selectRigs(fixture(), ['src/b.ts', 'package.json']);
  assert.equal(shared.mode, 'all'); assert.deepEqual(ids(shared), all); assert.match(shared.fullReason!, /shared file package\.json/);
  const unclaimed = selectRigs(fixture(), ['src/b.ts', 'tools/new-thing.mjs']);
  assert.equal(unclaimed.mode, 'all'); assert.deepEqual(ids(unclaimed), all); assert.match(unclaimed.fullReason!, /unclaimed file tools\/new-thing\.mjs/);
  const full = selectRigs(fixture(), ['docs/x.md'], 'the ci-full label forces every rig');
  assert.equal(full.mode, 'all'); assert.deepEqual(ids(full), all); assert.match(full.fullReason!, /ci-full/);
  for (const none of [[], null, undefined]) { const s = selectRigs(fixture(), none as never); assert.equal(s.mode, 'all'); assert.match(s.fullReason!, /no changed-file list/); }
  assert.deepEqual(shared.skipped, []);
});

test('a file only a LOCAL_ONLY rig covers is UNCLAIMED (CI never runs that rig: everything runs) and the rig is still named as one CI does not run', () => {
  const s = selectRigs(fixture(), ['src/local/x.ts']);
  assert.equal(s.mode, 'all'); assert.match(s.fullReason!, /unclaimed file src\/local\/x\.ts/);
  assert.deepEqual(s.localOnly.map((r) => r.id), ['test:local']);
  const md = renderSelection(toWire(selectRigs(fixture(), ['src/a/x.ts'])), 3);
  assert.match(md, /skipped by path/);
  assert.match(renderSelection(toWire(selectRigs({ ...fixture(), noRigPaths: ['docs/**', 'src/local/**'] }, ['src/local/x.ts'])), 3), /LOCAL_ONLY rigs linked to this change.*test:local/);
});

test('delta files: a package.json that only edits rig scripts / a ci-rigs.json that only edits rig entries select THOSE rigs; anything else is shared', () => {
  const file: RigFile = { ...fixture(), sharedPaths: ['package.json', '.github/ci-rigs.json'], rigs: [...fixture().rigs, ci('test:c', ['src/c.ts'])] };
  const pkg = (scripts: Record<string, string>, extra: object = {}) => JSON.stringify({ name: 'x', version: '1.0.0', scripts, ...extra });
  const run = (p: string, before: string, after: string, f = file) => selectRigs(f, [p], null, { before: () => before, after: () => after });
  const base = { 'test:c': 'node c.mjs', 'build:cli': 'vite build' };
  let s = run('package.json', pkg(base), pkg({ ...base, 'test:c': 'node c2.mjs' }));
  assert.equal(s.mode, 'paths'); assert.deepEqual(ids(s), ['test:always', 'test:c']); assert.match(s.ran.find((r) => r.id === 'test:c')!.why, /package\.json script test:c changed/);
  s = run('package.json', pkg(base), pkg({ ...base, 'test:new': 'node n.mjs' }));
  assert.equal(s.mode, 'paths'); assert.deepEqual(ids(s), ['test:always']);
  s = run('package.json', pkg(base), pkg({ ...base, 'build:cli': 'vite build --x' })); assert.equal(s.mode, 'all'); assert.match(s.fullReason!, /build:cli/);
  s = run('package.json', pkg(base), pkg(base, { dependencies: { a: '1' } })); assert.equal(s.mode, 'all'); assert.match(s.fullReason!, /`dependencies` changed/);
  assert.equal(selectRigs(file, ['package.json']).mode, 'all', 'no way to read the edit ⇒ plain shared');
  assert.equal(run('package.json', 'not json', pkg(base)).mode, 'all');
  // a rig whose command reaches the changed script through another script
  const chained: RigFile = { ...file, rigs: [{ ...ci('test:wrap'), command: 'pnpm run test:c', paths: ['src/wrap.ts'] }, ...file.rigs] };
  assert.ok(ids(run('package.json', pkg(base), pkg({ ...base, 'test:c': 'node c2.mjs' }), chained)).includes('test:wrap'));
  const rigs = (list: object[], top: object = {}) => JSON.stringify({ groups: 3, ...top, rigs: list });
  const e1 = { id: 'test:c', command: 'pnpm run test:c', class: 'RUNS_IN_CI', group: 1 };
  s = run('.github/ci-rigs.json', rigs([e1]), rigs([e1, { id: 'test:n', command: 'pnpm run test:n', class: 'RUNS_IN_CI', group: 2 }]), { ...file, rigs: [...file.rigs, ci('test:n', ['src/n.ts'])] });
  assert.equal(s.mode, 'paths'); assert.ok(ids(s).includes('test:n') && !ids(s).includes('test:c'));
  s = run('.github/ci-rigs.json', rigs([e1]), rigs([{ ...e1, group: 5, wallSec: 9, paths: ['x'] }])); assert.equal(s.mode, 'paths'); assert.ok(!ids(s).includes('test:c'), 'a group/wallSec/paths edit changes no rig behaviour');
  s = run('.github/ci-rigs.json', rigs([e1]), rigs([{ ...e1, command: 'pnpm run other' }])); assert.ok(ids(s).includes('test:c'));
  s = run('.github/ci-rigs.json', rigs([e1]), rigs([e1], { groups: 4 })); assert.equal(s.mode, 'all'); assert.match(s.fullReason!, /top-level `groups` changed/);
});

test('validatePatterns refuses empty, absolute, ./, .. and negation-only lists; validateRigs names an unknown @set', () => {
  assert.equal(validatePatterns('x', ['src/**']).length, 0);
  for (const bad of [[], ['/abs'], ['./rel'], ['a/../b'], ['!only'], [''], 'str']) assert.ok(validatePatterns('x', bad as never).length > 0, JSON.stringify(bad));
  const f: RigFile = { rigs: [{ ...ci('test:a', ['@nope', 'src/**']) }] };
  assert.ok(validateRigs(f, ['test:a']).some((p) => /@nope.*not in pathSets/.test(p)));
  assert.deepEqual(expandPaths({ pathSets: { s: ['a/**', '!**/*.test.ts'] } }, ['@s', 'b.ts']), ['a/**', '!**/*.test.ts', 'b.ts']);
});

test('compressPaths: a directory the closure fills becomes a glob (tests re-included by name), a partly used one stays exact files', () => {
  const repo = [...Array.from({ length: 10 }, (_, i) => `src/full/f${i}.ts`), 'src/full/f0.test.ts', ...Array.from({ length: 20 }, (_, i) => `src/part/p${i}.ts`)];
  const out = compressPaths(['src/full/f0.test.ts', ...Array.from({ length: 10 }, (_, i) => `src/full/f${i}.ts`), 'src/part/p0.ts'], repo);
  assert.deepEqual(out, ['src/full/**', 'src/part/p0.ts', '!**/*.test.ts', '!**/*.test.tsx', '!**/*.test.mjs', 'src/full/f0.test.ts']);
  for (const f of ['src/full/f3.ts', 'src/full/f0.test.ts', 'src/part/p0.ts']) assert.ok(matchPaths(out, f), f);
  assert.ok(!matchPaths(out, 'src/part/p1.ts') && !matchPaths(out, 'src/full/new.test.ts'));
});

// ---- the recall check ------------------------------------------------------------------------------------------------------------
const mini: Tree = (() => { const files: Record<string, string> = { 'scripts/e2e-x.mjs': "import { a } from '../src/x/a.ts';\nimport './helper.mjs';\n", 'scripts/helper.mjs': '', 'src/x/a.ts': '', 'src/y/b.ts': '' }; return { files: Object.keys(files), read: (p) => files[p] ?? '' }; })();
const miniRig = (paths?: string[]): RigFile => ({ rigs: [{ id: 'scripts/e2e-x.mjs', command: 'node scripts/e2e-x.mjs', class: 'RUNS_IN_CI', ...(paths ? { paths } : {}) }] });

test('recall: declared paths that cover the rig\'s own imports pass; one that misses an import is refused and names it (MUST-FAIL arm)', () => {
  assert.deepEqual(recallProblems(miniRig(['scripts/e2e-x.mjs', 'scripts/helper.mjs', 'src/x/a.ts']), mini, {}), []);
  const p = recallProblems(miniRig(['scripts/e2e-x.mjs', 'scripts/helper.mjs']), mini, {});
  assert.equal(p.length, 1); assert.match(p[0], /scripts\/e2e-x\.mjs.*src\/x\/a\.ts/);
  assert.deepEqual(recallProblems(miniRig(['scripts/e2e-x.mjs', 'scripts/helper.mjs', 'src/y/**']), mini, {}).length, 1, 'a path next to the import is not the import');
  assert.deepEqual(recallProblems(miniRig(), mini, {}), [], 'no declared paths ⇒ runs always ⇒ cannot miss');
  assert.deepEqual(recallProblems({ ...miniRig(['scripts/e2e-x.mjs']), sharedPaths: ['scripts/helper.mjs', 'src/x/a.ts'] }, mini, {}), [], 'a shared path runs everything, so it is covered');
});

test('recall: generatePaths output satisfies the recall check by construction (and survives a new import only after regeneration)', () => {
  const gen = generatePaths(miniRig(), mini, {});
  const file: RigFile = { ...miniRig(gen.paths['scripts/e2e-x.mjs']), pathSets: gen.pathSets };
  assert.deepEqual(recallProblems(file, mini, {}), []);
  const grown: Tree = { files: [...mini.files, 'src/x/new.ts'], read: (p) => (p === 'src/x/a.ts' ? "import './new.ts';\n" : mini.read(p)) };
  assert.equal(grown.files.length, mini.files.length + 1);
  const wrong = { ...file, rigs: [{ ...file.rigs[0], paths: file.rigs[0].paths!.filter((p) => p !== 'src/x/a.ts') }] };
  assert.equal(recallProblems(wrong, grown, {}).length, 1);
});

const real = readRigFile(root);
const realTree = repoTree(root);
const pkgScripts = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;

test('the repo: the data file is valid, every rig that declares paths covers its own imports, and every RUNS_IN_CI rig declares them', () => {
  assert.deepEqual(validateRigs(real, requiredRigIds(root).ids), []);
  assert.deepEqual(recallProblems(real, realTree, pkgScripts), []);
  const undeclared = real.rigs.filter((r) => r.class === 'RUNS_IN_CI' && !r.paths).map((r) => r.id);
  assert.deepEqual(undeclared, [], 'a rig with no paths runs on every PR: declare them with `node --experimental-strip-types scripts/ci/rigs.mjs paths <id> --write`, or list it here on purpose');
});

test('the repo: the recall check really bites — truncating one real rig\'s paths to its entry script is refused', () => {
  const victim = real.rigs.find((r) => r.id === 'scripts/e2e-hibernate-wake.sh')!;
  assert.ok(victim.paths && victim.paths.length > 1);
  const cut: RigFile = { ...real, rigs: real.rigs.map((r) => (r === victim ? { ...r, paths: ['scripts/e2e-hibernate-wake.sh'] } : r)) };
  const p = recallProblems(cut, realTree, pkgScripts);
  assert.equal(p.length, 1); assert.match(p[0], /^scripts\/e2e-hibernate-wake\.sh: its own command reaches/);
});

test('the repo: one change inside any rig\'s own closure selects that rig (the "mutant of the code it covers" arm, every rig)', () => {
  const w = createWalker(realTree, pkgScripts);
  const missed: string[] = [];
  for (const r of real.rigs.filter((x) => x.class === 'RUNS_IN_CI')) {
    const files = [...w.closure(r.command).files].filter((f) => !/\.test\.(ts|tsx|mjs)$/.test(f) && f !== 'package.json' && !matchPaths(real.sharedPaths ?? [], f)).sort();
    assert.ok(files.length > 0, `${r.id} reaches no file`);
    const picks = [files[0], files[Math.floor(files.length / 2)], files[files.length - 1]];
    for (const f of picks) { const s = selectRigs(real, [f]); if (s.mode !== 'paths' || !s.ran.some((x) => x.id === r.id)) missed.push(`${r.id} not selected by ${f}`); }
  }
  assert.deepEqual(missed, []);
});

test('the repo: a shared file, an unclaimed file and `ci-full` each run every RUNS_IN_CI rig; a docs-only change runs none', () => {
  const total = real.rigs.filter((r) => r.class === 'RUNS_IN_CI').length;
  assert.ok(total > 100);
  for (const [label, s] of [
    ['vite.config.ts', selectRigs(real, ['vite.config.ts'])],
    ['pnpm-lock.yaml', selectRigs(real, ['pnpm-lock.yaml'])],
    ['.github/workflows/ci.yml', selectRigs(real, ['.github/workflows/ci.yml'])],
    ['ci-rigs.json (no way to read the edit)', selectRigs(real, ['.github/ci-rigs.json'])],
    ['an unclaimed file', selectRigs(real, ['zz-unclaimed-top-level-file.xyz'])],
    ['ci-full', selectRigs(real, ['docs/a.md'], 'the ci-full label forces every rig')],
  ] as const) { assert.equal(s.mode, 'all', label); assert.equal(s.ran.length, total, label); }
  const docs = selectRigs(real, ['docs/codebase-map/git.md', '.claude/skills/ship/SKILL.md']);
  assert.equal(docs.mode, 'paths'); assert.equal(docs.ran.length, 0);
});

// ---- review round 1 (#615): walked directories, scripts reached through script files, the ci.yml triggers ---------------------------------------------------
const walkTree = (extra: Record<string, string> = {}): Tree => { const files: Record<string, string> = {
  'scripts/e2e-w.sh': 'node scripts/check-w.mjs\n',
  'scripts/check-w.mjs': "const walk = (d) => fs.readdirSync(d);\nfor (const f of walk(path.join(root, 'src'))) {}\n",
  'src/a/x.ts': '', 'src/b/y.ts': '', ...extra }; return { files: Object.keys(files), read: (p) => files[p] ?? '' }; };
const walkRig = (paths?: string[]): RigFile => ({ rigs: [{ id: 'scripts/e2e-w.sh', command: 'bash scripts/e2e-w.sh', class: 'RUNS_IN_CI', ...(paths ? { paths } : {}) }] });

test('F2: a gate script that WALKS src is detected, generated into `src/**`, and a rig without it is refused (must-FAIL); the other walk arguments are not src', () => {
  assert.deepEqual(walkedDirs("for (const f of walk(path.join(root, 'src'))) {}"), ['src']);
  assert.deepEqual(walkedDirs("walk(path.join(root, 'src/main'))"), ['src/main']);
  assert.deepEqual(walkedDirs("// walk(path.join(root, 'src'))\nfs.cpSync(path.join(ROOT, 'src'), tmp)"), [], 'a comment and a copy are not a walk');
  assert.deepEqual(walkedDirs("fs.readdirSync(path.join(PKG, 'lib'))"), []);
  assert.deepEqual([...createWalker(walkTree(), {}).closure('bash scripts/e2e-w.sh').walked], ['src']);
  const gen = generatePaths(walkRig(), walkTree(), {});
  assert.ok(gen.paths['scripts/e2e-w.sh'].includes('src/**'), JSON.stringify(gen.paths));
  assert.deepEqual(recallProblems({ ...walkRig(gen.paths['scripts/e2e-w.sh']), pathSets: gen.pathSets }, walkTree(), {}), []);
  const noWalk = recallProblems(walkRig(['scripts/e2e-w.sh', 'scripts/check-w.mjs']), walkTree(), {});
  assert.equal(noWalk.length, 1); assert.match(noWalk[0], /walks src\//);
  // the selection consequence: an unrelated src file selects the gate rig only when `src/**` is declared
  assert.ok(selectRigs(walkRig(gen.paths['scripts/e2e-w.sh']), ['src/b/y.ts']).ran.length === 1);
  assert.equal(selectRigs(walkRig(['scripts/e2e-w.sh', 'scripts/check-w.mjs']), ['src/b/y.ts']).mode, 'all', 'unclaimed ⇒ all (the rig above does not claim it)');
});

test('F2 repo: every rig whose closure scripts walk a repo dir declares it, and the three single-reader gates carry `src/**`', () => {
  const w = createWalker(realTree, pkgScripts);
  const gated = real.rigs.filter((r) => r.class === 'RUNS_IN_CI' && w.closure(r.command).walked.size > 0);
  assert.ok(gated.some((r) => r.id === 'test:spawn-account-inherit') && gated.some((r) => r.id === 'test:plain-parent-mutants'), gated.map((r) => r.id).join());
  for (const r of gated) for (const d of w.closure(r.command).walked) assert.ok(matchPaths(expandPaths(real, r.paths!), `${d}/__any__.ts`), `${r.id} walks ${d}/ but does not declare it`);
  assert.ok(!selectRigs(real, ['src/renderer/App.tsx']).ran.every((x) => x.id !== 'test:spawn-account-inherit'), 'App.tsx selects the resolver gate (the review\'s demonstration)');
});

test('F4: a path built from literal join segments is seen (a fixture dir copied by path.join(REPO, "scripts", "fixtures", …))', () => {
  const t: Tree = { files: ['scripts/m.mjs', 'scripts/fixtures/payloads/a.json', 'scripts/fixtures/payloads/b.json'], read: (p) => (p === 'scripts/m.mjs' ? "copyTree(path.join(REPO, 'scripts', 'fixtures', 'payloads'), dest);\n" : '') };
  assert.deepEqual([...createWalker(t, {}).closure('node scripts/m.mjs').files].sort(), ['scripts/fixtures/payloads/a.json', 'scripts/fixtures/payloads/b.json', 'scripts/m.mjs']);
  assert.ok(selectRigs(real, ['scripts/fixtures/payloads/local-command.capture.json']).ran.some((r) => r.id === 'test:command-output-mutants'));
});

test('F6: a changed package.json script selects every rig that reaches it THROUGH a script file (scriptsReachedBy), not only through its own command', () => {
  const t: Tree = { files: ['scripts/gate.sh', 'scripts/verify.sh'], read: (p) => (p === 'scripts/verify.sh' ? 'bash scripts/gate.sh\n' : p === 'scripts/gate.sh' ? 'pnpm run test:inner\n' : '') };
  const scripts = { 'test:inner': 'node a.mjs', 'test:outer': 'bash scripts/verify.sh' };
  const file: RigFile = { sharedPaths: ['package.json'], rigs: [{ id: 'test:outer', command: 'pnpm run test:outer', class: 'RUNS_IN_CI', paths: ['scripts/**'] }, ci('test:other', ['src/o.ts'])] };
  const pkg = (inner: string) => JSON.stringify({ scripts: { ...scripts, 'test:inner': inner } });
  const ctx = { before: () => pkg('node a.mjs'), after: () => pkg('node a2.mjs') };
  assert.ok(!selectRigs(file, ['package.json'], null, ctx).ran.some((r) => r.id === 'test:outer'), 'command text alone does not see the hop (the review\'s 4 cases)');
  const w = createWalker(t, scripts);
  const withWalk = selectRigs(file, ['package.json'], null, { ...ctx, scriptsReachedBy: (r) => w.closure(r.command).scripts });
  assert.equal(withWalk.mode, 'paths'); assert.ok(withWalk.ran.some((r) => r.id === 'test:outer') && !withWalk.ran.some((r) => r.id === 'test:other'));
  // repo: the review's 4 cases
  const rw = createWalker(realTree, pkgScripts);
  for (const [rig, script] of [['test:release-gate', 'test:session-budget'], ['test:release-receipt', 'test:admission-hold'], ['test:release-receipt-mutants', 'test:admission-wake'], ['test:rig-selftest', 'test:rig-selftest']] as const) {
    assert.ok(rw.closure(real.rigs.find((r) => r.id === rig)!.command).scripts.has(script) || rig === 'test:rig-selftest', `${rig} reaches ${script}`);
  }
});

test('F5: ci.yml re-runs on `labeled` (ci-full added after the push) and only the `ci-full` label forces everything', () => {
  const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(wf, /^    types: \[opened, synchronize, reopened, labeled\]$/m);
  assert.match(wf, /contains\(github\.event\.pull_request\.labels\.\*\.name, 'ci-full'\) && 'the ci-full label forces every rig'/);
  assert.equal(wf.match(/'ci-full'/g)!.length, 1, 'no other label is read');
  assert.match(wf, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});
