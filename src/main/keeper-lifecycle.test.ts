import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Track A2 (ledger #224): #201 delete stops session+keeper, #202 one keeper per workspace,
// #203 duplicate-keeper reap. Every arm drives the REAL workspaces.ts / keeper-client.ts /
// resource-monitor.ts against REAL keeper daemons (scripts/e2e-keeper-lifecycle.mjs) in a child
// process — those modules can't be imported bare under the strip-types runner (`./platform` dir).
// Arms marked mustFailOnMaster in the rig are RED on origin/master (verified via SUBJECT_REPO).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RIG = path.join(REPO, 'scripts', 'e2e-keeper-lifecycle.mjs');
const REGISTER = path.join(REPO, 'scripts', '.r2-register.mjs');

const ARMS = [
  'del_single_survivor',
  'del_session_and_keeper',
  'del_session_with_result',
  'del_racing_start_refused',
  'del_bulk_window',
  'del_prune_fast',
  'k4_bg_delete_kills',
  'del_recycled_pid_spared',
  'del_bulk',
  'del_prune_orphan',
  'del_never_started',
  'race_n_starts',
  'daemon_refuses_second',
  'daemon_refuses_hung',
  'stale_two_launch',
  'l1_stale_claim_dead',
  'l1_stale_claim_old',
  'l1_claim_age',
  'l1_giveback',
  'exit_owns_only',
  'exit_pidless_fallback',
  'survivor_killable',
  'sweep_spares_successor',
  'kill_serialized_with_start',
  'kill_refuses_reused_pid',
  'kill_pid_fallback_reaches',
  'kill_spares_successor_files',
  'kill_keeps_log',
  'k4_bg_restart_spares',
  'sweep_dead_claims',
  'sweep_live_claim_kept',
  'killtree_recycled_spared',
  'killtree_identity_ctl',
  'kill_hung_keeper',
  'reap_dup_live',
  'reap_boot_pass',
  'reap_sole_live',
  'reap_wrapper_sole',
  'reap_store_unreadable',
  'reap_absent_all',
  'reap_failclosed',
] as const;

type Verdict = Record<string, unknown> & { ok: boolean };
const results = new Map<string, Verdict | { ok: false; error: string }>();

function runArm(arm: string): Promise<Verdict | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--experimental-strip-types', '--import', REGISTER, RIG, arm],
      { cwd: REPO, timeout: 240_000, encoding: 'utf8', env: { ...process.env, A2_HOME: RIG_DIR } },
      (_err, stdout) => {
        const line = stdout.trim().split('\n').filter(Boolean).pop();
        // An EMPTY result must never read as a pass (a crashed rig prints nothing).
        if (!line) return resolve({ ok: false, error: 'no output — the rig did not run' });
        try {
          resolve(JSON.parse(line) as Verdict);
        } catch {
          resolve({ ok: false, error: `unparseable rig output: ${line.slice(0, 200)}` });
        }
      },
    );
  });
}

const RIG_DIR = path.join(os.homedir(), '.cache', 'a2-rig', `u${process.pid}`);

/** Live (non-zombie) pids whose argv mentions this file's rig dir — keepers, `timeout` wrappers, fake CLIs. */
function rigPids(): number[] {
  const out: number[] = [];
  for (const e of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(e) || Number(e) === process.pid) continue;
    try {
      if (!fs.readFileSync(`/proc/${e}/cmdline`, 'utf8').split('\0').some((a) => a.includes(RIG_DIR))) continue;
      if (/^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${e}/stat`, 'utf8'))) continue; // reaped-pending zombie = dead
      out.push(Number(e));
    } catch {
      /* gone */
    }
  }
  return out;
}

before(async () => {
  // Small pool: each arm launches real keeper daemons; the whole suite runs files in parallel already.
  const queue = [...ARMS];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let a = queue.shift(); a; a = queue.shift()) results.set(a, await runArm(a));
    }),
  );
});

test('every arm the rig declares is run here (no silently unrun arm)', () => {
  const src = fs.readFileSync(RIG, 'utf8');
  const block = src.slice(src.indexOf('const ARMS = {'), src.indexOf('};', src.indexOf('const ARMS = {')));
  const declared = [...block.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]).sort();
  assert.deepEqual(declared, [...ARMS].sort());
});

const NOTES: Record<(typeof ARMS)[number], string> = {
  del_single_survivor: '#201 single delete of a post-relaunch survivor keeper: keeper+CLI dead, pid/sock files gone, facade closed',
  del_session_and_keeper: '#201 socket/CLI delete route: in-memory session dropped AND keeper+CLI dead',
  del_session_with_result: '#201 a session that produced a result closes gracefully — the delete\'s own killKeeper still takes the keeper down',
  del_racing_start_refused: '#201 a wake racing the delete cannot launch a keeper for the dying workspace (A3 F4)',
  del_bulk_window: '#201 bulk delete tombstones EVERY id up front: a wake on B during A\'s slow teardown runs no turn (L5)',
  del_prune_fast: '#201 boot prune of 4 orphan keepers returns fast (session stops run in the background) and they all end dead (L2)',
  del_recycled_pid_spared: '#201 a delete whose pid file names a LIVE NON-keeper (recycled pid) with a child signals neither (identity fail-closed on snapshotKeeperTree/killKeeperTree) (F2)',
  k4_bg_delete_kills: '#201 a DELETE also takes down the agent\'s background job (snapshot before the stop, kill after) (D1)',
  del_bulk: '#201 bulk delete (incl. hibernated row with stale files): all keepers dead, no throw',
  del_prune_orphan: '#201 boot orphan prune kills the orphan keeper; a tracked workspace keeps its keeper',
  del_never_started: '#201 hibernated / never-started delete → no error (must-PASS on master too)',
  race_n_starts: '#202 N=6 concurrent starts → exactly 1 keeper + 1 CLI; killKeeper reaches the survivor',
  daemon_refuses_hung: '#202 a 2nd daemon fails CLOSED on a hung (SIGSTOP) live keeper: refuses, leaves its files',
  daemon_refuses_second: '#202 a second daemon on a live keeper\'s socket refuses, touching no file',
  l1_stale_claim_dead: '#202 a crashed daemon\'s claim naming a DEAD pid never blocks a launch: N daemons → 1 keeper, serving promptly (D2)',
  l1_stale_claim_old: '#202 a claim held by a live pid but > 5 s old is broken by AGE: N daemons → 1 keeper, serving promptly (D2)',
  l1_giveback: '#202 a live fresh claim swapped in between the stale verdict and the rename is GIVEN BACK — a 3rd daemon must not acquire over it (rename-aside + give-back, F1)',
  l1_claim_age: '#202 a claim\'s age counts from ACQUISITION (utimes before link), and a live fresh claim is not broken early (D5)',
  stale_two_launch: '#202 two daemons started together over a STALE socket end as ONE keeper (atomic takeover claim, L1)',
  exit_pidless_fallback: '#202 a keeper\'s exit with the takeover\'s pid file absent must not unlink the takeover\'s socket (MA)',
  exit_owns_only: '#202 a keeper\'s exit does not unlink a takeover\'s socket/pid',
  survivor_killable: '#202 killKeeper still reaches the survivor after a sibling\'s exit',
  sweep_spares_successor: '#202 the post-kill sweep spares a live successor\'s files, clears dead ones',
  kill_serialized_with_start: '#202 a killKeeper issued right after a start queues behind it and kills it (no interleave)',
  kill_refuses_reused_pid: '#202/identity killKeeper never signals a pid-file pid that is not this workspace\'s keeper',
  kill_hung_keeper: '#201 killKeeper on a wedged keeper: SIGKILL fallback also takes its CLI down (no ppid-1 orphan) and clears the files',
  kill_spares_successor_files: '#202 killKeeper\'s own post-kill sweep spares a live successor\'s socket/pid (K8); killKeeper still reaches it',
  k4_bg_restart_spares: '#201 a HEALTHY kill (restart/clear/MCP refresh) does NOT kill the agent\'s background job (D1)',
  sweep_live_claim_kept: '#202 a claim file / .stale.<pid> owned by a LIVE pid survives the sweep; a dead one does not (F3)',
  killtree_recycled_spared: '#201 killKeeperTree spares a snapshot entry whose pid was recycled (start-time mismatch) (F2)',
  killtree_identity_ctl: '#201 control: killKeeperTree with the CORRECT start-time DOES kill it (the arm can see a kill) (F2)',
  sweep_dead_claims: '#202 leftover <ws>.pid.claim / .claim.<pid>.tmp / .claim.stale.<pid> of DEAD pids are swept, a live one is kept (D7)',
  kill_keeps_log: '#201 stopping a keeper does not delete its <ws>.log (L7, master behaviour)',
  kill_pid_fallback_reaches: 'killKeeper\'s pid fallback still reaches a real keeper (must-PASS on master too)',
  reap_dup_live: '#203 duplicate keeper of a live workspace reaped, tracked one untouched, one log line',
  reap_boot_pass: '#203 the boot pass (reapKeepersNow): store not loaded → kills nothing; loaded → orphan + duplicate reaped, tracked kept',
  reap_wrapper_sole: '#203 a live ws\'s sole keeper behind a fork-style wrapper is never reaped as a duplicate',
  reap_sole_live: '#203 a live workspace\'s sole keeper (incl. hibernated) is never reaped (must-PASS)',
  reap_store_unreadable: '#203 a sweep whose store did not load from disk kills nothing (must-PASS)',
  reap_absent_all: '#203 absent workspace: tracked AND untracked keepers reaped',
  reap_failclosed: '#203 identity re-verified at signal time: cmdline/start-time/tracked-keeper drift → no signal',
};

for (const arm of ARMS) {
  test(`${arm} — ${NOTES[arm]}`, () => {
    const r = results.get(arm);
    assert.ok(r, `arm ${arm} did not run`);
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 1500));
  });
}

test('boot reconcile reaps through the guarded pass and never kills on a bare store lookup (index.ts wiring)', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'main', 'index.ts'), 'utf8');
  const fn = src.slice(src.indexOf('async function reconcileKeepersAtStartup'), src.indexOf('function shutdownSubsystems'));
  assert.ok(fn.length > 200, 'reconcileKeepersAtStartup not found');
  assert.match(fn, /await reapKeepersNow\(\)/);
  assert.match(fn, /bootFallbackKills\(process\.platform/);
  // the only killKeeper is the non-Linux fallback's, fed by the guarded bootFallbackKills list
  assert.equal((fn.match(/killKeeper\(/g) ?? []).length, 1);
});

/** Non-zombie pids whose argv mentions `dir` (+ their state letter). */
function pidsUnder(dir: string): Array<{ pid: number; state: string }> {
  const out: Array<{ pid: number; state: string }> = [];
  for (const e of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(e) || Number(e) === process.pid) continue;
    try {
      if (!fs.readFileSync(`/proc/${e}/cmdline`, 'utf8').split('\0').some((a) => a.includes(dir))) continue;
      const state = fs.readFileSync(`/proc/${e}/stat`, 'utf8').replace(/^.*\) /, '')[0];
      if (state !== 'Z') out.push({ pid: Number(e), state });
    } catch {
      /* gone */
    }
  }
  return out;
}

async function waitUntil(pred: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

// D4 — ABNORMAL termination: a group SIGTERM of the rig (Ctrl-C / harness abort) while a keeper is SIGSTOPped must still
// leave 0 processes (the rig's watchdog runs in its OWN session and SIGKILLs everything under the rig dir).
test('a group SIGTERM of a rig mid-arm (SIGSTOPped keeper) leaves no process behind', async () => {
  const dir = path.join(RIG_DIR, 'gk');
  const child = spawn(process.execPath, ['--experimental-strip-types', '--import', REGISTER, RIG, 'daemon_refuses_hung'], {
    cwd: REPO, detached: true, stdio: 'ignore', env: { ...process.env, A2_HOME: dir },
  });
  child.unref();
  const sawStopped = await waitUntil(() => pidsUnder(dir).some((p) => p.state === 'T'), 60_000);
  assert.ok(sawStopped, 'setup: never saw a SIGSTOPped keeper under the rig dir');
  process.kill(-(child.pid as number), 'SIGTERM'); // the whole group, like a terminal Ctrl-C
  const clean = await waitUntil(() => pidsUnder(dir).length === 0, 10_000);
  assert.deepEqual(pidsUnder(dir), [], 'processes survived a group SIGTERM (rig watchdog did not reap)');
  assert.ok(clean);
});

// LEAK ASSERTION (the fleet's 588-orphan incident): 0 fake keeper / CLI / wrapper pids may outlive the arms — each
// arm's own finish() must have reaped them (incl. SIGSTOPped and SIGTERM-ignoring ones). Checked BEFORE the safety net.
test('no keeper / fake CLI / wrapper process is left running by the arms', () => {
  const left = rigPids();
  assert.deepEqual(left, [], `leaked ${left.length} pid(s) under ${RIG_DIR}`);
});

after(async () => {
  // Safety net (an arm killed by its 240 s timeout cannot reap its own children): SIGKILL, then verify none remain.
  for (const pid of rigPids()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  for (let i = 0; i < 50 && rigPids().length; i++) await new Promise((r) => setTimeout(r, 100));
  const left = rigPids();
  fs.rmSync(RIG_DIR, { recursive: true, force: true });
  assert.deepEqual(left, [], `pids survived SIGKILL: ${left.join(',')}`);
});
