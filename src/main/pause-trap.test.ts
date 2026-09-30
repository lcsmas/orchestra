// #252 D1b — the HOST TRAP end to end over a REAL bus (migrations incl. [9]) and REAL git
// worktrees, with the session/process layer faked only where a real CLI would be needed
// (the built-app proof lives in scripts/verify-pause-trap*.mjs). Every arm names the mutant it kills.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBus, type BusDb } from './bus.ts';
import { startRun } from './bus-runs.ts';
import { setRunPause, getRunPause } from './bus-pause.ts';
import { activePauseCarriers, bilanForMember, latestPauseBilanFor, listBilan, listBilanForRun, markTrapDone } from './bus-pause-records.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';
import { snapshotWorktree } from './pause-snapshot.ts';
import {
  __resetPauseTrapForTests,
  liveChainIncludes,
  armPausedMembers,
  markPauseHumanTurn,
  onTurnStart,
  runPauseTrap,
  sweepPauseTrap,
  type InterruptOutcome,
  type TrapDeps,
  type TrapMember,
} from './pause-trap.ts';
import type { KillReport } from './pause-kill.ts';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

interface Rig {
  db: BusDb;
  root: string;
  calls: string[];
  deps: TrapDeps;
  roster: TrapMember[];
  wt: (name: string) => string;
  killReport: KillReport;
  interruptResult: InterruptOutcome;
  cliResult: { cli: { pid: number; startTicks: number }; keeperPid: number | null } | { error: string } | null;
  onSnapshot: (() => void) | null;
  onInterrupt: (() => void) | null;
  clock: number;
}

function newRig(t: { after: (fn: () => void) => void }, pauseSwitch = true): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pause-trap-'));
  const db = openBus(path.join(root, 'bus.sqlite'));
  t.after(() => {
    try {
      db.close();
    } catch {
      /* closed */
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sw = { ...DEFAULT_BUS_SWITCHES, pause: pauseSwitch };
  startRun(db, { id: 'M', kind: 'mission', coordinator: 'lead' }, sw);
  startRun(db, { id: 'W', kind: 'vague', coordinator: 'ops-w', parentRunId: 'M' }, sw);
  startRun(db, { id: 'X', kind: 'vague', coordinator: 'ops-x' }, sw); // unrelated
  const calls: string[] = [];
  const rig = {
    db,
    root,
    calls,
    roster: [] as TrapMember[],
    wt: (n: string) => path.join(root, n),
    killReport: { cliPid: 100, killed: [{ pid: 201, comm: 'sleep', cmd: 'sleep 600', startTicks: 5, signal: 'SIGTERM', via: 'chain', outcome: 'exited' }], refused: [], spared: [], survivors: [], rounds: 1 } as KillReport,
    interruptResult: 'interrupted' as InterruptOutcome,
    cliResult: { cli: { pid: 100, startTicks: 1000 }, keeperPid: 90 } as Rig['cliResult'],
    onSnapshot: null as (() => void) | null,
    onInterrupt: null as (() => void) | null,
    clock: 10_000,
  } as Rig;
  rig.deps = {
    getBus: () => db,
    now: () => rig.clock++,
    members: (runIds, carrierRunId) => {
      calls.push(`members(${[...runIds].sort().join(',')})`);
      assert.ok(typeof carrierRunId === 'string' && carrierRunId.length > 0, 'the carrier run id is passed so the host can walk the live chain');
      return rig.roster.filter((m) => runIds.includes(m.runId));
    },
    activityOf: async (m) => {
      calls.push(`activity:${m.wsId}`);
      return { surface: 'sdk', turnRunning: true, inFlightTools: [{ tool: 'Bash', toolUseId: 'tu1', sinceMs: 5000 }], bgTasks: [{ id: 'b1', type: 'shell', description: 'rig', status: 'running' }] };
    },
    interrupt: async (m) => {
      calls.push(`interrupt:${m.wsId}`);
      rig.onInterrupt?.();
      return rig.interruptResult;
    },
    cliOf: async (m) => {
      calls.push(`cliOf:${m.wsId}`);
      return rig.cliResult;
    },
    snapshot: async (input) => {
      calls.push(`snapshot:${input.wsId}`);
      rig.onSnapshot?.();
      return snapshotWorktree(input);
    },
    killTrees: async (cli, keeper) => {
      calls.push(`kill:${cli.pid}/${keeper}`);
      return rig.killReport;
    },
    sleep: async () => {},
    settleMs: 0,
  };
  return rig;
}

function makeWorktree(rig: Rig, name: string, dirty = true): string {
  const dir = rig.wt(name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  if (dirty) {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'UNCOMMITTED EDIT\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'untracked work\n');
  }
  return dir;
}

function member(rig: Rig, wsId: string, runId: string, o: Partial<TrapMember> = {}): TrapMember {
  const m: TrapMember = { wsId, runId, worktreePath: o.worktreePath ?? makeWorktree(rig, wsId), remote: false, status: 'running', lastTask: `task of ${wsId}`, ...o };
  rig.roster.push(m);
  return m;
}

function pauseW(rig: Rig, carrier = 'W', by = 'ops-w'): { runId: string; pausedAt: number; pausedBy: string | null; mode: string | null; trapAt: number | null } {
  assert.equal(setRunPause(rig.db, carrier, true, by), 'paused');
  return getRunPause(rig.db, carrier)!;
}

test('ORDER + CONTENT: snapshot → Bilan row → interrupt → kill; the ref holds the uncommitted diff; Bilan carries activity/dirty/killed', async (t) => {
  const rig = newRig(t);
  const w1 = member(rig, 'w1', 'W');
  const c = pauseW(rig);
  const s = await runPauseTrap(rig.deps, c);
  assert.deepEqual(s, { carrier: 'W', pausedAt: c.pausedAt, members: 1, done: true });
  assert.deepEqual(rig.calls.filter((x) => !x.startsWith('members')), ['activity:w1', 'snapshot:w1', 'interrupt:w1', 'cliOf:w1', 'kill:100/90']);
  const row = bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!;
  assert.ok(row.snapshotRef?.startsWith('refs/orchestra/pause/W/w1/'));
  assert.equal(row.dirty, true);
  assert.equal(row.activity?.surface, 'sdk');
  assert.equal(row.activity?.memberRun, 'W');
  assert.equal(row.activity?.interrupt, 'interrupted');
  assert.deepEqual(row.activity?.inFlightTools, [{ tool: 'Bash', toolUseId: 'tu1', sinceMs: 5000 }]);
  assert.equal(row.activity?.bgTasks?.[0].description, 'rig');
  assert.equal(row.activity?.lastTask, 'task of w1');
  assert.deepEqual(row.activity?.changed, { modified: 1, added: 1, deleted: 0 });
  assert.deepEqual((row.killed as KillReport).killed[0].cmd, 'sleep 600');
  assert.equal(row.error, null);
  // the ref holds the uncommitted work
  assert.equal(git(w1.worktreePath!, 'show', `${row.snapshotRef}:a.txt`), 'UNCOMMITTED EDIT');
  assert.equal(git(w1.worktreePath!, 'show', `${row.snapshotRef}:new.txt`), 'untracked work');
  assert.ok(getRunPause(rig.db, 'W')?.trapAt, 'pause_trap_at stamped');
});

test('liveChainIncludes: the carrier anchor is self-or-ancestor on the LIVE parent chain; a dangling parent is reported (the gate\'s fallback case)', () => {
  const ws: Record<string, { parentId?: string }> = { lead: {}, ops: { parentId: 'lead' }, w1: { parentId: 'ops' }, plain: { parentId: 'w1' }, other: { parentId: 'x' }, x: {}, loopA: { parentId: 'loopB' }, loopB: { parentId: 'loopA' }, dangling: { parentId: 'gone' } };
  const look = (id: string) => ws[id];
  const inc = (a: string, c: string) => liveChainIncludes(a, c, look);
  assert.deepEqual(inc('w1', 'ops'), { includes: true, dangling: false }, 'ancestor');
  assert.equal(inc('plain', 'lead').includes, true, 'grand-ancestor');
  assert.equal(inc('ops', 'ops').includes, true, 'self');
  assert.equal(inc('lead', 'ops').includes, false, 'a parent is NOT covered by its child run');
  assert.deepEqual(inc('other', 'ops'), { includes: false, dangling: false }, 'unrelated');
  assert.equal(inc('loopA', 'ops').includes, false, 'a cycle terminates');
  assert.deepEqual(inc('dangling', 'ops'), { includes: false, dangling: true }, 'a dangling parent is reported so the caller can fall back to the bus run tree');
  assert.deepEqual(inc('nowhere', 'ops'), { includes: false, dangling: false }, 'an unknown start is not "dangling"');
});

test('DESCENDANTS are covered: pausing the mission traps its wave run members; an unrelated run is untouched', async (t) => {
  const rig = newRig(t);
  member(rig, 'lead-ws', 'M');
  member(rig, 'w1', 'W');
  member(rig, 'x1', 'X');
  const c = pauseW(rig, 'M', 'lead'); // mission coordinator
  await runPauseTrap(rig.deps, c);
  assert.ok(rig.calls.includes('members(M,W)'), `members() must receive the subtree closure, got ${rig.calls.find((x) => x.startsWith('members'))}`);
  const rows = listBilan(rig.db, 'M', c.pausedAt).map((r) => r.wsId).sort();
  assert.deepEqual(rows, ['lead-ws', 'w1']);
  assert.ok(!rig.calls.some((x) => x.includes('x1')), 'a member of an unrelated run is never touched');
  assert.deepEqual(listBilanForRun(rig.db, 'M', 'W', c.pausedAt).map((r) => r.wsId), ['w1'], 'a descendant run sees only its own members');
});

test('the PAUSER is exempt from interrupt/kill (it keeps its turn) but is still snapshotted and recorded', async (t) => {
  const rig = newRig(t);
  member(rig, 'ops-w', 'W');
  member(rig, 'w1', 'W');
  const c = pauseW(rig, 'W', 'ops-w');
  await runPauseTrap(rig.deps, c);
  assert.ok(!rig.calls.includes('interrupt:ops-w') && !rig.calls.includes('cliOf:ops-w'), 'pauser not interrupted/killed');
  assert.ok(rig.calls.includes('interrupt:w1'));
  const row = bilanForMember(rig.db, 'W', 'ops-w', c.pausedAt)!;
  assert.equal(row.activity?.exempt, 'pauser');
  assert.equal(row.activity?.interrupt, 'exempt');
  assert.ok(row.snapshotRef, 'still snapshotted');
});

test('a snapshot FAILURE is recorded in the Bilan and the pause still takes effect (interrupt + kill run)', async (t) => {
  const rig = newRig(t);
  member(rig, 'gone', 'W', { worktreePath: '/nonexistent/worktree' });
  const c = pauseW(rig);
  const s = await runPauseTrap(rig.deps, c);
  assert.equal(s.done, true);
  const row = bilanForMember(rig.db, 'W', 'gone', c.pausedAt)!;
  assert.equal(row.snapshotRef, null);
  assert.equal(row.dirty, null);
  assert.match(row.error ?? '', /snapshot: worktree \/nonexistent\/worktree does not exist/);
  assert.ok(rig.calls.includes('interrupt:gone') && rig.calls.includes('kill:100/90'), 'a failed snapshot never blocks the pause');
});

test('an UNPROVABLE CLI identity kills nothing (fail closed) and says why in the Bilan', async (t) => {
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  rig.cliResult = { error: 'keeper-unverified' };
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  assert.ok(!rig.calls.some((x) => x.startsWith('kill:')));
  const row = bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!;
  assert.deepEqual(row.killed, { skipped: 'cli identity unprovable: keeper-unverified' });
  assert.match(row.error ?? '', /nothing killed \(fail closed\)/);
});

test('surviving tool processes are surfaced in the Bilan error (never a silent "0 killed")', async (t) => {
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  rig.killReport = { ...rig.killReport, survivors: [{ pid: 9, comm: 'x', cmd: 'x', reason: 'unreadable' }] };
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  assert.match(bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.error ?? '', /1 tool process\(es\) still alive/);
});

test('a sandbox/remote member is recorded as not applicable — no snapshot, no interrupt, no kill', async (t) => {
  const rig = newRig(t);
  member(rig, 'box', 'W', { remote: true, worktreePath: null });
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  assert.ok(!rig.calls.some((x) => /^(snapshot|interrupt|kill|cliOf)/.test(x)));
  assert.match(bilanForMember(rig.db, 'W', 'box', c.pausedAt)!.activity?.notes?.[0] ?? '', /sandbox\/remote member/);
});

test('LIFT during the trap: no process is touched after the lift, pause_trap_at is NOT stamped', async (t) => {
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  member(rig, 'w2', 'W');
  const c = pauseW(rig);
  rig.onSnapshot = () => {
    assert.equal(setRunPause(rig.db, 'W', false, 'ops-w'), 'lifted'); // resume lands while w1 is being snapshotted
  };
  const s = await runPauseTrap(rig.deps, c);
  assert.equal(s.done, false);
  assert.equal(s.aborted, 'lifted');
  assert.ok(!rig.calls.some((x) => x.startsWith('interrupt') || x.startsWith('kill')), `nothing interrupted/killed after a lift: ${rig.calls.join(' ')}`);
  assert.equal(getRunPause(rig.db, 'W'), null);
});

test('LIFT landing DURING the interrupt: the kill step never runs (the lift is re-checked after the settle pause)', async (t) => {
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  rig.onInterrupt = () => {
    assert.equal(setRunPause(rig.db, 'W', false, 'ops-w'), 'lifted');
  };
  const s = await runPauseTrap(rig.deps, c);
  assert.equal(s.done, false);
  assert.ok(rig.calls.includes('interrupt:w1'), 'the interrupt had already started');
  assert.ok(!rig.calls.some((x) => x.startsWith('kill:') || x.startsWith('cliOf:')), `no process killed after the lift: ${rig.calls.join(' ')}`);
});

test('resume + RE-PAUSE: a stale trap cannot stamp the NEW pause as done (pause_trap_at keyed on paused_at)', async (t) => {
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c1 = pauseW(rig);
  rig.onSnapshot = () => {
    setRunPause(rig.db, 'W', false, 'ops-w');
    const end = Date.now() + 5; // D1a stamps paused_at with Date.now(): guarantee a distinct ms
    while (Date.now() < end);
    setRunPause(rig.db, 'W', true, 'ops-w'); // a NEW pause, new paused_at
  };
  const s = await runPauseTrap(rig.deps, c1);
  assert.equal(s.done, false);
  assert.equal(getRunPause(rig.db, 'W')?.trapAt, null, 'the new pause still owes its trap');
});

test('markTrapDone is keyed on paused_at: a stale pause cannot stamp the NEW pause (the DB guard itself, below the stillPaused checks)', (t) => {
  const rig = newRig(t);
  const c1 = pauseW(rig);
  assert.equal(setRunPause(rig.db, 'W', false, 'ops-w'), 'lifted');
  const end = Date.now() + 5;
  while (Date.now() < end); // a distinct paused_at ms
  const c2 = pauseW(rig);
  assert.notEqual(c1.pausedAt, c2.pausedAt);
  assert.equal(markTrapDone(rig.db, 'W', c1.pausedAt, 777), false, 'the stale pause is refused');
  assert.equal(getRunPause(rig.db, 'W')?.trapAt, null);
  assert.equal(markTrapDone(rig.db, 'W', c2.pausedAt, 888), true);
  assert.equal(getRunPause(rig.db, 'W')?.trapAt, 888);
  assert.equal(markTrapDone(rig.db, 'W', c2.pausedAt, 999), false, 'stamped once');
  assert.equal(getRunPause(rig.db, 'W')?.trapAt, 888);
});

test('BOOT COMPLETION: a half-done trap (snapshot taken, kill owed) is finished without a second snapshot; a finished member is skipped', async (t) => {
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  member(rig, 'w2', 'W');
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  const firstRef = bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.snapshotRef;
  // the app died right after w1's provisional row (snapshot durable, kill result not yet written):
  const row1 = bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!;
  rig.db.prepare('UPDATE pause_records SET killed_json = NULL WHERE id = ?').run(row1.id);
  rig.db.prepare('UPDATE runs SET pause_trap_at = NULL WHERE id = ?').run('W');
  rig.calls.length = 0;
  const s = await runPauseTrap(rig.deps, getRunPause(rig.db, 'W')!);
  assert.equal(s.done, true);
  assert.ok(!rig.calls.includes('snapshot:w1'), 'w1 keeps its first snapshot (no second ref)');
  assert.equal(bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.snapshotRef, firstRef);
  assert.ok(rig.calls.includes('kill:100/90'), 'the owed kill ran');
  assert.ok(!rig.calls.includes('activity:w2'), 'w2 was already fully trapped: skipped');
  assert.equal(listBilan(rig.db, 'W', c.pausedAt).filter((r) => r.wsId === 'w1').length, 1, 'one row per member per pause');
  assert.notEqual(bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.killed, null);
});

test('SWEEP: only carriers that OWE a trap; a finished one is not redone; concurrent sweeps trap once', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  pauseW(rig);
  const [a, b] = await Promise.all([sweepPauseTrap(rig.deps), sweepPauseTrap(rig.deps)]);
  assert.equal(a.length + b.length, 1, 'two concurrent sweeps → ONE trap');
  assert.equal(rig.calls.filter((x) => x === 'snapshot:w1').length, 1);
  const again = await sweepPauseTrap(rig.deps);
  assert.deepEqual(again, [], 'trap_at is set → nothing owed');
});

test('SWITCH OFF ⇒ byte-identical to today: a run whose frozen pause switch is OFF is never trapped, no ref, no row', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t, false);
  const w1 = member(rig, 'w1', 'W');
  // a pause column written while the switch is OFF (e.g. a stale/manual write) must stay inert
  rig.db.prepare("UPDATE runs SET paused_at = 5, paused_by = 'ops-w', pause_mode = 'hard' WHERE id = 'W'").run();
  const refsBefore = git(w1.worktreePath!, 'for-each-ref');
  assert.deepEqual(await sweepPauseTrap(rig.deps), []);
  assert.deepEqual(rig.calls, []);
  assert.equal(git(w1.worktreePath!, 'for-each-ref'), refsBefore);
  assert.deepEqual(listBilan(rig.db, 'W'), []);
});

test('no bus ⇒ nothing happens, nothing throws', async (t) => {
  const rig = newRig(t);
  rig.deps.getBus = () => null;
  assert.deepEqual(await sweepPauseTrap(rig.deps), []);
  const s = await runPauseTrap(rig.deps, { runId: 'W', pausedAt: 1, pausedBy: null, mode: 'hard', trapAt: null });
  assert.equal(s.aborted, 'no-bus');
});

// ── rows 29/30 ──────────────────────────────────────────────────────────────

function tm(wsId: string, runId: string): TrapMember {
  return { wsId, runId, worktreePath: null, remote: false, status: 'running', lastTask: null };
}

test('ROW 29: a turn that starts on a paused member (CLI /loop, cron) is interrupted, its tool trees killed, and the Bilan notes it', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  rig.calls.length = 0;
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'interrupted');
  assert.deepEqual(rig.calls, ['interrupt:w1', 'cliOf:w1', 'kill:100/90']);
  const notes = bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.activity?.notes ?? [];
  assert.equal(notes.length, 1);
  assert.match(notes[0], /turn started while paused.*interrupt=interrupted, 1 tool process/);
});

test('ROW 29: a member whose own run id is NOT under the carrier but whose LIVE parent chain is (re-parented after its run row) is still trapped', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  rig.calls.length = 0;
  const reparented: TrapMember = { ...tm('w9', 'X'), chain: ['w9', 'W', 'M'] }; // own run X (unrelated), chain climbs to the paused run W
  assert.equal(await onTurnStart(rig.deps, reparented), 'interrupted');
  assert.deepEqual(rig.calls, ['interrupt:w9', 'cliOf:w9', 'kill:100/90']);
  rig.clock += 2000;
  assert.equal(await onTurnStart(rig.deps, { ...tm('w8', 'X'), chain: ['w8', 'X'] }), 'not-paused', 'a chain that never reaches the carrier stays inert');
});

test('ROW 29: the injected carrierFor (production: the gate\'s own live-tree decision) overrides the bus-level walk — observer and gate cannot disagree', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  rig.calls.length = 0;
  rig.deps.carrierFor = () => null; // the gate says NOT paused for this member
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'not-paused', 'no interrupt when the gate allows the start');
  assert.deepEqual(rig.calls, []);
  rig.deps.carrierFor = () => getRunPause(rig.db, 'W');
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'interrupted');
});

test('ROW 29 control: a turn start on a NON-paused run is left alone (the observer is inert off the pause)', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  assert.equal(await onTurnStart(rig.deps, tm('x1', 'X')), 'not-paused');
  assert.deepEqual(rig.calls, []);
});

test('HUMAN prompt is ALLOWED while paused and un-pauses nothing (ledger D5 row 1); the mark is single-use', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  rig.calls.length = 0;
  markPauseHumanTurn('w1', rig.clock);
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'allowed');
  assert.deepEqual(rig.calls, []);
  assert.notEqual(getRunPause(rig.db, 'W'), null, 'the human prompt did not lift the pause');
  rig.clock += 2000; // past the burst guard
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'interrupted', 'the mark was consumed: the NEXT unmarked start is trapped');
});

test('a stale human mark (older than its TTL) does not whitelist a later CLI-internal start', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  markPauseHumanTurn('w1', rig.clock - 120_000);
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'interrupted');
});

test('the pauser is spared only the PAUSE-TIME interrupt/kill: a CLI-started turn on it is a new turn and IS trapped', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  const c = pauseW(rig, 'W', 'ops-w');
  void c;
  assert.equal(await onTurnStart(rig.deps, tm('ops-w', 'W')), 'interrupted');
  assert.deepEqual(rig.calls, ['interrupt:ops-w', 'cliOf:ops-w', 'kill:100/90']);
});

test('a burst of turn starts is COALESCED, not dropped: a start that lands while the handler runs re-runs it once; one Bilan note per second', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  rig.calls.length = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const origInterrupt = rig.deps.interrupt;
  let n = 0;
  rig.deps.interrupt = async (m) => {
    n++;
    if (n === 1) await gate; // the first handler is busy when the second start arrives
    return origInterrupt(m);
  };
  const first = onTurnStart(rig.deps, tm('w1', 'W'));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'skipped', 'the concurrent start is noted, not run in parallel');
  release();
  assert.equal(await first, 'interrupted');
  assert.equal(rig.calls.filter((x) => x === 'interrupt:w1').length, 2, 'the handler re-ran once for the start that landed meanwhile (its tools are killed too)');
  assert.equal(rig.calls.filter((x) => x === 'kill:100/90').length, 2);
  assert.equal((bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.activity?.notes ?? []).length, 1, 'one note per burst');
});

test('arm: every member\'s idle keeper is re-armed at pause time (exempt pauser too) and for every ACTIVE pause even when nothing is owed (app restarted after the trap)', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'ops-w', 'W');
  member(rig, 'w1', 'W');
  const armed: string[] = [];
  rig.deps.arm = async (m) => {
    armed.push(m.wsId);
  };
  const c = pauseW(rig, 'W', 'ops-w');
  await runPauseTrap(rig.deps, c);
  assert.deepEqual([...armed].sort(), ['ops-w', 'w1'], 'both armed during the trap, the exempt pauser included');
  assert.ok(rig.calls.indexOf('activity:w1') < rig.calls.indexOf('interrupt:w1'));
  armed.length = 0;
  assert.notEqual(getRunPause(rig.db, 'W')?.trapAt, null, 'the trap is finished: nothing is owed');
  assert.equal(await armPausedMembers(rig.deps), 2);
  assert.deepEqual([...armed].sort(), ['ops-w', 'w1'], 'an active pause is re-armed on every pass, finished trap or not');
  assert.equal(setRunPause(rig.db, 'W', false, 'ops-w'), 'lifted');
  armed.length = 0;
  assert.equal(await armPausedMembers(rig.deps), 0);
  assert.deepEqual(armed, [], 'nothing is armed once the pause is lifted');
});

test('activePauseCarriers honours the FROZEN switch: a pause column on a run whose pause switch is OFF is not active', (t) => {
  const rig = newRig(t, false);
  rig.db.prepare("UPDATE runs SET paused_at = 5, paused_by = 'ops-w', pause_mode = 'hard' WHERE id = 'W'").run();
  assert.deepEqual(activePauseCarriers(rig.db), []);
  const on = newRig(t, true);
  pauseW(on);
  assert.deepEqual(activePauseCarriers(on.db).map((x) => x.runId), ['W']);
});

test('latestPauseBilanFor: the Bilan stays readable AFTER the lift (pause_records history outlives run resume); the newest pause wins; scope is the asking run', async (t) => {
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c1 = pauseW(rig);
  await runPauseTrap(rig.deps, c1);
  assert.equal(setRunPause(rig.db, 'W', false, 'ops-w'), 'lifted');
  const end = Date.now() + 5;
  while (Date.now() < end);
  rig.roster.length = 0;
  member(rig, 'w2', 'W');
  const c2 = pauseW(rig);
  await runPauseTrap(rig.deps, c2);
  assert.equal(setRunPause(rig.db, 'W', false, 'ops-w'), 'lifted');
  const last = latestPauseBilanFor(rig.db, 'W');
  assert.equal(last?.pausedAt, c2.pausedAt, 'the newest pause');
  assert.deepEqual(last?.rows.map((r) => r.wsId), ['w2']);
  assert.equal(latestPauseBilanFor(rig.db, 'X'), null, 'a run with no members in any pause sees none');
});

test('arm failure is recorded in the Bilan and never blocks the interrupt/kill', async (t) => {
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  rig.deps.arm = async () => {
    throw new Error('attach refused');
  };
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  assert.match(bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.error ?? '', /arm: attach refused/);
  assert.ok(rig.calls.includes('interrupt:w1') && rig.calls.includes('kill:100/90'));
});

test('members are trapped in PARALLEL (bounded by deps.concurrency): a slow snapshot of one worktree does not delay the interrupt of the rest', async (t) => {
  const rig = newRig(t);
  for (const id of ['a', 'b', 'c', 'd']) member(rig, id, 'W');
  const c = pauseW(rig);
  let cur = 0;
  let max = 0;
  const origSnap = rig.deps.snapshot;
  rig.deps.snapshot = async (input) => {
    cur++;
    max = Math.max(max, cur);
    await new Promise((r) => setTimeout(r, 30));
    try {
      return await origSnap(input);
    } finally {
      cur--;
    }
  };
  rig.deps.concurrency = 2;
  const s = await runPauseTrap(rig.deps, c);
  assert.equal(s.done, true);
  assert.equal(max, 2, 'two at a time, never more than the bound');
  assert.equal(listBilan(rig.db, 'W', c.pausedAt).length, 4);
});

