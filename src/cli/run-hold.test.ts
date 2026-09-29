import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bus from '../main/bus.ts';
import { wantsCommandHelp } from './help.ts';
import * as busRuns from '../main/bus-runs.ts';
import {
  sweepBusLiveness,
  setLivenessRoster,
  setLivenessSwitchReader,
  __setBusReaderForTests,
  __setNowForTests,
  __resetBusLivenessForTests,
  __armForTests,
  type LivenessMember,
} from '../main/bus-liveness.ts';

// ISSUE #204 remainder (LEAD ruling D4 ii): `orchestra run hold` / `run resume` —
// the explicit per-run HOLD flag. The flag is written by the BUILT CLI (the real
// verb, an isolated ORCHESTRA_HOME + HOME — never the live ~/.orchestra/bus.sqlite)
// and read back by the SHIPPED liveness sweep through a SEPARATE connection, so
// the arm covers the durable path a hold takes across an app relaunch:
// verb → bus.sqlite → sweep. The verb is store-less (like send/ack): it must work
// while the app is DOWN, which is exactly when an operator wants to hold a run
// before relaunching.
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const needsBuild = {
  skip: existsSync(CLI) ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`',
};

const NOW = 1_700_000_000_000;
const ALL_ON = { delivery: true, wake: true, askGate: true, liveness: true, fencing: true, capability: true, receipts: true };

interface Cli {
  code: number;
  stdout: string;
  stderr: string;
}

/** Drive the built CLI in an isolated home. `runEnv` is exported as
 *  $ORCHESTRA_RUN_ID (null = unset — a leaked value from THIS workspace would
 *  silently become the target run). The socket is dead on purpose: the verb must
 *  not need the app. */
function cli(
  home: string,
  args: string[],
  runEnv: string | null = null,
  wsId: string | null = 'hold-tester',
  extraEnv: Record<string, string> = {},
): Cli {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    ORCHESTRA_HOME: home,
    ORCHESTRA_SOCK: path.join(home, 'no.sock'),
  };
  if (wsId !== null) env.ORCHESTRA_WS_ID = wsId;
  Object.assign(env, extraEnv);
  if (runEnv !== null) env.ORCHESTRA_RUN_ID = runEnv;
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function tmpHome(t: { after: (fn: () => void) => void }): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'orch-runhold-'));
  t.after(() => {
    __resetBusLivenessForTests();
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

/** Seed runs whose COORDINATOR is `coordinator` (default = the caller identity `cli()` uses,
 *  so the verb is authorized — D7). */
function seedRuns(home: string, ids: string[], coordinator = 'hold-tester'): void {
  const db = bus.openBus(path.join(home, 'bus.sqlite'));
  try {
    for (const id of ids) {
      busRuns.startRun(db, { id, kind: 'vague', coordinator }, ALL_ON);
    }
  } finally {
    db.close();
  }
}

/** The run ids the bus says are held, read through a FRESH connection. */
function held(home: string): string[] {
  const db = bus.openBus(path.join(home, 'bus.sqlite'));
  try {
    return [...busRuns.heldRunIds(db)].sort();
  } finally {
    db.close();
  }
}

/** One silent (11m) tasked member per run, on the sweep's real switch/hold reads. */
function sweepRuns(home: string, runs: string[]): Map<string, number> {
  const db = bus.openBus(path.join(home, 'bus.sqlite'));
  try {
    __resetBusLivenessForTests();
    __setBusReaderForTests(() => db);
    __setNowForTests(() => NOW);
    setLivenessSwitchReader(() => true);
    setLivenessRoster(() =>
      runs.map(
        (r): LivenessMember => ({
          reader: `w-${r}`,
          coordinator: `ops-${r}`,
          hasTask: true,
          lastActivityAt: NOW - 11 * 60 * 1000,
          running: false,
          waiting: false,
          runId: r,
        }),
      ),
    );
    __armForTests();
    sweepBusLiveness();
    const out = new Map<string, number>();
    for (const r of runs) {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE run_id=? AND kind='escalation' AND sender=?`)
        .get(r, `w-${r}`) as { n: number };
      out.set(r, Number(row.n));
    }
    return out;
  } finally {
    db.close();
  }
}

test('hold via the REAL CLI → the sweep skips the held run; a non-held run still escalates; resume re-enables', needsBuild, (t) => {
  // MUST-FAIL on master: there is no `run hold` (the verb refuses with a usage
  // line), so the held run's member escalates. The observable is asserted FIRST so
  // the master failure reads as "escalated", not merely "verb missing".
  // MUTANTS: (a) the sweep never reads the hold → the held run escalates;
  //   (b) hold applied to every run → `run-open` reads 0 (the positive control);
  //   (c) resume does not clear → the last assertion stays 0.
  const home = tmpHome(t);
  seedRuns(home, ['run-held', 'run-open']);
  const hold = cli(home, ['run', 'hold', '--run', 'run-held']);
  const during = sweepRuns(home, ['run-held', 'run-open']);
  assert.equal(during.get('run-held'), 0, `member of a HELD run must not escalate (cli: ${JSON.stringify(hold)})`);
  assert.equal(during.get('run-open'), 1, 'member of a NON-held run still escalates (positive control)');
  assert.equal(hold.code, 0, `hold rc (stderr: ${hold.stderr})`);
  assert.match(hold.stdout, /run-held/);
  assert.match(hold.stdout, /HELD/);
  assert.deepEqual(held(home), ['run-held'], 'the flag is durable: a fresh connection reads it');

  const resume = cli(home, ['run', 'resume', '--run', 'run-held']);
  assert.equal(resume.code, 0, `resume rc (stderr: ${resume.stderr})`);
  assert.match(resume.stdout, /resumed/);
  assert.deepEqual(held(home), [], 'resume clears the flag');
  const after = sweepRuns(home, ['run-held']);
  assert.equal(after.get('run-held'), 1, 'after resume the silent member escalates again');
});

test('hold defaults to $ORCHESTRA_RUN_ID (an OPS holds its OWN run with no flag)', needsBuild, (t) => {
  // MUTANT: ignore the env and fall through to 'default' → refused (no such run) → RED.
  const home = tmpHome(t);
  seedRuns(home, ['run-held', 'run-open']);
  const r = cli(home, ['run', 'hold'], 'run-held');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(held(home), ['run-held']);
});

test('hold on an UNKNOWN run is REFUSED, names the run, and writes nothing', needsBuild, (t) => {
  // A typo'd hold must not be accepted silently and do nothing. MUTANT: INSERT a
  // run row / print success for an unknown id → rc 0 or a phantom row → RED.
  const home = tmpHome(t);
  seedRuns(home, ['run-held']);
  const r = cli(home, ['run', 'hold', '--run', 'run-typo']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /run-typo/);
  assert.match(r.stderr, /has no row/);
  assert.deepEqual(held(home), [], 'nothing held');
  const db = bus.openBus(path.join(home, 'bus.sqlite'));
  try {
    assert.equal(busRuns.getRun(db, 'run-typo'), null, 'a refused hold creates no run row');
  } finally {
    db.close();
  }
  // No --run and no env → the `default` sentinel, which never has a row: refused too.
  const d = cli(home, ['run', 'hold']);
  assert.notEqual(d.code, 0);
  assert.match(d.stderr, /default/);
});

test('hold and resume are idempotent (rc 0, state unchanged, the message says so)', needsBuild, (t) => {
  // MUTANT: a second hold re-stamps held_at, or resume-when-not-held fails → RED.
  const home = tmpHome(t);
  seedRuns(home, ['run-held']);
  assert.equal(cli(home, ['run', 'hold', '--run', 'run-held']).code, 0);
  const stampOf = (): number => {
    const db = bus.openBus(path.join(home, 'bus.sqlite'));
    try {
      return (db.prepare('SELECT held_at FROM runs WHERE id=?').get('run-held') as { held_at: number }).held_at;
    } finally {
      db.close();
    }
  };
  const first = stampOf();
  const again = cli(home, ['run', 'hold', '--run', 'run-held']);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /already held/);
  assert.equal(stampOf(), first, 'the original hold time is kept');
  assert.equal(cli(home, ['run', 'resume', '--run', 'run-held']).code, 0);
  const twice = cli(home, ['run', 'resume', '--run', 'run-held']);
  assert.equal(twice.code, 0, twice.stderr);
  assert.match(twice.stdout, /not held/);
});

test('`run hold --help` prints usage and never opens the bus', needsBuild, (t) => {
  // MUTANT: leave `hold` out of the subcommand-help set → the verb runs (and opens
  // the bus file) instead of printing help → RED on the existsSync assertion.
  const home = tmpHome(t);
  for (const sub of ['hold', 'resume']) {
    const r = cli(home, ['run', sub, '--help']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^usage: orchestra run /);
    assert.match(r.stdout, /hold/);
    assert.match(r.stdout, /resume/);
  }
  assert.equal(existsSync(path.join(home, 'bus.sqlite')), false, 'help must not create/open the bus');
});

test('`run <unknown>` still refuses, and the usage names all three subcommands', needsBuild, (t) => {
  const home = tmpHome(t);
  const r = cli(home, ['run', 'bogus']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /refreeze/);
  assert.match(r.stderr, /hold/);
  assert.match(r.stderr, /resume/);
});

test('`hold`/`resume` count as help subcommands ONLY under `run` (free text is never hijacked)', () => {
  // MUTANT: drop the `command === 'run'` scope → `orchestra status hold --help`
  //   (a status note) prints help instead of setting the note → the 2nd assert is RED.
  assert.equal(wantsCommandHelp(['hold', '--help'], 'run'), true);
  assert.equal(wantsCommandHelp(['resume', '-h'], 'run'), true);
  assert.equal(wantsCommandHelp(['hold', '--help'], 'status'), false);
  assert.equal(wantsCommandHelp(['resume', '--help']), false, 'no command → not a run subcommand');
});

// ── review-A4 dispositions (ledger #224) ─────────────────────────────────────

function holdOf(home: string, runId: string): { heldAt: number; heldBy: string | null } | null {
  const db = bus.openBus(path.join(home, 'bus.sqlite'));
  try {
    return busRuns.getRunHold(db, runId);
  } finally {
    db.close();
  }
}

test('#204 F3: the CLI records the holder — --as beats $ORCHESTRA_WS_ID; a repeat hold names the ORIGINAL holder; a bare terminal is refused', needsBuild, (t) => {
  // MUTANT: never pass the identity to setRunHold / prefer env over --as → RED.
  const home = tmpHome(t);
  seedRuns(home, ['run-env']); // coordinator = hold-tester = the env identity
  seedRuns(home, ['run-as'], 'alice');
  assert.equal(cli(home, ['run', 'hold', '--run', 'run-env']).code, 0);
  assert.equal(holdOf(home, 'run-env')?.heldBy, 'hold-tester', '$ORCHESTRA_WS_ID is the default holder');
  assert.equal(cli(home, ['run', 'hold', '--run', 'run-as', '--as', 'alice']).code, 0);
  assert.equal(holdOf(home, 'run-as')?.heldBy, 'alice', '--as beats the env (env identity is NOT alice\'s)');
  const again = cli(home, ['run', 'hold', '--run', 'run-as', '--as', 'alice']);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /already held/);
  assert.match(again.stdout, /by alice/, 'the repeat-hold message names the holder');
  const none = cli(home, ['run', 'hold', '--run', 'run-env'], null, null);
  assert.notEqual(none.code, 0, 'a caller with no identity is refused (D7)');
  assert.match(none.stderr, /--as/);
});

test('#204 F4: --run beats $ORCHESTRA_RUN_ID in `run hold` and `run resume`', needsBuild, (t) => {
  // review-A4 F4 (survivor). MUTANT: env beats the flag (`env || flag`) → the wrong run is held → RED.
  const home = tmpHome(t);
  seedRuns(home, ['run-mine', 'run-victim']);
  assert.equal(cli(home, ['run', 'hold', '--run', 'run-victim'], 'run-mine').code, 0);
  assert.deepEqual(held(home), ['run-victim'], 'the flag names the target, not the env');
  assert.equal(cli(home, ['run', 'hold', '--run', 'run-mine'], 'run-mine').code, 0);
  assert.equal(cli(home, ['run', 'resume', '--run', 'run-victim'], 'run-mine').code, 0);
  assert.deepEqual(held(home), ['run-mine'], 'resume --run also beats the env');
});

// ── LEAD ruling D7 + review-A4 F7 (ledger #224) — through the BUILT verb ─────

/** run-lead(lead-boss, fencing OFF/ON per `fencing`) ⊃ run-ops(ops-boss). */
function seedTree(home: string, fencing: boolean): void {
  const db = bus.openBus(path.join(home, 'bus.sqlite'));
  try {
    const sw = { ...ALL_ON, fencing };
    busRuns.startRun(db, { id: 'run-lead', kind: 'mission', coordinator: 'lead-boss' }, sw);
    busRuns.startRun(db, { id: 'run-ops', kind: 'vague', coordinator: 'ops-boss', parentRunId: 'run-lead' }, sw);
  } finally {
    db.close();
  }
}

test('#204 D7 (MUST-FAIL before the fix): an unrelated agent\'s hold is REFUSED naming who may; the coordinator and the ancestor succeed', needsBuild, (t) => {
  // MUTANT: no authorization in the writer → the unrelated caller holds the run → RED.
  const home = tmpHome(t);
  seedTree(home, false);
  const bad = cli(home, ['run', 'hold', '--run', 'run-ops'], null, 'some-worker');
  assert.notEqual(bad.code, 0, 'an unrelated agent must not hold another run');
  assert.deepEqual(held(home), [], 'the refused hold changed nothing');
  // Each clause on its OWN wording: the tail "who is none of …" repeats the names and would mask a dropped clause.
  assert.match(bad.stderr, /by its coordinator \(ops-boss\)/, 'names the run\'s coordinator');
  assert.match(bad.stderr, /ancestor run \(lead-boss\)/, 'names the ancestor coordinator');
  // No identity at all (a bare terminal) is refused too, and says how to act as someone.
  const anon = cli(home, ['run', 'hold', '--run', 'run-ops'], null, null);
  assert.notEqual(anon.code, 0);
  assert.match(anon.stderr, /--as/);
  assert.deepEqual(held(home), []);
  // The coordinator holds; the ANCESTOR's coordinator resumes it; a bare terminal can act with --as.
  assert.equal(cli(home, ['run', 'hold', '--run', 'run-ops'], null, 'ops-boss').code, 0);
  assert.equal(holdOf(home, 'run-ops')?.heldBy, 'ops-boss');
  const unrelatedResume = cli(home, ['run', 'resume', '--run', 'run-ops'], null, 'some-worker');
  assert.notEqual(unrelatedResume.code, 0, 'resume is guarded too');
  assert.deepEqual(held(home), ['run-ops']);
  assert.equal(cli(home, ['run', 'resume', '--run', 'run-ops'], null, 'lead-boss').code, 0, 'ancestor coordinator');
  assert.deepEqual(held(home), []);
  assert.equal(cli(home, ['run', 'hold', '--run', 'run-ops', '--as', 'ops-boss'], null, null).code, 0, '--as from a bare terminal');
  // A DESCENDANT's coordinator may not hold the PARENT run.
  const up = cli(home, ['run', 'hold', '--run', 'run-lead'], null, 'ops-boss');
  assert.notEqual(up.code, 0);
  assert.equal(held(home).includes('run-lead'), false);
});

function fenceRows(home: string): { verb: string; fired: number; actor: string }[] {
  const db = bus.openBus(path.join(home, 'bus.sqlite'));
  try {
    return db.prepare('SELECT verb, fired, actor FROM fence_events ORDER BY id').all() as {
      verb: string;
      fired: number;
      actor: string;
    }[];
  } finally {
    db.close();
  }
}

test('#204 F7 (MUST-FAIL before the fix): a STALE coordinator cannot hold or resume its successor\'s run (fencing ON)', needsBuild, (t) => {
  // review-A4 addendum: run hold was a raw UPDATE outside fencedWrite. MUTANT: skip the fence
  // (write unfenced) → the stale hold lands rc 0 → RED.
  const home = tmpHome(t);
  seedTree(home, true);
  const db = bus.openBus(path.join(home, 'bus.sqlite'));
  assert.equal(bus.bumpCoordinatorGeneration(db, 'run-ops'), 1);
  db.close();
  const stale = cli(home, ['run', 'hold', '--run', 'run-ops'], null, 'ops-boss', { ORCHESTRA_COORDINATOR_GENERATION: '0' });
  assert.notEqual(stale.code, 0, `a superseded coordinator's hold must be refused (stdout: ${stale.stdout})`);
  assert.match(stale.stderr, /generation|stale|supersed/i);
  assert.deepEqual(held(home), [], 'the fenced hold did not land');
  const rows = fenceRows(home);
  assert.deepEqual(rows.map((r) => [r.verb, r.fired, r.actor]), [['run-hold', 1, 'ops-boss']], 'one FIRED fence event, verb run-hold');
  // The live coordinator (current generation) holds; then a stale resume is fenced too.
  assert.equal(cli(home, ['run', 'hold', '--run', 'run-ops'], null, 'ops-boss', { ORCHESTRA_COORDINATOR_GENERATION: '1' }).code, 0);
  const staleResume = cli(home, ['run', 'resume', '--run', 'run-ops'], null, 'ops-boss', { ORCHESTRA_COORDINATOR_GENERATION: '0' });
  assert.notEqual(staleResume.code, 0);
  assert.deepEqual(held(home), ['run-ops'], 'the stale resume did not land');
  assert.equal(fenceRows(home).at(-1)?.verb, 'run-resume');
});

test('#204 F7: the fence is coordinator-only (A6) — an ancestor with a mismatched generation is not fenced; a refused member leaves no fence event; fencing OFF only counts', needsBuild, (t) => {
  // MUTANT: fence every caller (not just the run's coordinator) → the ancestor arm is RED;
  //   fire when the switch is OFF → the OFF arm is RED.
  const home = tmpHome(t);
  seedTree(home, true);
  const db = bus.openBus(path.join(home, 'bus.sqlite'));
  bus.bumpCoordinatorGeneration(db, 'run-ops');
  db.close();
  // A member with a stale generation: refused by D7 (authorization), NOT by the fence → no fence event.
  const member = cli(home, ['run', 'hold', '--run', 'run-ops'], null, 'some-worker', { ORCHESTRA_COORDINATOR_GENERATION: '0' });
  assert.notEqual(member.code, 0);
  assert.deepEqual(fenceRows(home), [], 'a member is never fenced (A6) — refused by authorization instead');
  // The ANCESTOR coordinator presents gen 0 (its own env): not X's coordinator → passes the fence.
  const anc = cli(home, ['run', 'hold', '--run', 'run-ops'], null, 'lead-boss', { ORCHESTRA_COORDINATOR_GENERATION: '0' });
  assert.equal(anc.code, 0, anc.stderr);
  assert.deepEqual(held(home), ['run-ops']);
  assert.deepEqual(fenceRows(home), [], 'no fence event for a non-coordinator writer');
  // fencing OFF: a stale coordinator is COUNTED (fired=0) and the write proceeds.
  const home2 = tmpHome(t);
  seedTree(home2, false);
  const d2 = bus.openBus(path.join(home2, 'bus.sqlite'));
  bus.bumpCoordinatorGeneration(d2, 'run-ops');
  d2.close();
  const off = cli(home2, ['run', 'hold', '--run', 'run-ops'], null, 'ops-boss', { ORCHESTRA_COORDINATOR_GENERATION: '0' });
  assert.equal(off.code, 0, off.stderr);
  assert.deepEqual(held(home2), ['run-ops']);
  assert.deepEqual(fenceRows(home2).map((r) => [r.verb, r.fired]), [['run-hold', 0]], 'COUNTED, not fired');
});

test('#204 F7: --generation is honoured (flag, no env) and the fence is keyed on the TARGET run\'s switch', needsBuild, (t) => {
  // MUTANT: ignore --generation → the stale hold lands → RED; read the fencing switch of the
  //   `default` run (no row → OFF) instead of the target's → a stale hold is only COUNTED → RED.
  const home = tmpHome(t);
  seedTree(home, true);
  const db = bus.openBus(path.join(home, 'bus.sqlite'));
  bus.bumpCoordinatorGeneration(db, 'run-ops');
  db.close();
  const stale = cli(home, ['run', 'hold', '--run', 'run-ops', '--generation', '0'], null, 'ops-boss');
  assert.notEqual(stale.code, 0, 'the --generation flag alone presents a stale generation');
  assert.deepEqual(held(home), []);
  assert.equal(
    cli(home, ['run', 'hold', '--run', 'run-ops', '--generation', '1'], null, 'ops-boss').code,
    0,
    'the current generation passes',
  );
});
