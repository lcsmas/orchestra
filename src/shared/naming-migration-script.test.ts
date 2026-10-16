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
const gitDir = path.dirname(execFileSync('which', ['git'], { encoding: 'utf8' }).trim());

function fixtureWorkspaces(): Array<Record<string, unknown>> {
  const w = (n: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: id(n), branch: `old-${n}`, repoPath: repo, name: `repo · old-${n}`, ...extra });
  return [
    w('1ead', { branch: 'lead-main', kind: 'orchestrator', repoPath: '' }),
    w('0b5a', { branch: 'wave-g-ops', parentId: LEAD, canOrchestrate: true }),
    w('w1', { parentId: OPS_RUN }), // running vague
    w('0b5c', { branch: 'wave-c-ops', parentId: LEAD, canOrchestrate: true, archived: true }),
    w('w3', { parentId: OPS_DONE }),
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
  g(repo, 'push', '-q', 'origin', 'master', 'old-w5');
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.writeFileSync(storeFile, JSON.stringify({ workspaces: fixtureWorkspaces() }, null, 2));
  fs.writeFileSync(tableFile, JSON.stringify(TABLE, null, 2));
  // The fake app: records "<ORCHESTRA_WS_ID>|<ORCHESTRA_WS_ID_IDENTITY>|<args>" and, like the real one, moves the workspace's branch in the (fixture) store.
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'shim.mjs'),
    `import fs from 'node:fs';
const [verb, wsid, name] = process.argv.slice(2);
fs.appendFileSync(process.env.SHIM_LOG, [process.env.ORCHESTRA_WS_ID, process.env.ORCHESTRA_WS_ID_IDENTITY, verb, wsid, name].join('|') + '\\n');
const LATE_FILE = process.env.SHIM_STORE + '.late';
if (process.env.SHIM_LATE_ID && wsid !== process.env.SHIM_LATE_ID && fs.existsSync(LATE_FILE)) {
  const st = JSON.parse(fs.readFileSync(process.env.SHIM_STORE, 'utf8')); const lw = st.workspaces.find((x) => x.id === process.env.SHIM_LATE_ID);
  lw.branch = 'child-won-late'; delete lw.namedByParent; fs.writeFileSync(process.env.SHIM_STORE, JSON.stringify(st)); fs.rmSync(LATE_FILE);
}
if (process.env.SHIM_FAIL_ID === wsid) { process.stderr.write('refused: named by the human\\n'); process.exit(1); }
const store = JSON.parse(fs.readFileSync(process.env.SHIM_STORE, 'utf8'));
const w = store.workspaces.find((x) => x.id === wsid);
const final = name + (process.env.SHIM_SUFFIX || '');
// SHIM_CHILD_WINS: the app answers "Renamed to <name>" but the child's own rename was written last (no pin). SHIM_LATE_ID: see below.
if (process.env.SHIM_CHILD_WINS === wsid) { w.branch = 'child-chose-this'; fs.writeFileSync(process.env.SHIM_STORE, JSON.stringify(store)); process.stdout.write('Renamed to ' + name + '\\n'); process.exit(0); }
// SHIM_LATE_ID: the child's own rename lands AFTER our read-back of that workspace and before the run ends — deterministically: it is applied at the START of the NEXT rename call
// (the script is sequential: read-back of this one is over by then), no timer involved.
// SHIM_NO_PIN = an app older than #383/#384: it renames, but records neither the namer nor the former name.
// SHIM_NO_NAMER / SHIM_NO_FORMER: an app that records only one of the two.
if (!process.env.SHIM_NO_PIN) { if (w.branch !== final && !process.env.SHIM_NO_FORMER) w.formerBranch = w.branch; if (!process.env.SHIM_NO_NAMER) w.namedByParent = process.env.ORCHESTRA_WS_ID; }
w.branch = final;
fs.writeFileSync(process.env.SHIM_STORE, JSON.stringify(store));
if (process.env.SHIM_LATE_ID === wsid) fs.writeFileSync(LATE_FILE, '1');
process.stdout.write('Renamed to ' + final + '\\n');
`,
  );
  fs.writeFileSync(path.join(bin, 'orchestra'), '#!/bin/sh\nexec "$SHIM_NODE" "$(dirname "$0")/shim.mjs" "$@"\n', { mode: 0o755 });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function resetStore(): void {
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
  fs.writeFileSync(tableFile, JSON.stringify([...TABLE, { id: id('ffff'), new: 'impl-fantome-9' }, { id: id('h1'), new: 'bad name' }]));
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
  // the vague closes (its OPS is archived): the re-run plans exactly that vague's member
  const store = JSON.parse(afterFirst) as { workspaces: Array<Record<string, unknown>> };
  fs.writeFileSync(storeFile, JSON.stringify({ workspaces: store.workspaces.map((w) => (w.id === OPS_RUN ? { ...w, archived: true } : w)) }));
  const close = run(['--table', tableFile, '--apply']);
  assert.equal(close.rc, 0, close.err + close.out);
  assert.deepEqual(calls(), [`${OPS_RUN}|${OPS_RUN}|rename|${id('w1')}|impl-vague-en-cours-1`]);
  resetStore();
});

test('a target equal to a LOCAL branch of the repo is rejected (the app would silently suffix it)', () => {
  resetStore();
  fs.writeFileSync(tableFile, JSON.stringify([{ id: id('w3'), new: 'master-ish' }, { id: id('w4'), new: 'impl-old-w5-twin' }]));
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
  resetStore();
});

test('--apply reads the store back: a rename the app did NOT record as parent-named is FAILED (rc 1), and a re-run after the app is updated heals it', () => {
  resetStore();
  const r = run(['--table', tableFile, '--apply'], { SHIM_NO_PIN: '1' });
  assert.equal(r.rc, 1, r.out + r.err);
  assert.match(r.out, /FAILED   w3000000  old-w3 -> review-fusion-comptes-240  \[renamed \(the CLI said "review-fusion-comptes-240"\) but the store does NOT show a parent-named review-fusion-comptes-240: branch=review-fusion-comptes-240 namedByParent=∅ formerBranch=∅; expected branch=review-fusion-comptes-240 namedByParent=/);
  assert.doesNotMatch(r.out, /^APPLIED/m);
  assert.match(r.out, /DONE  0\/2 renamed, 2 FAILED/);
  // the app is updated: the same table now plans a pin-only rename (same name, not yet parent-named) and the store ends up recorded
  const healed = run(['--table', tableFile, '--apply']);
  assert.equal(healed.rc, 0, healed.out + healed.err);
  assert.match(healed.out, /APPLIED  w3000000  review-fusion-comptes-240 -> review-fusion-comptes-240/);
  assert.match(healed.out, /DONE  2\/2 renamed/);
  const w3 = (JSON.parse(fs.readFileSync(storeFile, 'utf8')) as { workspaces: Array<Record<string, unknown>> }).workspaces.find((w) => w.id === id('w3'))!;
  assert.equal(w3.namedByParent, OPS_DONE);
  assert.equal(run(['--table', tableFile, '--apply']).out.includes('DONE  0/0'), true, 'and now it is idempotent');
  resetStore();
});

test('--apply reads BOTH fields back: a missing namedByParent alone, or a missing formerBranch alone, is FAILED', () => {
  for (const [env, saw] of [[{ SHIM_NO_NAMER: '1' }, /namedByParent=∅ formerBranch=old-w3/], [{ SHIM_NO_FORMER: '1' }, /namedByParent=0b5c0000.* formerBranch=∅/]] as const) {
    resetStore();
    const r = run(['--table', tableFile, '--apply'], env);
    assert.equal(r.rc, 1, r.out + r.err);
    assert.match(r.out, /FAILED   w3000000/);
    assert.match(r.out, saw);
  }
  resetStore();
});

test('a LIVE child whose own rename wins the race (our name never lands) is FAILED, and the re-run plans it again and lands it', () => {
  resetStore();
  const r = run(['--table', tableFile, '--apply'], { SHIM_CHILD_WINS: id('w3') });
  assert.equal(r.rc, 1, r.out + r.err);
  assert.match(r.out, /FAILED   w3000000  old-w3 -> review-fusion-comptes-240  \[renamed \(the CLI said "review-fusion-comptes-240"\) but the store does NOT show a parent-named review-fusion-comptes-240: branch=child-chose-this namedByParent=∅/);
  assert.match(r.out, /APPLIED  w4000000/);
  assert.match(r.out, /DONE  1\/2 renamed, 1 FAILED/);
  // the store now says "child-chose-this" while the table was validated against "old-w3": the id is the identity, the row is picked up again
  const again = run(['--table', tableFile, '--apply']);
  assert.equal(again.rc, 0, again.out + again.err);
  assert.match(again.out, /PLAN  w3000000  rename\s+child-chose-this -> review-fusion-comptes-240  \[as 0b5c0000 · it renamed itself since the table \(was "old-w3"\)\]/);
  assert.match(again.out, /APPLIED  w3000000  child-chose-this -> review-fusion-comptes-240/);
  assert.match(again.out, /DONE  1\/1 renamed/);
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
  fs.writeFileSync(tableFile, JSON.stringify([...TABLE, { id: id('h1'), new: 'bad name' }]));
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
