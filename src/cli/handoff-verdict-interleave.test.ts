import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bus from '../main/bus.ts';
import { startRun } from '../main/bus-runs.ts';
import { busFrameFor } from '../main/handoff-bus.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';
import { composeBusFrame, composeOpeningTurn } from '../shared/handoff.ts';

// #496 — a verdict that lands while the coordinator is in a handoff is never lost. The interleave (run 2 of the bench, PR 13364): the verdict ping
// (a bus `status` to the coordinator) arrives after the handoff was ACCEPTED; the fresh context polled the run NAME its summary used
// (`check --run <name>`), which is no run id — an EMPTY batch, "nothing pending" — while the verdict sat in the real run for 23 min.
// The rig: a REAL bus in a scratch home, the BUILT CLI as the reader, the host's opening-turn composition as the only thing the fresh context knows.
// "The new session" below = does what its opening says (the `orchestra check --run <r>` lines of the bus frame), else polls the run NAME from its summary.
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const needsBuild = { skip: existsSync(CLI) ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`' };

const RUN_ID = '4984931a-c40d-4e80-9b91-344e9f120496'; // the real run id (= the coordinator's workspace id in the field)
const RUN_NAME = 'rts-orchestra-verified-fanout-2'; // what the summary called it — NOT a run id
const COORD = 'coord-ws-496';
const VERIFIER = 'verifier-ws-496';

interface Cli { code: number; stdout: string; stderr: string }

function check(home: string, args: string[], ownRun?: string): Cli {
  const env: Record<string, string> = { ...process.env, ORCHESTRA_HOME: home, HOME: home, ORCHESTRA_WS_ID: COORD };
  if (ownRun) env.ORCHESTRA_RUN_ID = ownRun;
  else delete env.ORCHESTRA_RUN_ID;
  delete env.ORCHESTRA_SESSION_KEY;
  try {
    const stdout = execFileSync(process.execPath, [CLI, 'check', ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function withBus<T>(home: string, fn: (db: bus.BusDb) => T): T {
  const prev = process.env.ORCHESTRA_HOME;
  process.env.ORCHESTRA_HOME = home;
  try {
    const db = bus.openBus(bus.busPath(), {});
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    if (prev === undefined) delete process.env.ORCHESTRA_HOME;
    else process.env.ORCHESTRA_HOME = prev;
  }
}

function rig(t: { after: (fn: () => void) => void }): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'orch-496-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  withBus(home, (db) => startRun(db, { id: RUN_ID, kind: 'mission', coordinator: COORD }, DEFAULT_BUS_SWITCHES));
  return home;
}

const verdict = (home: string, body = 'new comment on ledger'): number =>
  withBus(home, (db) => bus.send(db, { runId: RUN_ID, sender: VERIFIER, kind: 'status', body, recipient: COORD }));

const SUMMARY = `## STATE\nCoordinator of run ${RUN_NAME}; waiting on verdict NMC-4468.\n## NEXT STEPS\nmerge on PASS.\n## REFS\nledger https://github.com/o/r/issues/1845\n## NOT VERIFIED\nnothing`;
const openingOf = (frame: string | null): string =>
  composeOpeningTurn({ summary: SUMMARY, savedAt: '2026-11-20T23:07:59.235Z' }) + (frame ? `\n\n${frame}` : '');

/** The fresh context's first poll: the check lines its opening orders, else the run NAME its summary gave. Returns the CLI outcomes. */
function freshContextPolls(home: string, opening: string): Cli[] {
  const ordered = [...opening.matchAll(/^orchestra check --run (\S+)$/gm)].map((m) => m[1]);
  return (ordered.length ? ordered : [RUN_NAME]).map((r) => check(home, ['--run', r]));
}
const seen = (c: Cli, seq: number): boolean => c.code === 0 && (JSON.parse(c.stdout.split('\n')[0]) as { messages: { sequence: number }[] }).messages.some((m) => m.sequence === seq);

// ── the interleave: accepted → VERDICT → opening delivered → first poll ─────────────────────────────────────
test('#496 a verdict landing between the handoff acceptance and the opening delivery is the first thing the fresh context reads', needsBuild, (t) => {
  const home = rig(t);
  // T0: handoff accepted (nothing pending yet).  T1: the verdict lands.  T2: the host delivers the opening, frame read NOW.
  const seq = verdict(home);
  const frame = withBus(home, (db) => busFrameFor(db, COORD, RUN_ID));
  const polls = freshContextPolls(home, openingOf(frame));
  assert.ok(polls.some((p) => seen(p, seq)), `the verdict (seq ${seq}) must be in the fresh context's first poll: ${JSON.stringify(polls)}`);
  assert.match(frame, new RegExp(`^orchestra check --run ${RUN_ID}$`, 'm'), 'the opening orders the check of the run holding the verdict');
});

test('#496 a verdict landing AFTER the opening was delivered (the bench shape) is found: the opening names the real run id, and a check on the NAME no longer reads "nothing pending"', needsBuild, (t) => {
  const home = rig(t);
  const frame = withBus(home, (db) => busFrameFor(db, COORD, RUN_ID)); // opening delivered: nothing pending yet
  assert.ok(frame.includes(RUN_ID) && !/PENDING/.test(frame), frame);
  const seq = verdict(home); // 23:08:24 — after the opening, before the first poll
  // (a) the context that follows its opening reads the real run
  const good = check(home, ['--run', RUN_ID]);
  assert.ok(seen(good, seq), `the verdict must be pending in the real run: ${good.stdout}${good.stderr}`);
  // (b) the unfixed read — the NAME from the summary — must be a LOUD refusal naming the real run, never an empty success
  const bad = check(home, ['--run', RUN_NAME]);
  assert.equal(bad.code, 1, `check on a run NAME must fail (unfixed: rc 0, count 0, "nothing pending"): ${bad.stdout}`);
  assert.match(bad.stderr, /has no row in the bus 'runs' table/);
  assert.match(bad.stderr, new RegExp(RUN_NAME));
});

test('#496 a verdict that landed BEFORE the handoff and was never acked is listed in the opening (the old context ended without acting on it)', needsBuild, (t) => {
  const home = rig(t);
  const seq = verdict(home);
  // the old context took the lot (check) but its context ended before the ack: the lot is outstanding, the cursor unmoved
  assert.ok(seen(check(home, ['--run', RUN_ID]), seq));
  const frame = withBus(home, (db) => busFrameFor(db, COORD, RUN_ID));
  assert.match(frame, /PENDING/);
  assert.ok(freshContextPolls(home, openingOf(frame)).some((p) => seen(p, seq)), 'the replayed lot carries the verdict');
});

test('#496 control: a verdict acked before the handoff is NOT re-announced (the frame names the run, no pending order)', needsBuild, (t) => {
  const home = rig(t);
  const seq = verdict(home);
  const lot = JSON.parse(check(home, ['--run', RUN_ID]).stdout.split('\n')[0]) as { lot: number; messages: { sequence: number }[] };
  assert.equal(lot.messages[0].sequence, seq);
  withBus(home, (db) => assert.ok(bus.ack(db, RUN_ID, COORD, lot.lot)));
  const frame = withBus(home, (db) => busFrameFor(db, COORD, RUN_ID));
  assert.doesNotMatch(frame, /PENDING|^orchestra check --run/m);
  assert.equal(frame, composeBusFrame({ runId: RUN_ID, pendingRunIds: [] }));
});

test('#496 a plain check (own run from the env) still reads the mail — no regression', needsBuild, (t) => {
  const home = rig(t);
  const seq = verdict(home);
  assert.ok(seen(check(home, [], RUN_ID), seq));
});
