// #542 — the frozen-test runner allowlist accepts `jest --config <tracked repo file> <frozen files>`: the parser clauses (must-PASS / must-FAIL), the config-bytes residue
// (recorded at freeze from the TARGET tip, hashed, refused at the gate and at deliver's re-read when it differs). REAL git on scratch repos; only gh is faked.
// Rig on the built CLI + mutants per clause: scripts/e2e-fanout-jest-config.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultRunner, type FanoutDeps, type Runner } from './fanout-state.ts';
import { checkAcceptanceInCheckout, realCheckoutIo, rereadFrozenAtHead, runAcceptance, type CheckoutIo } from './fanout-acceptance.ts';
import { acceptanceHash, applyTicketPatch, newState, parseRunArgv, parseRunSpec, parseState, readState, sha256Hex, stateFile, writeStateAtomic } from '../shared/fanout-state.ts';

const NOW = '2026-11-23T10:00:00.000Z';
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd: string) => (...a: string[]): string => execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const CFG = 'packages/api-v2/jest.e2e.config.ts';
const CFG_BYTES = "export default { testRegex: '.e2e.test.ts$' };\n";
const TEST = 'packages/api-v2/test/a.e2e.test.ts';
const RUN = `jest --config ${CFG} ${TEST}`;

// ── the parser: must-PASS / must-FAIL (issue #542) ────────────────────────────────────────────────────────

test('parseRunSpec must-PASS: jest --config <path> <frozen files>, in both spellings, with the inert flags', () => {
  for (const [c, cfg] of [
    [`jest --config ${CFG} ${TEST}`, CFG],
    [`jest --config=${CFG} ${TEST}`, CFG],
    [`jest --ci --runInBand --config ${CFG} ${TEST}`, CFG],
    [`jest ${TEST} --config=jest.config.js`, 'jest.config.js'],
  ] as const) {
    const s = parseRunSpec(c, [TEST]);
    assert.equal(s.config, cfg, c);
    assert.deepEqual(s.argv, c.split(' '), c); // executed exactly as written, no shell
  }
  assert.equal(parseRunSpec('jest --ci t/a.test.js', ['t/a.test.js']).config, null, 'no --config: unchanged');
  assert.deepEqual(parseRunArgv(RUN, [TEST]), RUN.split(' '));
});

test('parseRunSpec must-FAIL: path escape, non-frozen path, metacharacter, second --config, no value, any other jest flag, --config on another runner', () => {
  const bad: Array<[string, RegExp]> = [
    [`jest --config /etc/jest.config.js ${TEST}`, /unsafe acceptance path/],
    [`jest --config=/abs/jest.config.js ${TEST}`, /unsafe acceptance path/],
    [`jest --config ../jest.config.js ${TEST}`, /unsafe acceptance path/],
    [`jest --config=packages/../../x.js ${TEST}`, /unsafe acceptance path/],
    [`jest --config ./jest.config.js ${TEST}`, /unsafe acceptance path/],
    [`jest --config packages//x.js ${TEST}`, /unsafe acceptance path/],
    [`jest --config ${CFG} ${TEST} other.e2e.test.ts`, /not a frozen file/],
    [`jest --config ${CFG} ../${TEST}`, /not a frozen file/],
    [`jest --config ${CFG};id ${TEST}`, /shell metacharacters/],
    [`jest --config=$HOME/x.js ${TEST}`, /shell metacharacters/],
    [`jest --config "${CFG}" ${TEST}`, /shell metacharacters/],
    [`jest --config packages/*/jest.config.js ${TEST}`, /shell metacharacters/],
    [`jest --config ${CFG} --config ${CFG} ${TEST}`, /given twice/],
    [`jest --config ${CFG} --config=other.js ${TEST}`, /given twice/],
    [`jest --config=a.js --config=b.js ${TEST}`, /given twice/],
    [`jest ${TEST} --config`, /needs a value/],
    [`jest --config --ci ${TEST}`, /needs a value/],
    [`jest --config= ${TEST}`, /needs a value/],
    [`jest --config=-x ${TEST}`, /needs a value/],
    [`jest --config=a\\b.js ${TEST}`, /shell metacharacters/],
    [`jest --config a@b.js,c.js ${TEST}`, /unsafe runner config path/],
    [`jest -c ${CFG} ${TEST}`, /inert-flag allowlist/],
    [`jest --config ${CFG} --setupFiles=./x.js ${TEST}`, /inert-flag allowlist/],
    [`jest --config ${CFG} --rootDir=/tmp ${TEST}`, /inert-flag allowlist/],
    [`jest --config ${CFG} --testPathPattern=x ${TEST}`, /inert-flag allowlist/],
    [`jest --config ${CFG} --passWithNoTests ${TEST}`, /inert-flag allowlist/],
    [`jest --configx ${CFG} ${TEST}`, /inert-flag allowlist/],
    [`node --config ${CFG} ${TEST}`, /inert-flag allowlist/],
    [`vitest --config ${CFG} ${TEST}`, /inert-flag allowlist/],
    [`vitest run --config=${CFG} ${TEST}`, /inert-flag allowlist/],
    [`mocha --config ${CFG} ${TEST}`, /inert-flag allowlist/],
    [`jest --config ${CFG}`, /names none of the frozen files/],
    [`jest --config ${TEST}`, /names none of the frozen files/], // the value is the config, not a frozen file
    [`jest --config ${TEST} ${TEST}`, /also a frozen test/],
  ];
  for (const [c, re] of bad) assert.throws(() => parseRunSpec(c, [TEST]), re, c);
});

// ── state: the config is part of the frozen hash, and the schema pins it to the command ──────────────────────

test('state: acceptanceHash is unchanged without a config and binds the config path + bytes with one; the loader refuses a hand-edited / mismatched config', () => {
  const files = { [TEST]: sha256Hex('x') };
  const cfg = { path: CFG, sha256: sha256Hex(CFG_BYTES) };
  assert.equal(acceptanceHash(files, RUN), acceptanceHash(files, RUN, null), 'no config ⇒ the pre-#542 hash');
  assert.notEqual(acceptanceHash(files, RUN, cfg), acceptanceHash(files, RUN));
  assert.notEqual(acceptanceHash(files, RUN, cfg), acceptanceHash(files, RUN, { ...cfg, sha256: sha256Hex('other') }), 'the config bytes are in the hash');
  const doc = (acc: Record<string, unknown>) => JSON.parse(JSON.stringify({ ...applyTicketPatch(newState('r', { now: NOW }), 'T1', {}, NOW), tickets: { T1: { ...applyTicketPatch(newState('r', { now: NOW }), 'T1', {}, NOW).tickets.T1, acceptance: acc } } }));
  const good = { files, hash: acceptanceHash(files, RUN, cfg), run: RUN, config: cfg, source: { branch: 'b', head: 'a'.repeat(40) }, frozenAt: NOW, amendments: [] };
  assert.equal(parseState(doc(good)).tickets.T1.acceptance?.config?.path, CFG);
  assert.throws(() => parseState(doc({ ...good, config: { ...cfg, sha256: sha256Hex('tampered') } })), /does not match its files \+ command/);
  assert.throws(() => parseState(doc({ ...good, config: undefined })), /does not match|no matching acceptance.config/);
  assert.throws(() => parseState(doc({ ...good, run: `node --test ${TEST}`, hash: acceptanceHash(files, `node --test ${TEST}`, cfg) })), /names no --config/);
  assert.throws(() => parseState(doc({ ...good, config: { ...cfg, path: '../x.js' }, hash: acceptanceHash(files, RUN, { ...cfg, path: '../x.js' }) })), /unsafe acceptance path/);
  assert.throws(() => parseState(doc({ ...good, config: { ...cfg, extra: 1 } })), /unknown/i);
});

// ── freeze / amend / gate / deliver on real git ───────────────────────────────────────────────────────────

interface Rig { root: string; home: string; writer: string; cand: string; deps: FanoutDeps; w: ReturnType<typeof git>; g: ReturnType<typeof git>; freeze: (run?: string, extra?: string[]) => ReturnType<typeof runAcceptance>; acc: () => NonNullable<ReturnType<typeof readState>>['tickets'][string]['acceptance'] }

function rig(t: { after: (fn: () => void) => void }, o: { target?: string; noTargetConfig?: boolean } = {}): Rig {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'accept-542-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const writer = path.join(root, 'writer');
  const cand = path.join(root, 'cand');
  fs.mkdirSync(writer);
  const w = git(writer);
  w('init', '-q', '-b', 'master');
  fs.mkdirSync(path.join(writer, 'packages/api-v2/test'), { recursive: true });
  fs.writeFileSync(path.join(writer, 'packages/api-v2/src.ts'), 'export const f = () => 0;\n');
  if (!o.noTargetConfig) fs.writeFileSync(path.join(writer, CFG), CFG_BYTES);
  fs.mkdirSync(path.join(writer, 'cfgdir'));
  fs.writeFileSync(path.join(writer, 'cfgdir/real.config.js'), 'module.exports = {};\n');
  fs.symlinkSync('real.config.js', path.join(writer, 'cfgdir/link.config.js')); // a tracked symlink
  fs.symlinkSync('cfgdir', path.join(writer, 'linkdir')); // a tracked symlinked directory
  w('add', '.'); w('commit', '-q', '-m', 'root');
  w('checkout', '-q', '-b', 'writer-542');
  fs.writeFileSync(path.join(writer, TEST), "test('x', () => {});\n");
  fs.writeFileSync(path.join(writer, 'packages/api-v2/only-on-writer.config.ts'), 'export default {};\n'); // tracked on the writer's branch, NOT at the target tip
  w('add', '.'); w('commit', '-q', '-m', 'writer: tests');
  w('checkout', '-q', 'master');
  fs.writeFileSync(path.join(writer, 'packages/api-v2/untracked.config.ts'), 'export default {};\n'); // untracked
  execFileSync('git', ['clone', '-q', writer, cand], { env: GIT_ENV });
  const g = git(cand);
  g('checkout', '-q', '-b', 'impl-542', 'origin/master');
  g('fetch', '-q', 'origin', 'writer-542');
  g('checkout', 'FETCH_HEAD', '--', TEST);
  g('add', '.'); g('commit', '-q', '-m', 'impl: tests copied unchanged');
  const env = { ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: 'r1' };
  writeStateAtomic(stateFile(home, 'r1'), applyTicketPatch(newState('r1', { now: NOW, ...(o.target ? { target: o.target } : {}) }), 'T542', { branch: 'impl-542' }, NOW));
  const deps: FanoutDeps = { env, cwd: writer, runner: ((c, a, d) => defaultRunner(c, a, d)) as Runner, now: () => NOW, readStdin: () => '' };
  const freeze = (run = RUN, extra: string[] = []) => runAcceptance(['freeze', 'T542', '--files', TEST, '--run-cmd', run, '--from', 'writer-542', '--accept-unclassified', 'no jest here: this suite pins the config record (#542); the freeze check itself is #539', ...extra], deps); // #539: the freeze also runs the command on the target tip — no jest in this scratch repo ⇒ unclassified ⇒ the coordinator's recorded escape
  return { root, home, writer, cand, deps, w, g, freeze, acc: () => readState(stateFile(home, 'r1'))!.tickets.T542.acceptance };
}

test('freeze must-PASS: jest --config <tracked file> records the config path + the sha256 of its bytes at the target tip, in the hash', (t) => {
  const r = rig(t);
  const f = r.freeze();
  assert.equal(f.code, 0, f.stderr);
  const a = r.acc()!;
  assert.deepEqual(a.config, { path: CFG, sha256: sha256Hex(CFG_BYTES) });
  assert.equal(a.run, RUN);
  assert.equal(a.hash, acceptanceHash(a.files, RUN, a.config));
  assert.match(f.stdout, /runner config packages\/api-v2\/jest\.e2e\.config\.ts recorded/);
});

test('freeze must-PASS: the --config=<path> spelling and a command with no config freeze as before (config absent)', (t) => {
  const r = rig(t);
  assert.equal(r.freeze(`jest --config=${CFG} ${TEST}`).code, 0);
  assert.equal(r.acc()!.config?.path, CFG);
  const r2 = rig(t);
  assert.equal(r2.freeze(`jest --ci ${TEST}`).code, 0);
  assert.equal(r2.acc()!.config, undefined);
});

test('freeze must-FAIL (tracked-ness): untracked, writer-branch-only, absent, symlink, symlinked dir, directory ⇒ refused (2), nothing recorded', (t) => {
  const r = rig(t);
  for (const [cfg, re] of [
    ['packages/api-v2/untracked.config.ts', /not a file tracked at the tip of master/],
    ['packages/api-v2/only-on-writer.config.ts', /not a file tracked at the tip of master/], // the writer's own commit is not the target tip
    ['packages/api-v2/nope.config.ts', /not a file tracked/],
    ['cfgdir/link.config.js', /not a regular file at master \(mode 120000\)/],
    ['linkdir/real.config.js', /not a file tracked/], // behind a symlinked directory git lists no such path: no symlink escape
    ['cfgdir', /not a regular file|not a file tracked/],
  ] as const) {
    const f = r.freeze(`jest --config ${cfg} ${TEST}`);
    assert.equal(f.code, 2, `${cfg}: ${f.stderr}`);
    assert.match(f.stderr, re, cfg);
    assert.equal(r.acc(), null, `${cfg}: nothing frozen`);
  }
});

test('freeze must-FAIL: an unusable command is refused BEFORE anything is read or published (exit 1)', (t) => {
  const r = rig(t);
  for (const run of [`jest --config /etc/x.js ${TEST}`, `jest --config ../x.js ${TEST}`, `jest --config ${CFG} --config ${CFG} ${TEST}`, `jest --config ${TEST}`, `jest --config ${CFG} ${TEST} other.test.ts`, `jest -c ${CFG} ${TEST}`]) {
    const f = r.freeze(run);
    assert.equal(f.code, 1, `${run}: ${f.stderr}`);
    assert.equal(r.acc(), null);
  }
});

test('freeze: an uninspectable target tip is could-not-check (1), never "tracked"', (t) => {
  const r = rig(t, { target: 'nonexistent' });
  const f = r.freeze();
  assert.equal(f.code, 1);
  assert.match(f.stderr, /cannot inspect the target tip/);
  assert.equal(r.acc(), null);
});

test('amend re-records the config from the target tip: a config change accepted by a decision changes the hash; dropping --config drops the record', (t) => {
  const r = rig(t);
  assert.equal(r.freeze().code, 0);
  const before = r.acc()!;
  fs.writeFileSync(path.join(r.writer, CFG), "export default { testRegex: '.e2e.test.ts$', bail: 1 };\n");
  r.w('add', '.'); r.w('commit', '-q', '-m', 'target moves the config');
  const gh: Runner = (c, a, d) => c === 'gh' ? { code: 0, stdout: JSON.stringify({ body: 'Decision: the e2e config now bails on the first failure.' }), stderr: '' } : defaultRunner(c, a, d);
  const amend = (extra: string[]) => runAcceptance(['amend', 'T542', '--decision', 'https://github.com/o/r/issues/542#issuecomment-1', '--spec-sentence', 'the e2e config now bails on the first failure', '--files', TEST, ...extra], { ...r.deps, runner: gh });
  const a1 = amend([]);
  assert.equal(a1.code, 0, a1.stderr);
  const mid = r.acc()!;
  assert.equal(mid.config!.sha256, sha256Hex("export default { testRegex: '.e2e.test.ts$', bail: 1 };\n"));
  assert.notEqual(mid.hash, before.hash);
  assert.equal(mid.hash, acceptanceHash(mid.files, mid.run, mid.config));
  assert.deepEqual(mid.amendments[0].configAfter, mid.config, 'the amendment row records the config it re-recorded');
  assert.match(a1.stdout, /runner config packages\/api-v2\/jest\.e2e\.config\.ts: [0-9a-f]{12} → [0-9a-f]{12} — RE-RECORDED/);
  assert.equal(parseState(JSON.parse(fs.readFileSync(stateFile(r.home, 'r1'), 'utf8'))).tickets.T542.acceptance!.amendments[0].configAfter?.sha256, mid.config!.sha256, 'configAfter survives a state reload');
  const gh2: Runner = (c, a, d) => c === 'gh' ? { code: 0, stdout: JSON.stringify({ body: 'Decision 2: the e2e run no longer needs a config here.' }), stderr: '' } : defaultRunner(c, a, d);
  const a2 = runAcceptance(['amend', 'T542', '--decision', 'https://github.com/o/r/issues/542#issuecomment-2', '--spec-sentence', 'the e2e run no longer needs a config here', '--files', TEST, '--run-cmd', `jest --ci ${TEST}`], { ...r.deps, runner: gh2 });
  assert.equal(a2.code, 0, a2.stderr);
  assert.equal(r.acc()!.config, undefined);
  assert.equal(r.acc()!.amendments[1].configAfter, undefined, 'a config-less command records no configAfter');
  assert.match(a2.stdout, /runner config .* dropped/);
  assert.equal(r.acc()!.run, `jest --ci ${TEST}`);
});

const stubIo = (ran: string[][]): CheckoutIo => ({ ...realCheckoutIo, run: (argv) => { ran.push(argv); return { exit: 0, tail: '' }; } });

test('gate: config byte-identical ⇒ the command runs (argv as frozen) and the report carries the config; a changed / removed / symlinked config in the candidate ⇒ frozen-config-changed, NEVER run', (t) => {
  const r = rig(t);
  assert.equal(r.freeze().code, 0);
  const acc = r.acc()!;
  const head = () => r.g('rev-parse', 'HEAD');
  const ran: string[][] = [];
  const ok = checkAcceptanceInCheckout(acc, { cwd: r.cand, head: head(), ticket: 'T542' }, stubIo(ran));
  assert.equal(ok.ok, true, ok.detail);
  assert.deepEqual(ran, [RUN.split(' ')]);
  assert.deepEqual(ok.config, { path: CFG, status: 'same', config: true });
  assert.equal(ok.hash, acc.hash);

  const refused = (label: string, change: () => void, status: string) => {
    ran.length = 0;
    change(); r.g('add', '-A'); r.g('commit', '-q', '-m', label);
    const res = checkAcceptanceInCheckout(acc, { cwd: r.cand, head: head(), ticket: 'T542' }, stubIo(ran));
    assert.equal(res.ok, false, label);
    assert.equal(res.reason, 'frozen-config-changed', label);
    assert.equal(res.receipt.ok, false);
    assert.equal(res.config?.status, status, label);
    assert.match(res.detail ?? '', /runner config packages\/api-v2\/jest\.e2e\.config\.ts/);
    assert.match(res.detail ?? '', /target moved the config since the freeze/);
    assert.deepEqual(ran, [], `${label}: the changed config is never executed`);
  };
  refused('candidate edits the config', () => fs.writeFileSync(path.join(r.cand, CFG), "export default { testRegex: '.*' };\n"), 'changed');
  refused('candidate removes the config', () => fs.rmSync(path.join(r.cand, CFG)), 'missing');
  refused('candidate turns the config into a symlink', () => { fs.writeFileSync(path.join(r.cand, 'x.ts'), CFG_BYTES); fs.symlinkSync('../../x.ts', path.join(r.cand, CFG)); }, 'missing');
  // …and a changed frozen TEST still outranks (reason unchanged: the config clause is additive)
  fs.writeFileSync(path.join(r.cand, TEST), "test('x', () => { throw 1; });\n"); r.g('add', '-A'); r.g('commit', '-q', '-m', 'edit test');
  assert.equal(checkAcceptanceInCheckout(acc, { cwd: r.cand, head: head() }, stubIo(ran)).reason, 'frozen-test-changed');
});

test('gate: an uncommitted edit of the config is a dirty checkout (acceptance-stale-checkout), not a pass', (t) => {
  const r = rig(t);
  assert.equal(r.freeze().code, 0);
  fs.writeFileSync(path.join(r.cand, CFG), 'export default {};\n');
  const res = checkAcceptanceInCheckout(r.acc()!, { cwd: r.cand, head: r.g('rev-parse', 'HEAD') }, stubIo([]));
  assert.equal(res.reason, 'acceptance-stale-checkout');
});

test('deliver re-read: the config at the PR head is checked against the recorded bytes (changed / missing ⇒ an entry flagged config:true); unchanged ⇒ same', async (t) => {
  const r = rig(t);
  assert.equal(r.freeze().code, 0);
  const acc = r.acc()!;
  const at = (cfgBytes: string | null) => async (args: string[]) => {
    const url = args[args.length - 1];
    if (/\/commits\//.test(url)) return { code: 0, stdout: '{}', stderr: '' };
    if (url.includes(encodeURIComponent('a.e2e.test.ts'))) return { code: 0, stdout: "test('x', () => {});\n", stderr: '' };
    if (url.includes('jest.e2e.config.ts')) return cfgBytes === null ? { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' } : { code: 0, stdout: cfgBytes, stderr: '' };
    return { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
  };
  const head = 'a'.repeat(40);
  assert.deepEqual((await rereadFrozenAtHead(acc, head, 'o/r', at(CFG_BYTES))).map((f) => f.status), ['same', 'same']);
  const changed = await rereadFrozenAtHead(acc, head, 'o/r', at('export default {};\n'));
  assert.deepEqual(changed.filter((f) => f.status !== 'same'), [{ path: CFG, config: true, status: 'changed' }]);
  const gone = await rereadFrozenAtHead(acc, head, 'o/r', at(null));
  assert.deepEqual(gone.filter((f) => f.status !== 'same'), [{ path: CFG, config: true, status: 'missing' }]);
});
