// scripts/migrate-parent-names.mjs (#385) against a FIXTURE store in a scratch ORCHESTRA_HOME, a real local origin, and a fake `orchestra` on PATH.
// Never touches the live ~/.orchestra: the child env is an allowlist (no ORCHESTRA_SOCK, HOME and ORCHESTRA_HOME in the scratch dir).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(REPO, 'scripts', 'migrate-parent-names.mjs');
const id = (n: string): string => `${n.padEnd(8, '0')}-0000-4000-8000-000000000000`;
const LEAD = id('1ead');
const OPS_RUN = id('0b5a');
const OPS_DONE = id('0b5c');

let tmp = '';
let repo = '';
let bin = '';
let home = '';
let storeFile = '';
let callsLog = '';
let tableFile = '';
let wtW3 = '';
const PKG_VERSION = (JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { version: string }).version;
/** The app's startup banner (logger.ts) — the script's preflight reads the RUNNING app's version from it. */
function writeBanner(version: string = PKG_VERSION, pid: number = process.pid, bannerHome: string = home): void {
  const dir = path.join(home, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'orchestra.log'), `2026-10-16T10:00:00.000Z INFO  === Orchestra ${version} (electron) starting === pid=${pid} platform=linux electron=33.4.11 node=20.18.3 logLevel=info home=${bannerHome}\n`);
}
const gitDir = path.dirname(execFileSync('which', ['git'], { encoding: 'utf8' }).trim());

function fixtureWorkspaces(): Array<Record<string, unknown>> {
  const w = (n: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: id(n), branch: `old-${n}`, repoPath: repo, name: `repo · old-${n}`, ...extra });
  return [
    w('1ead', { branch: 'lead-main', kind: 'orchestrator', repoPath: '' }),
    w('0b5a', { branch: 'wave-g-ops', parentId: LEAD, canOrchestrate: true }),
    w('w1', { parentId: OPS_RUN }), // running vague
    w('0b5c', { branch: 'wave-c-ops', parentId: LEAD, canOrchestrate: true, archived: true }),
    w('w3', { parentId: OPS_DONE, worktreePath: wtW3 }), // a REAL worktree: the read-back also checks git HEAD
    w('w6', { parentId: LEAD, namedByParent: OPS_DONE }), // re-parented by `attach`: parentId and the namer differ
    w('w4', { parentId: LEAD }),
    w('w5', { parentId: LEAD }), // old-w5 is pushed to origin
    w('h1'), // human-created
    w('d1'), // in the table, no spawner
  ];
}
const TABLE = [
  { id: id('w1'), old: 'old-w1', new: 'impl-vague-en-cours-1' },
  { id: id('w3'), old: 'old-w3', new: 'review-fusion-comptes-240' },
  { id: id('w4'), old: 'old-w4', new: 'explo-timeout-cli' },
  { id: id('w5'), old: 'old-w5', new: 'impl-branche-poussee-5' },
  { id: id('d1'), old: 'old-d1', new: 'impl-sans-parent-6' },
];
const TABLE_W6 = [{ id: id('w6'), old: 'old-w6', new: 'impl-reparente-6' }];

before(() => {
  tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'nm385-'));
  home = path.join(tmp, 'orchestra-home');
  storeFile = path.join(home, 'userData', 'orchestra', 'store.json');
  repo = path.join(tmp, 'repo');
  bin = path.join(tmp, 'bin');
  callsLog = path.join(tmp, 'calls.log');
  tableFile = path.join(tmp, 'table.json');
  const g = (cwd: string, ...a: string[]): void => {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: { PATH: gitDir, HOME: tmp }, stdio: 'pipe' });
  };
  fs.mkdirSync(path.join(tmp, 'origin.git'));
  g(path.join(tmp, 'origin.git'), 'init', '--bare', '-b', 'master');
  fs.mkdirSync(repo);
  g(repo, 'init', '-b', 'master');
  g(repo, 'commit', '--allow-empty', '-m', 'init');
  g(repo, 'remote', 'add', 'origin', path.join(tmp, 'origin.git'));
  g(repo, 'branch', 'old-w5');
  wtW3 = path.join(tmp, 'wt-w3');
  g(repo, 'worktree', 'add', '-q', '-b', 'old-w3', wtW3, 'master');
  g(repo, 'push', '-q', 'origin', 'master', 'old-w5');
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  writeBanner();
  fs.writeFileSync(storeFile, JSON.stringify({ workspaces: fixtureWorkspaces() }, null, 2));
  fs.writeFileSync(tableFile, JSON.stringify(TABLE, null, 2));
  // The fake app: records "<ORCHESTRA_WS_ID>|<ORCHESTRA_WS_ID_IDENTITY>|<args>" and, like the real one, moves the workspace's branch in the (fixture) store.
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'shim.mjs'),
    `import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const [verb, wsid, name] = process.argv.slice(2);
fs.appendFileSync(process.env.SHIM_LOG, [process.env.ORCHESTRA_WS_ID, process.env.ORCHESTRA_WS_ID_IDENTITY, verb, wsid, name].join('|') + '\\n');
const LATE_FILE = process.env.SHIM_STORE + '.late';
if (process.env.SHIM_LATE_ID && wsid !== process.env.SHIM_LATE_ID && fs.existsSync(LATE_FILE)) {
  const st = JSON.parse(fs.readFileSync(process.env.SHIM_STORE, 'utf8')); const lw = st.workspaces.find((x) => x.id === process.env.SHIM_LATE_ID);
  lw.branch = 'child-won-late'; delete lw.namedByParent; fs.writeFileSync(process.env.SHIM_STORE, JSON.stringify(st)); fs.rmSync(LATE_FILE);
}
if (process.env.SHIM_HANG === wsid) await new Promise((r) => setTimeout(r, 4000));
if ((process.env.SHIM_FAIL_ID || '').split(',').includes(wsid) || process.env.SHIM_FAIL_ALL) { process.stderr.write('refused: named by the human\\n'); process.exit(1); }
const store = JSON.parse(fs.readFileSync(process.env.SHIM_STORE, 'utf8'));
const w = store.workspaces.find((x) => x.id === wsid);
const final = name + (process.env.SHIM_SUFFIX || '');
// SHIM_CHILD_WINS: the app answers "Renamed to <name>" but the child's own rename was written last (no pin). SHIM_LATE_ID: see below.
if (process.env.SHIM_CHILD_WINS === wsid) { if (w.worktreePath) execFileSync('git', ['-C', w.worktreePath, 'branch', '-m', 'child-chose-this'], { stdio: 'ignore' }); w.branch = 'child-chose-this'; fs.writeFileSync(process.env.SHIM_STORE, JSON.stringify(store)); process.stdout.write('Renamed to ' + name + '\\n'); process.exit(0); }
// SHIM_LATE_ID: the child's own rename lands AFTER our read-back of that workspace and before the run ends — deterministically: it is applied at the START of the NEXT rename call
// (the script is sequential: read-back of this one is over by then), no timer involved.
// SHIM_NO_PIN = an app older than #383/#384: it renames, but records neither the namer nor the former name.
// SHIM_NO_NAMER / SHIM_NO_FORMER: an app that records only one of the two.
// decideRename keeps an EXISTING namer (else it pins the caller); SHIM_FORMER_OTHER: the child's own rename landed between the snapshot and ours, so the app saw ANOTHER name.
if (!process.env.SHIM_NO_PIN) { if (w.branch !== final && !process.env.SHIM_NO_FORMER) w.formerBranch = process.env.SHIM_FORMER_OTHER ? 'child-name-seen' : w.branch; if (!process.env.SHIM_NO_NAMER) w.namedByParent = w.namedByParent || process.env.ORCHESTRA_WS_ID; }
// a real worktree gets its branch really renamed (SHIM_GIT_LAGS: the record moved, git did not)
if (w.worktreePath && w.branch !== final && !process.env.SHIM_GIT_LAGS) execFileSync('git', ['-C', w.worktreePath, 'branch', '-m', final], { stdio: 'ignore' });
w.branch = final;
fs.writeFileSync(process.env.SHIM_STORE, JSON.stringify(store));
if (process.env.SHIM_LATE_ID === wsid) fs.writeFileSync(LATE_FILE, '1');
process.stdout.write('Renamed to ' + final + '\\n');
`,
  );
  fs.writeFileSync(path.join(bin, 'orchestra'), '#!/bin/sh\nexec "$SHIM_NODE" "$(dirname "$0")/shim.mjs" "$@"\n', { mode: 0o755 });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function realignGit(): void {
  const cur = spawnSync('git', ['-C', wtW3, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8', env: { PATH: gitDir, HOME: tmp } }).stdout.trim();
  if (cur && cur !== 'old-w3') execFileSync('git', ['-C', wtW3, 'branch', '-m', 'old-w3'], { env: { PATH: gitDir, HOME: tmp }, stdio: 'pipe' });
}
function resetStore(): void {
  realignGit();
  fs.writeFileSync(storeFile, JSON.stringify({ workspaces: fixtureWorkspaces() }, null, 2));
  fs.writeFileSync(tableFile, JSON.stringify(TABLE, null, 2));
  fs.rmSync(callsLog, { force: true });
  fs.rmSync(`${storeFile}.late`, { force: true });
}
/** Run the script with a scrubbed environment (allowlist) — never the caller's ORCHESTRA_SOCK / HOME. */
function run(args: string[], env: Record<string, string> = {}): { rc: number; out: string; err: string } {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${gitDir}:/usr/bin:/bin`,
      HOME: tmp,
      TMPDIR: tmp,
      ORCHESTRA_HOME: home,
      SHIM_NODE: process.execPath,
      SHIM_LOG: callsLog,
      SHIM_STORE: storeFile,
      ...env,
    },
    timeout: 60_000,
  });
  return { rc: r.status ?? -1, out: r.stdout, err: r.stderr };
}
const calls = (): string[] => (fs.existsSync(callsLog) ? fs.readFileSync(callsLog, 'utf8').trim().split('\n') : []);
function snapshot(dir: string): Record<string, string> {
  const res: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else res[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return res;
}

test('dry-run is the default: prints the plan, writes NOTHING, never calls the CLI', () => {
  resetStore();
  const before = snapshot(tmp);
  const r = run(['--table', tableFile]);
  assert.equal(r.rc, 0, r.err + r.out);
  assert.match(r.out, /DRY RUN/);
  assert.match(r.out, /PLAN  w3000000  rename\s+old-w3 -> review-fusion-comptes-240/);
  assert.match(r.out, /PLAN  w4000000  rename\s+old-w4 -> explo-timeout-cli/);
  assert.match(r.out, /skip \(branch on origin\)\s+old-w5 -> impl-branche-poussee-5/, 'the REAL ls-remote of the fixture origin');
  assert.match(r.out, /skip \(active vague\)\s+old-w1 -> impl-vague-en-cours-1/);
  assert.match(r.out, /untouched \(no parent to name it\)\s+old-d1/);
  assert.match(r.out, /DRY-RUN  nothing written; 2 rename\(s\) would be applied/);
  assert.deepEqual(snapshot(tmp), before, 'the fixture tree (store, table, repos) is byte-identical after a dry run');
  assert.deepEqual(calls(), []);
  assert.deepEqual(run(['--table', tableFile, '--dry-run']).out, r.out, '--dry-run is the same as the default');
});

test('refusals: --apply without --table, a missing table file, both modes, an unknown flag — rc 2, CLI never called', () => {
  resetStore();
  for (const args of [['--apply'], ['--table', path.join(tmp, 'nope.json'), '--apply'], ['--table', tableFile, '--apply', '--dry-run'], ['--table', tableFile, '--frobnicate'], []]) {
    const r = run(args);
    assert.equal(r.rc, 2, `${args.join(' ')} → ${r.out}${r.err}`);
  }
  assert.deepEqual(calls(), []);
  assert.match(run(['--apply']).err, /--table <file> is required/);
});

test('refusal: ORCHESTRA_SOCK set (an agent PTY) — one home for the store and the app', () => {
  resetStore();
  const r = run(['--table', tableFile], { ORCHESTRA_SOCK: '/run/user/0/some.sock' });
  assert.equal(r.rc, 2);
  assert.match(r.err, /ORCHESTRA_SOCK is set/);
  assert.equal(r.out, '', 'nothing is read or planned');
});

test('refusal: an unreadable store or a malformed table is rc 2, not an empty plan', () => {
  resetStore();
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, '{"id": 1}');
  assert.equal(run(['--table', bad]).rc, 2);
  fs.writeFileSync(bad, JSON.stringify([{ id: id('w3') }]));
  assert.match(run(['--table', bad]).err, /row 1: expected/);
  fs.rmSync(storeFile);
  const r = run(['--table', tableFile]);
  assert.equal(r.rc, 2);
  assert.match(r.err, /cannot read the store/);
  resetStore();
  // a repo whose origin cannot be read is a refusal, never "nothing on origin"
  const store = fixtureWorkspaces().map((w) => (w.id === id('w3') ? { ...w, repoPath: path.join(tmp, 'no-such-repo') } : w));
  fs.writeFileSync(storeFile, JSON.stringify({ workspaces: store }));
  const g = run(['--table', tableFile]);
  assert.equal(g.rc, 2);
  assert.match(g.err, /git .* failed/);
  resetStore();
});

test('ANY rejected table row refuses the whole run (dry-run and apply), applying nothing', () => {
  resetStore();
  fs.writeFileSync(tableFile, JSON.stringify([...TABLE, { id: id('ffff'), old: 'old-ffff', new: 'impl-fantome-9' }, { id: id('h1'), old: 'old-h1', new: 'bad name' }]));
  for (const mode of [[], ['--apply']]) {
    const r = run(['--table', tableFile, ...mode]);
    assert.equal(r.rc, 2, r.out + r.err);
    assert.match(r.out, /REJECTED  row 6  ffff0000  unknown-workspace/);
    assert.match(r.out, /REJECTED  row 7  h1000000  invalid-name/);
    assert.match(r.err, /2 rejected table row\(s\)/);
  }
  assert.deepEqual(calls(), [], 'not one rename was attempted');
  resetStore();
});

test('--apply: one `orchestra rename <id> <name>` per rename step, run AS the workspace\'s parent; one result line each', () => {
  resetStore();
  const r = run(['--table', tableFile, '--apply'], { ORCHESTRA_WS_ID: 'caller-ws', ORCHESTRA_WS_ID_IDENTITY: 'caller-identity' });
  assert.equal(r.rc, 0, r.err + r.out);
  assert.deepEqual(calls(), [
    `${OPS_DONE}|${OPS_DONE}|rename|${id('w3')}|review-fusion-comptes-240`,
    `${LEAD}|${LEAD}|rename|${id('w4')}|explo-timeout-cli`,
  ]);
  assert.match(r.out, /APPLIED  w3000000  old-w3 -> review-fusion-comptes-240/);
  assert.match(r.out, /APPLIED  w4000000  old-w4 -> explo-timeout-cli/);
  assert.match(r.out, /DONE  2\/2 renamed/);
  assert.equal((r.out.match(/^APPLIED /gm) ?? []).length, 2);
  resetStore();
});

test('idempotent end to end: the second --apply plans and runs nothing; the skipped ones stay listed', () => {
  resetStore();
  assert.equal(run(['--table', tableFile, '--apply']).rc, 0);
  const afterFirst = fs.readFileSync(storeFile, 'utf8');
  fs.rmSync(callsLog);
  const r = run(['--table', tableFile, '--apply']);
  assert.equal(r.rc, 0, r.err + r.out);
  assert.deepEqual(calls(), []);
  assert.match(r.out, /DONE  0\/0 renamed/);
  assert.match(r.out, /skip \(branch on origin\)/);
  assert.equal(fs.readFileSync(storeFile, 'utf8'), afterFirst);
  // the vague closes (declared, while its member is live — archiving an OPS archives the whole subtree): the re-run plans exactly that vague's member
  const close = run(['--table', tableFile, '--apply', '--closed', OPS_RUN]);
  assert.equal(close.rc, 0, close.err + close.out);
  assert.deepEqual(calls(), [`${OPS_RUN}|${OPS_RUN}|rename|${id('w1')}|impl-vague-en-cours-1`]);
  resetStore();
});

test('a target equal to a LOCAL branch of the repo is rejected (the app would silently suffix it)', () => {
  resetStore();
  fs.writeFileSync(tableFile, JSON.stringify([{ id: id('w3'), old: 'old-w3', new: 'master-ish' }, { id: id('w4'), old: 'old-w4', new: 'impl-old-w5-twin' }]));
  const g = (...a: string[]): void => void execFileSync('git', ['-C', repo, ...a], { env: { PATH: gitDir, HOME: tmp }, stdio: 'pipe' });
  g('branch', 'impl-old-w5-twin'); // local only, not on origin
  try {
    const r = run(['--table', tableFile]);
    assert.equal(r.rc, 2, r.out + r.err);
    assert.match(r.out, /REJECTED  row 2  w4000000  name-taken/);
  } finally {
    g('branch', '-D', 'impl-old-w5-twin');
  }
  resetStore();
});

test('`orchestra` missing from PATH: FAILED + ABORTED, rc 1, not a crash', () => {
  resetStore();
  const r = run(['--table', tableFile, '--apply'], { PATH: gitDir });
  assert.equal(r.rc, 1, r.out + r.err);
  assert.match(r.out, /FAILED   w3000000/);
  assert.match(r.out, /ABORTED  `orchestra` is not on PATH/);
  assert.deepEqual(calls(), []);
  resetStore();
});

test('the app suffixing the validated name is a FAILURE (rc 1): the store must show the TARGET name', () => {
  resetStore();
  const r = run(['--table', tableFile, '--apply'], { SHIM_SUFFIX: '-2' });
  assert.equal(r.rc, 1, r.out + r.err);
  assert.match(r.out, /FAILED   w3000000  old-w3 -> review-fusion-comptes-240  \[renamed \(the CLI said "review-fusion-comptes-240-2"\) but the store does NOT show a parent-named review-fusion-comptes-240: branch=review-fusion-comptes-240-2 /);
  assert.doesNotMatch(r.out, /^APPLIED/m);
  assert.match(r.out, /ABORTED  at w3000000/);
  assert.equal(calls().length, 1, 'the canary row stopped the run: w4 was never sent to the app');
  resetStore();
});

test('an app that does not record the pin ABORTS the run at the first row (canary); the re-run after the app is updated lands the rest and reports FORMER-LOST for the canary (rc 1, never a green heal)', () => {
  resetStore();
  const r = run(['--table', tableFile, '--apply'], { SHIM_NO_PIN: '1' });
  assert.equal(r.rc, 1, r.out + r.err);
  assert.match(r.out, /FAILED   w3000000  old-w3 -> review-fusion-comptes-240  \[renamed \(the CLI said "review-fusion-comptes-240"\) but the store does NOT show a parent-named review-fusion-comptes-240: branch=review-fusion-comptes-240 namedByParent=∅ formerBranch=∅( git HEAD=review-fusion-comptes-240)?; expected branch=review-fusion-comptes-240 namedByParent=/);
  assert.match(r.out, /ABORTED  at w3000000: .* 1 row\(s\) NOT attempted\./);
  assert.doesNotMatch(r.out, /^APPLIED/m);
  assert.match(r.out, /DONE  0\/2 renamed, 1 FAILED, 1 not attempted, 2 skipped \(see PLAN\) — ABORTED/);
  assert.equal(calls().length, 1, 'one workspace sent to the app, not two');
  const stored = (): Record<string, Record<string, unknown>> => Object.fromEntries((JSON.parse(fs.readFileSync(storeFile, 'utf8')) as { workspaces: Array<Record<string, unknown>> }).workspaces.map((w) => [String(w.id), w]));
  assert.equal(stored()[id('w4')].branch, 'old-w4', 'the row after the canary was not touched');
  // the app is updated: w3 already carries the name, so it is a pin-only step — its former name is gone for good; w4 lands normally
  const healed = run(['--table', tableFile, '--apply']);
  assert.equal(healed.rc, 1, 'FORMER-LOST is not green');
  assert.match(healed.out, /FORMER-LOST  w3000000  old-w3 -> review-fusion-comptes-240  \[the pin is recorded, but the former name "old-w3" is not/);
  assert.match(healed.out, /APPLIED  w4000000  old-w4 -> explo-timeout-cli/);
  assert.doesNotMatch(healed.out, /APPLIED  w3000000/);
  assert.match(healed.out, /DONE  1\/2 renamed, 1 FAILED \(1 FORMER-LOST\), 2 skipped \(see PLAN\)/);
  assert.equal(stored()[id('w3')].namedByParent, OPS_DONE);
  assert.equal(stored()[id('w3')].formerBranch, undefined, 'unrecordable');
  assert.equal(run(['--table', tableFile, '--apply']).out.includes('DONE  0/0'), true, 'the pin is there now: the third run plans nothing');
  resetStore();
});

test('the TARGET name is read back on its own, not only through git: a suffixed name on a workspace WITHOUT a worktree is FAILED and stops the run', () => {
  resetStore();
  fs.writeFileSync(tableFile, JSON.stringify([TABLE[2]])); // w4: no worktree, so only the store can tell
  const r = run(['--table', tableFile, '--apply'], { SHIM_SUFFIX: '-2' });
  assert.equal(r.rc, 1, r.out + r.err);
  assert.match(r.out, /FAILED   w4000000  old-w4 -> explo-timeout-cli  \[renamed \(the CLI said "explo-timeout-cli-2"\) but the store does NOT show a parent-named explo-timeout-cli: branch=explo-timeout-cli-2 /);
  assert.match(r.out, /ABORTED  at w4000000/);
  assert.doesNotMatch(r.out, /^APPLIED/m);
  resetStore();
});

test('--apply reads BOTH fields back: a missing namedByParent alone, or a missing formerBranch alone, is FAILED', () => {
  for (const [env, saw] of [[{ SHIM_NO_NAMER: '1' }, /namedByParent=∅ formerBranch=old-w3/], [{ SHIM_NO_FORMER: '1' }, /namedByParent=0b5c0000.* formerBranch=∅/]] as const) {
    resetStore();
    const r = run(['--table', tableFile, '--apply'], env);
    assert.equal(r.rc, 1, r.out + r.err);
    assert.match(r.out, /FAILED   w3000000/);
    assert.match(r.out, saw);
    assert.match(r.out, /ABORTED  at w3000000/);
    assert.equal(calls().length, 1);
  }
  resetStore();
});

test('a LIVE child whose own rename wins the race (our name never lands) is FAILED, and the re-run plans it again and lands it', () => {
  resetStore();
  const r = run(['--table', tableFile, '--apply'], { SHIM_CHILD_WINS: id('w3') });
  assert.equal(r.rc, 1, r.out + r.err);
  assert.match(r.out, /FAILED   w3000000  old-w3 -> review-fusion-comptes-240  \[renamed \(the CLI said "review-fusion-comptes-240"\) but the store does NOT show a parent-named review-fusion-comptes-240: branch=child-chose-this namedByParent=∅/);
  assert.match(r.out, /ABORTED  at w3000000/);
  assert.doesNotMatch(r.out, /APPLIED/, 'the canary row stopped the run before w4');
  assert.match(r.out, /DONE  0\/2 renamed, 1 FAILED, 1 not attempted, 2 skipped \(see PLAN\) — ABORTED/);
  // the store now says "child-chose-this" while the table was validated against "old-w3": the id is the identity, the row is picked up again (with the row the run never reached)
  const again = run(['--table', tableFile, '--apply']);
  assert.equal(again.rc, 0, again.out + again.err);
  assert.match(again.out, /PLAN  w3000000  rename\s+child-chose-this -> review-fusion-comptes-240  \[as 0b5c0000 · it renamed itself since the table \(was "old-w3"\)\]/);
  assert.match(again.out, /APPLIED  w3000000  child-chose-this -> review-fusion-comptes-240/);
  assert.match(again.out, /APPLIED  w4000000  old-w4 -> explo-timeout-cli/);
  assert.match(again.out, /DONE  2\/2 renamed/);
  assert.equal(run(['--table', tableFile, '--apply']).out.includes('DONE  0/0'), true);
  resetStore();
});

test('a child rename that lands AFTER the read-back is caught by the settle pass: LOST after the APPLIED line, rc 1', () => {
  resetStore();
  const r = run(['--table', tableFile, '--apply'], { SHIM_LATE_ID: id('w3') });
  assert.equal(r.rc, 1, r.out + r.err);
  assert.match(r.out, /APPLIED  w3000000  old-w3 -> review-fusion-comptes-240/, 'it looked fine at read-back time');
  assert.match(r.out, /FAILED   w3000000  old-w3 -> review-fusion-comptes-240  \[LOST after the APPLIED line: branch=child-won-late namedByParent=∅/);
  assert.match(r.out, /DONE  1\/2 renamed, 1 FAILED/);
  resetStore();
});

test('--closed <ops-id>: the declared vague\'s members stop being held and are renamed; an unknown id refuses', () => {
  resetStore();
  const held = run(['--table', tableFile]);
  assert.match(held.out, /skip \(active vague\)\s+old-w1/);
  const r = run(['--table', tableFile, '--apply', '--closed', OPS_RUN]);
  assert.equal(r.rc, 0, r.err + r.out);
  assert.match(r.out, /closed vague\(s\) declared: 0b5a0000/);
  assert.deepEqual(calls().map((c) => c.split('|')[3]).sort(), [id('w1'), id('w3'), id('w4')].sort());
  assert.ok(calls().some((c) => c.startsWith(`${OPS_RUN}|${OPS_RUN}|rename|${id('w1')}|impl-vague-en-cours-1`)), 'w1 is renamed AS its OPS');
  resetStore();
  const bad = run(['--table', tableFile, '--apply', '--closed', id('ffff')]);
  assert.equal(bad.rc, 2);
  assert.match(bad.err, /--closed .*no workspace with this id/);
  assert.deepEqual(calls(), []);
  resetStore();
});

test('--allow-gone: the row of a workspace that no longer exists is GONE, not a refusal (re-run after a merged agent was pruned)', () => {
  resetStore();
  fs.writeFileSync(tableFile, JSON.stringify([...TABLE, { id: id('ffff'), old: 'old-ffff', new: 'impl-fantome-9' }]));
  const strict = run(['--table', tableFile, '--apply']);
  assert.equal(strict.rc, 2);
  assert.deepEqual(calls(), []);
  const lax = run(['--table', tableFile, '--apply', '--allow-gone']);
  assert.equal(lax.rc, 0, lax.out + lax.err);
  assert.match(lax.out, /GONE  row 6  ffff0000/);
  assert.equal(calls().length, 2);
  // allow-gone excuses ONLY vanished workspaces: any other rejected row still refuses
  fs.writeFileSync(tableFile, JSON.stringify([...TABLE, { id: id('h1'), old: 'old-h1', new: 'bad name' }]));
  assert.equal(run(['--table', tableFile, '--apply', '--allow-gone']).rc, 2);
  resetStore();
});

test('--verbose lists the human-created and not-in-table workspaces the default output only counts', () => {
  resetStore();
  const quiet = run(['--table', tableFile]).out;
  const loud = run(['--table', tableFile, '--verbose']).out;
  assert.doesNotMatch(quiet, /untouched \(human-created\)/);
  assert.match(loud, /untouched \(human-created\)\s+old-h1/);
  assert.match(loud, /untouched \(human-created\)\s+lead-main/);
});

test('a repo whose remote is not called origin still protects its pushed branches', () => {
  resetStore();
  const g = (...a: string[]): void => void execFileSync('git', ['-C', repo, ...a], { env: { PATH: gitDir, HOME: tmp }, stdio: 'pipe' });
  g('remote', 'rename', 'origin', 'upstream');
  try {
    const r = run(['--table', tableFile]);
    assert.equal(r.rc, 0, r.out + r.err);
    assert.match(r.out, /skip \(branch on origin\)\s+old-w5/);
  } finally {
    g('remote', 'rename', 'upstream', 'origin');
  }
  resetStore();
});

test('a name git refuses (impl-x..y) is rejected at plan time (by the naming policy), before any rename', () => {
  resetStore();
  fs.writeFileSync(tableFile, JSON.stringify([{ id: id('w3'), old: 'old-w3', new: 'impl-x..y' }, { id: id('w4'), old: 'old-w4', new: 'explo-timeout-cli' }]));
  const r = run(['--table', tableFile, '--apply']);
  assert.equal(r.rc, 2, r.out + r.err);
  assert.match(r.out, /REJECTED  row 1  w3000000  invalid-name/);
  assert.deepEqual(calls(), []);
  resetStore();
});

test('the namer the app keeps is the one expected: parentId P + an existing namer N -> the rename is acted as P, the store ends with N, APPLIED (not a false FAILED)', () => {
  resetStore();
  fs.writeFileSync(tableFile, JSON.stringify(TABLE_W6));
  const r = run(['--table', tableFile, '--apply']);
  assert.equal(r.rc, 0, r.out + r.err);
  assert.match(r.out, /APPLIED  w6000000  old-w6 -> impl-reparente-6/);
  assert.deepEqual(calls(), [`${LEAD}|${LEAD}|rename|${id('w6')}|impl-reparente-6`]);
  const w6 = (JSON.parse(fs.readFileSync(storeFile, 'utf8')) as { workspaces: Array<Record<string, unknown>> }).workspaces.find((w) => w.id === id('w6'))!;
  assert.equal(w6.namedByParent, OPS_DONE);
  resetStore();
});

test('a former name the app saw (the child renamed itself between the snapshot and ours) is accepted; a missing one is not', () => {
  resetStore();
  const ok = run(['--table', tableFile, '--apply'], { SHIM_FORMER_OTHER: '1' });
  assert.equal(ok.rc, 0, ok.out + ok.err);
  assert.match(ok.out, /DONE  2\/2 renamed/);
  resetStore();
});

test('the worktree\'s git HEAD is read back too: a record that moved while git did not is FAILED', () => {
  resetStore();
  const r = run(['--table', tableFile, '--apply'], { SHIM_GIT_LAGS: '1' });
  assert.equal(r.rc, 1, r.out + r.err);
  assert.match(r.out, /FAILED   w3000000  old-w3 -> review-fusion-comptes-240  \[renamed .*branch=review-fusion-comptes-240 namedByParent=0b5c0000.* git HEAD=old-w3;/);
  resetStore(); // (detect-only: a record that moved while git did not is for the operator — the app's reconciler would adopt git's name)
  const ok = run(['--table', tableFile, '--apply']);
  assert.equal(ok.rc, 0, ok.out + ok.err);
  assert.equal(spawnSync('git', ['-C', wtW3, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8', env: { PATH: gitDir, HOME: tmp } }).stdout.trim(), 'review-fusion-comptes-240', 'the real worktree branch was renamed by the (fake) app');
  resetStore();
});

test('PREFLIGHT: the running app must be at least as new as this checkout — older, unknown (no banner) or a dead process refuses (rc 2, nothing sent); --assume-app-current attests; newer is fine', () => {
  const older = PKG_VERSION.replace(/(\d+)$/, (n) => String(Math.max(0, Number(n) - 1)));
  const newer = PKG_VERSION.replace(/(\d+)$/, (n) => String(Number(n) + 1));
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout.trim(); // a pid that existed and is gone
  try {
    resetStore();
    writeBanner(older);
    const dry = run(['--table', tableFile]);
    assert.equal(dry.rc, 0, 'a dry run only PREVIEWS: it says the apply would be refused, it does not refuse');
    assert.match(dry.out, /# app: the running app is v.*DRY-RUN .*the app preflight above would REFUSE --apply/s);
    const r = run(['--table', tableFile, '--apply']);
    assert.equal(r.rc, 2, `${r.out}${r.err}`);
    assert.match(r.err, new RegExp(`the running app is v${older.replace(/\./g, '\\.')} .* this checkout is v${PKG_VERSION.replace(/\./g, '\\.')}`));
    assert.match(r.out, /# app: the running app is v/);
    assert.deepEqual(calls(), [], 'nothing was sent to an app that predates the pin');
    // a suffixed build of the SAME number is older than the plain one; another home's instance is not the app we talk to; a banner of a huge log is still found
    writeBanner(`${PKG_VERSION}-rc.1`);
    assert.equal(run(['--table', tableFile, '--apply']).rc, 2, 'an rc build is not "at least as new"');
    writeBanner(PKG_VERSION, process.pid, '/some/other/home');
    assert.match(run(['--table', tableFile, '--apply']).err, /version is UNKNOWN \(no startup banner/);
    writeBanner();
    fs.appendFileSync(path.join(home, 'logs', 'orchestra.log'), `${'x'.repeat(99)}\n`.repeat(50_000)); // ~5 MB after the banner: the whole file is read
    const big = run(['--table', tableFile, '--apply']);
    assert.equal(big.rc, 0, big.out + big.err);
    resetStore();
    writeBanner();
    fs.rmSync(path.join(home, 'logs'), { recursive: true, force: true });
    assert.match(run(['--table', tableFile, '--apply']).err, /version is UNKNOWN \(no startup banner/);
    writeBanner(PKG_VERSION, Number(dead));
    assert.match(run(['--table', tableFile, '--apply']).err, /no longer running — the version of the app that answers is UNKNOWN/);
    assert.deepEqual(calls(), []);
    writeBanner(older);
    const attested = run(['--table', tableFile, '--apply', '--assume-app-current']);
    assert.equal(attested.rc, 0, attested.out + attested.err);
    assert.match(attested.out, /OVERRIDDEN by --assume-app-current/);
    assert.equal(calls().length, 2);
    resetStore();
    writeBanner(newer);
    assert.match(run(['--table', tableFile]).out, new RegExp(`# app: running app v${newer.replace(/\./g, '\\.')} \\(pid \\d+\\) >= checkout`));
  } finally {
    writeBanner();
    resetStore();
  }
});

test('a table row of an ARCHIVED workspace can never apply: WARN, and an apply is not green (rc 1) unless --allow-gone says the rows are history', () => {
  resetStore();
  fs.writeFileSync(tableFile, JSON.stringify([...TABLE, { id: OPS_DONE, old: 'wave-c-ops', new: 'ops-vague-ancienne-1' }]));
  const dry = run(['--table', tableFile]);
  assert.equal(dry.rc, 0, dry.out + dry.err);
  assert.match(dry.out, /WARN  0b5c0000  wave-c-ops  \[its table row can never apply/);
  assert.match(dry.out, /DRY-RUN .*; 1 WARN/);
  const ap = run(['--table', tableFile, '--apply']);
  assert.equal(ap.rc, 1, ap.out + ap.err);
  assert.match(ap.out, /DONE  2\/2 renamed, 2 skipped \(see PLAN\), 1 WARN/);
  assert.equal(calls().length, 2, 'the live rows were still applied');
  resetStore();
  fs.writeFileSync(tableFile, JSON.stringify([...TABLE, { id: OPS_DONE, old: 'wave-c-ops', new: 'ops-vague-ancienne-1' }]));
  const lax = run(['--table', tableFile, '--apply', '--allow-gone']);
  assert.equal(lax.rc, 0, lax.out + lax.err);
  assert.match(lax.out, /ARCHIVED  0b5c0000  wave-c-ops/);
  assert.doesNotMatch(lax.out, /WARN/);
  resetStore();
});

test('the worktree\'s LIVE branch is read BEFORE planning: a store that disagrees with HEAD is UNKNOWN and that row is skipped, with its reason', () => {
  resetStore();
  execFileSync('git', ['-C', wtW3, 'branch', '-m', 'live-w3'], { env: { PATH: gitDir, HOME: tmp }, stdio: 'pipe' });
  try {
    const r = run(['--table', tableFile, '--apply']);
    assert.equal(r.rc, 0, r.out + r.err);
    assert.match(r.out, /skip \(live branch differs\)\s+old-w3 -> review-fusion-comptes-240\s+\[the store says "old-w3" but the worktree is on "live-w3"/);
    assert.deepEqual(calls().map((c) => c.split('|')[3]), [id('w4')], 'only w4 was sent to the app');
  } finally {
    resetStore();
  }
});

test('an UNREADABLE worktree HEAD is UNKNOWN too: that row is skipped with the reason, nothing is sent for it', () => {
  resetStore();
  const dotGit = path.join(wtW3, '.git');
  const original = fs.readFileSync(dotGit, 'utf8');
  fs.writeFileSync(dotGit, 'gitdir: /nonexistent/nowhere\n');
  try {
    const r = run(['--table', tableFile, '--apply']);
    assert.equal(r.rc, 0, r.out + r.err);
    assert.match(r.out, /skip \(live branch differs\)\s+old-w3 -> review-fusion-comptes-240\s+\[its HEAD could not be read/);
    assert.deepEqual(calls().map((c) => c.split('|')[3]), [id('w4')]);
  } finally {
    fs.writeFileSync(dotGit, original);
    resetStore();
  }
});

test('a rename whose old name is another LIVE workspace\'s baseBranch is skipped (its Diff/stats would dangle)', () => {
  resetStore();
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8')) as { workspaces: Array<Record<string, unknown>> };
  fs.writeFileSync(storeFile, JSON.stringify({ workspaces: store.workspaces.map((w) => (w.id === id('h1') ? { ...w, baseBranch: 'old-w4' } : w)) }));
  const r = run(['--table', tableFile, '--apply']);
  assert.equal(r.rc, 0, r.out + r.err);
  assert.match(r.out, /skip \(a baseBranch\)\s+old-w4 -> explo-timeout-cli\s+\["old-h1" \(h1000000\) has this branch as its baseBranch/);
  assert.deepEqual(calls().map((c) => c.split('|')[3]), [id('w3')]);
  resetStore();
});

test('old is REQUIRED on every row (it is what tells a lost former name from a never-renamed workspace on a repeated run): rc 2, nothing sent', () => {
  resetStore();
  fs.writeFileSync(tableFile, JSON.stringify([{ id: id('w3'), new: 'review-fusion-comptes-240' }]));
  for (const args of [['--table', tableFile], ['--table', tableFile, '--apply']]) {
    const r = run(args);
    assert.equal(r.rc, 2);
    assert.match(r.err, /row 1: expected .*"old" is REQUIRED/);
  }
  assert.deepEqual(calls(), []);
  resetStore();
});

test('ORCHESTRA_HOME unset = the LIVE default: --apply refuses (before the store is even read) unless --live; the header says which store and socket pointer it acts on', () => {
  resetStore();
  const refused = run(['--table', tableFile, '--apply'], { ORCHESTRA_HOME: '' });
  assert.equal(refused.rc, 2, refused.out + refused.err);
  assert.match(refused.err, /ORCHESTRA_HOME is unset: --apply would act on the LIVE default app and store .*\.orchestra, socket pointer .*\.orchestra\/sock\). .*--live/);
  assert.equal(refused.out, '', 'nothing was read or planned');
  assert.deepEqual(calls(), []);
  const confirmed = run(['--table', tableFile, '--apply', '--live'], { ORCHESTRA_HOME: '' });
  assert.equal(confirmed.rc, 2);
  assert.doesNotMatch(confirmed.err, /would act on the LIVE/, '--live passes the guard (the fixture has no store under the fake HOME, so it stops there)');
  assert.match(confirmed.err, /cannot read the store/);
  // a DRY RUN on the default home is allowed and says so: copy the fixture to where the default home's store would be
  const xdgStore = path.join(tmp, '.config', 'orchestra', 'orchestra', 'store.json');
  fs.mkdirSync(path.dirname(xdgStore), { recursive: true });
  fs.copyFileSync(storeFile, xdgStore);
  try {
    const dry = run(['--table', tableFile], { ORCHESTRA_HOME: '' });
    assert.equal(dry.rc, 0, dry.out + dry.err);
    assert.match(dry.out, /# acting on: the LIVE default home .*\.orchestra \(ORCHESTRA_HOME unset\) · store=.*\.config\/orchestra\/orchestra\/store\.json · socket pointer .*\.orchestra\/sock -> \(missing\)/);
  } finally {
    fs.rmSync(path.join(tmp, '.config'), { recursive: true, force: true });
  }
  // and with a scratch home the header names THAT home, its store and its pointer
  const scratch = run(['--table', tableFile]);
  assert.match(scratch.out, /# acting on: ORCHESTRA_HOME=\S+ · store=\S+store\.json · socket pointer \S+\/sock -> \(missing\)/);
  resetStore();
});

test('a non-scratch workspace whose worktree cannot be SEEN (a plain directory without its own .git, or a sandbox host) is UNKNOWN: skipped, never sent', () => {
  resetStore();
  const plain = path.join(tmp, 'plain-dir');
  fs.mkdirSync(plain, { recursive: true });
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8')) as { workspaces: Array<Record<string, unknown>> };
  fs.writeFileSync(storeFile, JSON.stringify({ workspaces: store.workspaces.map((w) => (w.id === id('w4') ? { ...w, worktreePath: plain } : w.id === id('w3') ? { ...w, host: { kind: 'sandbox', endpoint: 'x' } } : w)) }));
  const r = run(['--table', tableFile, '--apply']);
  assert.equal(r.rc, 0, r.out + r.err);
  assert.match(r.out, /skip \(live branch differs\)\s+old-w4 -> explo-timeout-cli\s+\[its HEAD could not be read \(no readable local worktree\)/);
  assert.match(r.out, /skip \(live branch differs\)\s+old-w3 -> review-fusion-comptes-240/);
  assert.deepEqual(calls(), []);
  resetStore();
});

test('the same repo under two spellings is ONE repo: a baseBranch dependent recorded with a trailing slash still holds the rename', () => {
  resetStore();
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8')) as { workspaces: Array<Record<string, unknown>> };
  fs.writeFileSync(storeFile, JSON.stringify({ workspaces: store.workspaces.map((w) => (w.id === id('h1') ? { ...w, baseBranch: 'old-w4', repoPath: `${repo}/` } : w)) }));
  const r = run(['--table', tableFile]);
  assert.match(r.out, /skip \(a baseBranch\)\s+old-w4 -> explo-timeout-cli/);
  resetStore();
});

test('a timeout leaves the row UNKNOWN and stops the run; two CLI errors in a row stop it; two NON-consecutive errors do not', () => {
  resetStore();
  const hang = run(['--table', tableFile, '--apply'], { SHIM_HANG: id('w3'), MIGRATE_RENAME_TIMEOUT_MS: '700' });
  assert.equal(hang.rc, 1, hang.out + hang.err);
  assert.match(hang.out, /ABORTED  at w3000000: the app did not answer within 700 ms — the row's state is UNKNOWN; 1 row\(s\) NOT attempted/);
  assert.equal(calls().length, 1, 'w4 was not sent');
  resetStore();
  fs.writeFileSync(tableFile, JSON.stringify(TABLE));
  const all = run(['--table', tableFile, '--apply', '--closed', OPS_RUN], { SHIM_FAIL_ALL: '1' });
  assert.equal(all.rc, 1);
  assert.match(all.out, /ABORTED  at w3000000: two rename errors in a row — the app keeps failing; 1 row\(s\) NOT attempted/);
  assert.match(all.out, /DONE  0\/3 renamed, 2 FAILED, 1 not attempted/);
  resetStore();
  const apart = run(['--table', tableFile, '--apply', '--closed', OPS_RUN], { SHIM_FAIL_ID: `${id('w1')},${id('w4')}` });
  assert.equal(apart.rc, 1);
  assert.doesNotMatch(apart.out, /ABORTED/, 'a success between two errors resets the count');
  assert.match(apart.out, /APPLIED  w3000000/);
  assert.match(apart.out, /DONE  1\/3 renamed, 2 FAILED/);
  resetStore();
});

test('the DONE line counts what was skipped (a run of only skipped rows must not read as "nothing to do")', () => {
  resetStore();
  fs.writeFileSync(tableFile, JSON.stringify([TABLE[3]])); // w5: on origin
  const r = run(['--table', tableFile, '--apply']);
  assert.equal(r.rc, 0, r.out + r.err);
  assert.match(r.out, /DONE  0\/0 renamed, 1 skipped \(see PLAN\)/);
  resetStore();
});

test('a happy-path apply is asserted on the STORE too: the namer AND the former name of every renamed workspace', () => {
  resetStore();
  assert.equal(run(['--table', tableFile, '--apply']).rc, 0);
  const by = Object.fromEntries((JSON.parse(fs.readFileSync(storeFile, 'utf8')) as { workspaces: Array<Record<string, unknown>> }).workspaces.map((w) => [String(w.id), w]));
  assert.deepEqual([by[id('w3')].branch, by[id('w3')].namedByParent, by[id('w3')].formerBranch], ['review-fusion-comptes-240', OPS_DONE, 'old-w3']);
  assert.deepEqual([by[id('w4')].branch, by[id('w4')].namedByParent, by[id('w4')].formerBranch], ['explo-timeout-cli', LEAD, 'old-w4']);
  resetStore();
});

test('a refused rename is reported and does not stop the others; rc 1', () => {
  resetStore();
  const r = run(['--table', tableFile, '--apply'], { SHIM_FAIL_ID: id('w3') });
  assert.equal(r.rc, 1);
  assert.match(r.out, /FAILED   w3000000  old-w3 -> review-fusion-comptes-240  \[refused: named by the human\]/);
  assert.match(r.out, /APPLIED  w4000000/);
  assert.match(r.out, /DONE  1\/2 renamed, 1 FAILED/);
  resetStore();
});

test('the script has no filesystem write of its own: it applies through the CLI only', () => {
  resetStore();
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /writeFile|appendFile|renameSync|copyFile|unlink|rmSync|mkdirSync/, 'no filesystem write in the script');
  assert.match(src, /spawnSync\('orchestra', \['rename', step\.id, step\.to\]/);
  assert.match(src, /ORCHESTRA_WS_ID: step\.asParent/);
});
