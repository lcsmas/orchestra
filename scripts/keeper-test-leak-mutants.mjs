// In-place mutants for the keeper test leak fix (D2): one per changed clause of src/keeper/test-teardown.ts, keeper.test.ts and keeper-memory-cap.test.ts. Each edits ONE anchor (byte-exact backup, restored in
// `finally` and compared with Buffer.compare, plus `git diff --quiet` when the file was clean), runs the arm under a private TMPDIR/HOME, and counts a KILL only on an ASSERTION: a `not ok` line naming the
// expected test, or (after-hook arms) leftover processes in the post-run census — a syntax error / crash is "BROKEN", never a kill. Every leftover is reaped by identity; SURVIVORS is printed after each arm.
//
//   node scripts/keeper-test-leak-mutants.mjs --check               every anchor matches exactly once; nothing is run
//   node scripts/keeper-test-leak-mutants.mjs --selftest            controls: unmutated tree GREEN with census 0, a no-op mutant SURVIVES (starts real keepers)
//   node scripts/keeper-test-leak-mutants.mjs [--only id,id]        the sweep (REAL KEEPERS in every arm — heavy-rig token, ledger §Roster). Exact ids; 0 matches = exit 2.
//
// Exit 0 iff every mutant is KILLED, the controls hold and the tree is restored byte-for-byte.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TD = 'src/keeper/test-teardown.ts';
const KT = 'src/keeper/keeper.test.ts';
const KC = 'src/keeper/keeper-memory-cap.test.ts';
const RIG = 'scripts/keeper-test-leak-rig.mjs';

/** arm: { test: file, pattern?: name-pattern, expect: title substring of the test that must go `not ok` } | { census: file, pattern } (killed by leftovers) | { rig: true } */
const MUTANTS = [
  { id: 'fixture-no-parent-watch', clause: 'the SIGTERM-ignoring fixture exits when its keeper is gone', file: KT, find: 'if (process.ppid !== KEEPER) process.exit(0);', replace: '', arm: { test: KT, pattern: 'dies WITH its keeper', expect: 'dies WITH its keeper' } },
  { id: 'killident-no-identity', clause: 'a signal is sent only if the start time still matches', file: TD, find: '  if (statOf(id.pid)?.ticks !== id.ticks) return false;\n', replace: '', arm: { test: KT, pattern: 'identity guard', expect: 'identity guard' } },
  { id: 'groupof-no-leader-check', clause: 'a group is enumerated only while its leader is the recorded process', file: TD, find: '  if (statOf(leader.pid)?.ticks !== leader.ticks) return [];\n', replace: '', arm: { test: KT, pattern: 'identity guard', expect: 'identity guard' } },
  { id: 'reap-no-group-step', clause: 'the keeper\'s process group is killed first', file: TD, find: '  for (const l of leaders) for (const m of groupOf(l)) killIdent(m);\n', replace: '', arm: { test: KT, pattern: 'identity guard', expect: 'identity guard' } },
  { id: 'reap-no-carrier-sweep', clause: 'then anything still carrying a scratch dir', file: TD, find: '    for (const s of left) killIdent(s);\n', replace: '', arm: { test: KT, pattern: 'teardown witness', expect: 'teardown witness' } },
  { id: 'carrying-ignores-dir', clause: 'carriers are selected by the scratch dir in argv', file: TD, find: 'const hit = cmd?.includes(dir) ||', replace: 'const hit = false ||', arm: { test: KT, pattern: 'teardown witness', expect: 'teardown witness' } },
  { id: 'reap-returns-empty', clause: 'reap returns the MEASURED survivors (a respawner can defeat the sweep and reap must say so)', file: TD, find: '  return dirs.flatMap((d) => carrying(d, orEnv));\n}', replace: '  return [];\n}', arm: { test: KT, pattern: 'could NOT kill', expect: 'could NOT kill' } },
  { id: 'after-no-reap', clause: 'the after hook reaps (the net for a test that fails mid-way)', file: KT, find: '  const left = await reap(keepers, ctxs.map((c) => c.dir));\n', replace: '  const left: Awaited<ReturnType<typeof reap>> = [];\n', arm: { census: KT, pattern: 'after-hook canary' } },
  { id: 'keeper-not-recorded', clause: 'every keeper launched is recorded with its identity', file: KT, find: '  if (id) keepers.push(id);', replace: '', arm: { test: KT, expect: 'suite leaves 0 survivors' } },
  { id: 'bounded-env-dropped', clause: 'a keeper whose runner died ends itself within ~1 min', file: KT, find: "const BOUNDED_KEEPER_ENV = { ORCHESTRA_KEEPER_LINGER_MS: '60000', ORCHESTRA_KEEPER_WEDGE_MS: '60000', ORCHESTRA_KEEPER_TICK_MS: '2000' };", replace: 'const BOUNDED_KEEPER_ENV = {};', arm: { rig: true } },
  { id: 'kmc-pid-only-teardown', clause: 'keeper-memory-cap.test.ts reaps by identity through the shared helper (the verifier MINOR)', file: KC, find: 'const teardownAll = () => reap(keepers, dirs, true);', replace: "const teardownAll = async () => { for (const k of keepers) { try { process.kill(k.pid, 'SIGKILL'); } catch { /* gone */ } } return dirs.flatMap((d) => carrying(d, true)); };", arm: { test: KC, expect: 'teardown (D2)', home: true } },
];

const argv = process.argv.slice(2);
let only = null, check = false, selftest = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--check') check = true;
  else if (argv[i] === '--selftest') selftest = true;
  else if (argv[i] === '--only') only = (argv[++i] ?? '').split(',').filter(Boolean);
  else { console.error(`unknown option ${argv[i]} (fail closed)`); process.exit(2); }
}
const todo = only ? MUTANTS.filter((m) => only.includes(m.id)) : MUTANTS;
const unknownIds = only ? only.filter((id) => !MUTANTS.some((m) => m.id === id)) : [];
if (only && (todo.length === 0 || unknownIds.length)) { console.error(`--only names no mutant: ${unknownIds.join(',') || '(empty list)'} — NOTHING was run (exact ids): ${MUTANTS.map((m) => m.id).join(' ')}`); process.exit(2); }

const abs = (f) => path.join(REPO, f);
const count = (hay, needle) => hay.split(needle).length - 1;
function anchorsOk(list) {
  let ok = true;
  for (const m of list) {
    const n = count(fs.readFileSync(abs(m.file), 'utf8'), m.find);
    if (n !== 1) { ok = false; console.log(`ANCHOR ${m.id}: ${n} match(es) in ${m.file} — must be exactly 1`); }
  }
  return ok;
}
if (check) {
  const ok = anchorsOk(todo);
  console.log(`CHECK ${ok ? 'OK' : 'FAILED'}: ${todo.length} anchors (nothing run)`);
  process.exit(ok ? 0 : 1);
}

const rd = (p) => { try { return fs.readFileSync(p, 'latin1'); } catch { return null; } };
function stat(pid) { const t = rd(`/proc/${pid}/stat`); if (!t) return null; const f = t.slice(t.lastIndexOf(')') + 2).split(' '); return f[19] === undefined ? null : { state: f[0], ticks: f[19] }; }
function census(dir) {
  const out = [];
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
    const c = rd(`/proc/${n}/cmdline`);
    const s = c && c.includes(dir) ? stat(n) : null;
    if (s && s.state !== 'Z') out.push({ pid: Number(n), ticks: s.ticks });
  }
  return out;
}
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function reapAll(dir) {
  for (let r = 0; r < 20; r++) {
    const left = census(dir);
    if (!left.length) return 0;
    for (const c of left) if (stat(c.pid)?.ticks === c.ticks) { try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } }
    sleepSync(100);
  }
  return census(dir).length;
}

/** One arm → { red: [titles of `not ok`], rc, leftover (processes still alive after the run, BEFORE the reap), survivors (after the reap) }. */
function runArm(arm, canary) {
  const scratch = fs.mkdtempSync(path.join(process.env.KEEPER_MUTANTS_SCRATCH || os.tmpdir(), 'kt-mut-'));
  try {
    if (arm.rig) {
      const r = spawnSync(process.execPath, [abs(RIG), '--scratch', scratch, '--bounded-wait', '100'], { cwd: REPO, encoding: 'utf8' });
      const m = /BOUNDED: carriers after waiting up to \d+ s = (\d+)/.exec(r.stdout);
      return { rc: r.status, red: m && Number(m[1]) > 0 ? ['BOUNDED'] : [], leftover: 0, survivors: reapAll(scratch), out: r.stdout.trim().split('\n').slice(-4).join(' | ') };
    }
    const file = arm.test ?? arm.census;
    const env = { ...process.env, TMPDIR: scratch, ...(arm.home ? { HOME: scratch } : {}), ...(canary ? { KEEPER_TEST_LEAVE_CANARY: '1' } : {}) };
    if (arm.home) fs.mkdirSync(path.join(scratch, '.cache'), { recursive: true });
    const args = ['--test', '--test-reporter=tap', '--experimental-strip-types', ...(arm.pattern ? ['--test-name-pattern', arm.pattern] : []), file];
    const r = spawnSync(process.execPath, args, { cwd: REPO, env, encoding: 'utf8', timeout: 240_000 });
    const red = [...(r.stdout ?? '').matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((x) => x[1]);
    const canaryRan = /^\s*ok \d+ - after-hook canary/m.test(r.stdout ?? '');
    const leftover = census(scratch).length;
    return { rc: r.status, red, leftover, canaryRan, survivors: reapAll(scratch), out: (r.stderr ?? '').trim().slice(-200) };
  } finally {
    reapAll(scratch);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function killed(m, res) {
  if (m.arm.rig) return res.red.includes('BOUNDED');
  if (m.arm.census) return res.leftover > 0 && res.red.length === 0 && res.rc === 0 && res.canaryRan; // a timeout / crash that leaves processes is NOT a kill: the run must exit 0 with the canary test having run
  return res.red.some((t) => t.includes(m.arm.expect)); // an assertion of THE named test — a crash or a syntax error names nothing
}

let bad = 0;
function sweep(list) {
  if (!anchorsOk(list)) { console.log('ABORT: anchors do not match'); process.exit(1); }
  for (const m of list) {
    const orig = fs.readFileSync(abs(m.file));
    const cleanBefore = spawnSync('git', ['diff', '--quiet', '--', m.file], { cwd: REPO }).status === 0;
    let res;
    try {
      fs.writeFileSync(abs(m.file), orig.toString('utf8').replace(m.find, () => m.replace));
      res = runArm(m.arm, !!m.arm.census);
    } finally {
      fs.writeFileSync(abs(m.file), orig);
    }
    const restored = Buffer.compare(fs.readFileSync(abs(m.file)), orig) === 0 && (!cleanBefore || spawnSync('git', ['diff', '--quiet', '--', m.file], { cwd: REPO }).status === 0);
    const k = killed(m, res);
    const broken = !k && res.rc !== 0 && res.red.length === 0 && !res.leftover && !m.arm.rig; // red without any named assertion = harness/syntax problem, not a kill
    if (!k || !restored || res.survivors !== 0) bad++;
    console.log(`${k ? 'KILLED  ' : broken ? 'BROKEN  ' : 'SURVIVED'} ${m.id}  [${m.clause}]  rc=${res.rc} not-ok=${JSON.stringify(res.red).slice(0, 120)} leftover=${res.leftover} SURVIVORS=${res.survivors} restored=${restored}`);
  }
}

if (selftest) {
  console.log('== controls');
  const base = runArm({ test: KT }, true);
  const baseOk = base.rc === 0 && base.red.length === 0 && base.leftover === 0 && base.survivors === 0;
  console.log(`baseline keeper.test.ts (canary on): rc=${base.rc} not-ok=${base.red.length} leftover=${base.leftover} SURVIVORS=${base.survivors} => ${baseOk ? 'GREEN' : 'RED'}`);
  const baseRig = runArm({ rig: true }, false);
  const baseRigOk = !baseRig.red.length && baseRig.rc === 0 && baseRig.survivors === 0;
  console.log(`baseline rig arm (bounded-wait 100 s, unmutated): rc=${baseRig.rc} BOUNDED-red=${baseRig.red.length} SURVIVORS=${baseRig.survivors} => ${baseRigOk ? 'GREEN' : 'RED'}`);
  const noop = { id: 'noop', clause: 'no-op control', file: TD, find: 'export function identOf', replace: 'export function identOf', arm: { test: KT, pattern: 'identity guard', expect: 'identity guard' } };
  console.log('== no-op mutant must SURVIVE'); const before = bad; sweep([noop]);
  const noopSurvived = bad === before + 1;
  bad = before;
  console.log(`CONTROLS ${baseOk && baseRigOk && noopSurvived ? 'OK' : 'FAILED'}`);
  process.exit(baseOk && baseRigOk && noopSurvived ? 0 : 1);
}
sweep(todo);
console.log(`MUTANTS: ${todo.length - bad}/${todo.length} killed (rc ${bad ? 1 : 0})`);
process.exit(bad ? 1 : 0);
