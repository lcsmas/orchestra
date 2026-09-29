import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
  'del_bulk',
  'del_prune_orphan',
  'del_never_started',
  'race_n_starts',
  'daemon_refuses_second',
  'daemon_refuses_hung',
  'stale_two_launch',
  'exit_owns_only',
  'exit_pidless_fallback',
  'survivor_killable',
  'sweep_spares_successor',
  'kill_serialized_with_start',
  'kill_refuses_reused_pid',
  'kill_pid_fallback_reaches',
  'kill_spares_successor_files',
  'kill_keeps_log',
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

const RIG_DIR = path.join(os.homedir(), '.a2-rig', `u${process.pid}`);

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
  del_bulk: '#201 bulk delete (incl. hibernated row with stale files): all keepers dead, no throw',
  del_prune_orphan: '#201 boot orphan prune kills the orphan keeper; a tracked workspace keeps its keeper',
  del_never_started: '#201 hibernated / never-started delete → no error (must-PASS on master too)',
  race_n_starts: '#202 N=6 concurrent starts → exactly 1 keeper + 1 CLI; killKeeper reaches the survivor',
  daemon_refuses_hung: '#202 a 2nd daemon fails CLOSED on a hung (SIGSTOP) live keeper: refuses, leaves its files',
  daemon_refuses_second: '#202 a second daemon on a live keeper\'s socket refuses, touching no file',
  stale_two_launch: '#202 two daemons started together over a STALE socket end as ONE keeper (atomic takeover claim, L1)',
  exit_pidless_fallback: '#202 a keeper\'s exit with the takeover\'s pid file absent must not unlink the takeover\'s socket (MA)',
  exit_owns_only: '#202 a keeper\'s exit does not unlink a takeover\'s socket/pid',
  survivor_killable: '#202 killKeeper still reaches the survivor after a sibling\'s exit',
  sweep_spares_successor: '#202 the post-kill sweep spares a live successor\'s files, clears dead ones',
  kill_serialized_with_start: '#202 a killKeeper issued right after a start queues behind it and kills it (no interleave)',
  kill_refuses_reused_pid: '#202/identity killKeeper never signals a pid-file pid that is not this workspace\'s keeper',
  kill_hung_keeper: '#201 killKeeper on a wedged keeper: SIGKILL fallback also takes its CLI down (no ppid-1 orphan) and clears the files',
  kill_spares_successor_files: '#202 killKeeper\'s own post-kill sweep spares a live successor\'s socket/pid (K8); killKeeper still reaches it',
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
