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
import { setRunPause, getRunPause, beginReprise, pausedCarrierForWorkspace, runsOwingPauseTrap } from './bus-pause.ts';
import { releaseMembers } from './pause-reprise.ts';
import { activePauseCarriers, appendObserverKills, bilanForMember, latestPauseBilanFor, listBilan, listBilanForRun, markTrapDone, recordPauseOrigin } from './bus-pause-records.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';
import { snapshotWorktree, SnapshotTimeoutError } from './pause-snapshot.ts';
import { log } from './logger.ts';
import {
  __resetPauseTrapForTests,
  liveChainIncludes,
  armPausedMembers,
  lastHumanTurnStart,
  markPauseHumanTurn,
  markPauseHumanTurnEnd,
  humanWindowsSince,
  PAUSE_RETRY_MS,
  PAUSE_RETRY_MAX_MS,
  MAX_INTERRUPT_DEFERRALS,
  pauseRetryDelay,
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
  killOpts: Array<{ stillPaused?: () => boolean; startedBeforeMs?: number | (() => number | undefined); spareRoots?: readonly number[]; stopTask?: (taskId: string) => Promise<{ ok: boolean; note?: string }> } | undefined>;
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
    killReport: { cliPid: 100, cli: { pid: 100, startTicks: 1000 }, killed: [{ pid: 201, comm: 'sleep', cmd: 'sleep 600', startTicks: 5, cwd: '/w', evidence: 'test', signal: 'SIGTERM', via: 'chain', outcome: 'exited' }], refused: [], spared: [], survivors: [], rounds: 1 } as KillReport,
    interruptResult: 'interrupted' as InterruptOutcome,
    cliResult: { cli: { pid: 100, startTicks: 1000 }, keeperPid: 90 } as Rig['cliResult'],
    killOpts: [] as Rig['killOpts'],
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
    killTrees: async (cli, keeper, opts) => {
      calls.push(`kill:${cli.pid}/${keeper}`);
      rig.killOpts.push(opts);
      return rig.killReport;
    },
    sleep: async () => {},
    settleMs: 0,
    originWaitMs: 0,
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

test('ORDER + CONTENT: snapshot → Bilan row → CLI identity → interrupt → kill; the ref holds the uncommitted diff; Bilan carries activity/dirty/killed', async (t) => {
  const rig = newRig(t);
  const w1 = member(rig, 'w1', 'W');
  const c = pauseW(rig);
  const s = await runPauseTrap(rig.deps, c);
  assert.deepEqual(s, { carrier: 'W', pausedAt: c.pausedAt, members: 1, done: true });
  assert.deepEqual(rig.calls.filter((x) => !x.startsWith('members')), ['activity:w1', 'snapshot:w1', 'cliOf:w1', 'interrupt:w1', 'kill:100/90']);
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

/** The chain the CLI records for a `run pause` typed INSIDE ops-w's tool: … zsh (tool shell, pid 200) ← claude CLI (pid 100, start 1000). */
const CHAIN_FROM_TOOL = [
  { pid: 300, ppid: 250, startTicks: 3000, comm: 'orchestra' },
  { pid: 250, ppid: 200, startTicks: 2500, comm: 'bash' },
  { pid: 200, ppid: 100, startTicks: 2000, comm: 'zsh' },
  { pid: 100, ppid: 90, startTicks: 1000, comm: 'claude' },
  { pid: 90, ppid: 1, startTicks: 900, comm: 'node' },
];

test('F5 the PAUSER = the member whose CLI is a process ANCESTOR of the `run pause` call: its turn is NOT interrupted, ONLY the tool tree holding the call is spared (spareRoots), its snapshot + Bilan are still written', async (t) => {
  const rig = newRig(t);
  member(rig, 'ops-w', 'W');
  const c = pauseW(rig, 'W', 'ops-w');
  recordPauseOrigin(rig.db, 'W', c.pausedAt, CHAIN_FROM_TOOL);
  await runPauseTrap(rig.deps, c);
  assert.ok(!rig.calls.includes('interrupt:ops-w'), 'the pauser\'s turn is not interrupted');
  assert.ok(rig.calls.includes('kill:100/90'), 'its OTHER tool trees are still killed');
  assert.deepEqual(rig.killOpts[0]?.spareRoots, [200], 'exactly the tool shell that holds the call is spared');
  const row = bilanForMember(rig.db, 'W', 'ops-w', c.pausedAt)!;
  assert.equal(row.activity?.exempt, 'pauser');
  assert.equal(row.activity?.interrupt, 'exempt');
  assert.ok(row.snapshotRef, 'still snapshotted');
  assert.ok(listBilan(rig.db, 'W', c.pausedAt).every((r) => r.wsId !== '__pause_origin__'), 'the origin row is never listed as a member');
});

test('F5 a pause typed by a HUMAN `--as <coordinator>` in a plain shell exempts NOBODY: the handle is not identity (the coordinator is interrupted and its tools killed)', async (t) => {
  const rig = newRig(t);
  member(rig, 'ops-w', 'W');
  const c = pauseW(rig, 'W', 'ops-w'); // paused_by = the coordinator's handle, exactly like a human's --as
  recordPauseOrigin(rig.db, 'W', c.pausedAt, [{ pid: 5000, ppid: 4000, startTicks: 7000, comm: 'orchestra' }, { pid: 4000, ppid: 1, startTicks: 6900, comm: 'bash' }]); // plain shell: no member CLI in the chain
  await runPauseTrap(rig.deps, c);
  assert.ok(rig.calls.includes('interrupt:ops-w') && rig.calls.includes('kill:100/90'));
  assert.equal(rig.killOpts[0]?.spareRoots, undefined);
  assert.equal(bilanForMember(rig.db, 'W', 'ops-w', c.pausedAt)!.activity?.exempt, undefined);
});

test('F5 a RECYCLED CLI pid in the recorded chain (start-time differs) or no recorded origin ⇒ nobody is exempt (fail-closed on the spare side)', async (t) => {
  const stale = newRig(t);
  member(stale, 'ops-w', 'W');
  const c1 = pauseW(stale, 'W', 'ops-w');
  recordPauseOrigin(stale.db, 'W', c1.pausedAt, CHAIN_FROM_TOOL.map((p) => (p.pid === 100 ? { ...p, startTicks: 999 } : p)));
  await runPauseTrap(stale.deps, c1);
  assert.ok(stale.calls.includes('interrupt:ops-w'), 'the chain names pid 100 but with another start-time: not this CLI');
  const none = newRig(t);
  member(none, 'ops-w', 'W');
  const c2 = pauseW(none, 'W', 'ops-w');
  await runPauseTrap(none.deps, c2);
  assert.ok(none.calls.includes('interrupt:ops-w'), 'no recorded origin: nobody spared');
});

test('F5 a RECENT pause waits for the CLI to record its origin (it lands within ms of the pause), then honours it', async (t) => {
  const rig = newRig(t);
  member(rig, 'ops-w', 'W');
  rig.deps.originWaitMs = 3000;
  const c = pauseW(rig, 'W', 'ops-w');
  let polls = 0;
  rig.deps.sleep = async () => {
    if (++polls === 3) recordPauseOrigin(rig.db, 'W', c.pausedAt, CHAIN_FROM_TOOL); // the CLI writes it a moment later
  };
  rig.deps.now = () => rig.clock++; // pausedAt is real Date.now() ≫ rig.clock: the "recent" branch is the polling loop below
  await runPauseTrap(rig.deps, c);
  assert.ok(polls >= 3, 'polled');
  assert.ok(!rig.calls.includes('interrupt:ops-w'), 'and exempted once the origin appeared');
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

test('F4 UNKNOWN is not NONE: an unprovable/unresponsive CLI is an ERROR — nothing killed, the trap is NOT stamped done and is RETRIED; the member row keeps killed=NULL', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  rig.cliResult = { error: 'keeper alive but did not answer the probe (busy)' };
  const c = pauseW(rig);
  const s = await runPauseTrap(rig.deps, c);
  assert.equal(s.done, false);
  assert.equal(s.incomplete, 1);
  assert.ok(!rig.calls.some((x) => x.startsWith('kill:')));
  assert.equal(getRunPause(rig.db, 'W')?.trapAt, null, 'NOT stamped done');
  const row = bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!;
  assert.equal(row.killed, null, 'still owed');
  assert.match(row.error ?? '', /did not answer the probe.*fail closed.*retried/);
  assert.ok(row.snapshotRef, 'the snapshot was taken once');
  // the keeper answers again: the next attempt redoes interrupt + kill (NOT the snapshot) and stamps
  rig.cliResult = { cli: { pid: 100, startTicks: 1000 }, keeperPid: 90 };
  rig.calls.length = 0;
  const s2 = await runPauseTrap(rig.deps, getRunPause(rig.db, 'W')!);
  assert.equal(s2.done, true);
  assert.ok(!rig.calls.includes('snapshot:w1'), 'no second snapshot');
  assert.ok(rig.calls.includes('interrupt:w1') && rig.calls.includes('kill:100/90'));
  assert.ok(getRunPause(rig.db, 'W')?.trapAt);
});

test('F4 a RETRY keeps the previous attempt\'s error visible until its own final write (run status never flips to "no error" mid-retry)', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  rig.cliResult = { error: 'keeper unresponsive' };
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  assert.match(bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.error ?? '', /keeper unresponsive/);
  let seenDuringRetry: string | null | undefined;
  rig.deps.cliOf = async () => {
    seenDuringRetry = bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.error; // the row as a reader sees it while the retry is mid-flight
    return { error: 'still unresponsive' };
  };
  await runPauseTrap(rig.deps, getRunPause(rig.db, 'W')!);
  assert.match(seenDuringRetry ?? '', /keeper unresponsive/, 'the previous error is still there mid-retry');
  assert.match(bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.error ?? '', /still unresponsive/, 'and the retry\'s own result replaces it');
});

test('F4 a FAILED / UNRESPONSIVE interrupt keeps the trap open too (the turn may still be running)', async (t) => {
  for (const outcome of ['failed', 'unresponsive'] as const) {
    const rig = newRig(t);
    member(rig, 'w1', 'W');
    rig.interruptResult = outcome;
    const c = pauseW(rig);
    const s = await runPauseTrap(rig.deps, c);
    assert.equal(s.done, false, outcome);
    assert.equal(getRunPause(rig.db, 'W')?.trapAt, null, outcome);
    assert.match(bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.error ?? '', new RegExp(`interrupt: ${outcome}`));
  }
  const thrown = newRig(t);
  member(thrown, 'w1', 'W');
  thrown.deps.interrupt = async () => {
    throw new Error('sdk interrupt timed out after 10000 ms');
  };
  const c2 = pauseW(thrown);
  assert.equal((await runPauseTrap(thrown.deps, c2)).done, false);
});

test('F4 the sweep RETRIES an incomplete trap, but not faster than PAUSE_RETRY_MS (an unresponsive keeper is not hammered on every bus write)', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  rig.cliResult = { error: 'unresponsive' };
  pauseW(rig);
  assert.equal((await sweepPauseTrap(rig.deps))[0].done, false);
  rig.calls.length = 0;
  assert.deepEqual(await sweepPauseTrap(rig.deps), [], 'inside the backoff: not retried');
  rig.cliResult = { cli: { pid: 100, startTicks: 1000 }, keeperPid: 90 };
  rig.clock += PAUSE_RETRY_MS + 1;
  const again = await sweepPauseTrap(rig.deps);
  assert.equal(again[0]?.done, true, 'after the backoff it is retried and completes');
});

test('F10 ZERO members (an unloaded/empty store) never stamps the trap done; a store that is not ready defers it; both are retried', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  const c = pauseW(rig); // the roster is empty
  const s = await runPauseTrap(rig.deps, c);
  assert.deepEqual([s.done, s.aborted], [false, 'no-members']);
  assert.equal(getRunPause(rig.db, 'W')?.trapAt, null);
  member(rig, 'w1', 'W');
  rig.deps.storeReady = () => false;
  const s2 = await runPauseTrap(rig.deps, c);
  assert.deepEqual([s2.done, s2.aborted], [false, 'store-not-ready']);
  assert.ok(!rig.calls.some((x) => x.startsWith('snapshot')), 'nothing touched while the store is unknown');
  rig.deps.storeReady = () => true;
  assert.equal((await runPauseTrap(rig.deps, c)).done, true);
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
  assert.ok(!rig.calls.some((x) => x.startsWith('kill:')), `no process killed after the lift: ${rig.calls.join(' ')}`);
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

test('ROW 29: what the turn observer KILLS is recorded on the Bilan (activity.observerKilled) WITHOUT marking the member\'s trap complete (killed_json stays NULL)', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  const c = pauseW(rig);
  rig.killReport = { ...rig.killReport, killed: [{ pid: 77, comm: 'sleep', cmd: 'sleep 7718', startTicks: 9, cwd: '/w', evidence: 'test', signal: 'SIGTERM', via: 'env', outcome: 'exited' }] };
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'interrupted');
  const row = bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!;
  assert.deepEqual(row.activity?.observerKilled?.map((k) => k.cmd), ['sleep 7718']);
  assert.deepEqual(row.activity?.observerKilled?.map((k) => [k.via, k.cwd, k.evidence]), [['env', '/w', 'test']], 'D11: via, cwd and the evidence survive into the Bilan');
  assert.equal(row.killed, null, 'the pause-time trap of this member is still OWED (an observer row must not mask it)');
  // and the trap that runs afterwards still snapshots this member and keeps the observer's record
  member(rig, 'w1', 'W');
  await runPauseTrap(rig.deps, c);
  const done = bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!;
  assert.ok(done.snapshotRef, 'the member was trapped after all');
  assert.deepEqual(done.activity?.observerKilled?.map((k) => k.cmd), ['sleep 7718'], 'the observer\'s kills survive the final Bilan write');
  assert.notEqual(done.killed, null);
});

test('ROW 29: an observer kill landing DURING the trap\'s own kill step survives the final Bilan write (the final write merges a fresh read)', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  const origKill = rig.deps.killTrees;
  rig.deps.killTrees = async (cli, keeper) => {
    appendObserverKills(rig.db, 'W', 'w1', c.pausedAt, [{ pid: 88, cmd: 'sleep 7717', signal: 'SIGKILL', outcome: 'exited' }]);
    return origKill(cli, keeper);
  };
  await runPauseTrap(rig.deps, c);
  assert.deepEqual(bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.activity?.observerKilled?.map((k) => k.cmd), ['sleep 7717']);
});

test('F8 the turn observer stops when the pause is lifted between its rounds and hands the killer a stillPaused check', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  rig.calls.length = 0;
  rig.killOpts.length = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const origInterrupt = rig.deps.interrupt;
  let n = 0;
  rig.deps.interrupt = async (m) => {
    n++;
    if (n === 1) await gate;
    return origInterrupt(m);
  };
  const first = onTurnStart(rig.deps, tm('w1', 'W'));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'skipped'); // a start lands meanwhile: a second round is owed
  assert.equal(setRunPause(rig.db, 'W', false, 'ops-w'), 'lifted'); // …but the pause is lifted before it can run
  release();
  await first;
  assert.equal(rig.calls.filter((x) => x === 'interrupt:w1').length, 1, 'no second round after the lift');
  assert.equal(typeof rig.killOpts[0]?.stillPaused, 'function');
  assert.equal(rig.killOpts[0]!.stillPaused!(), false, 'the killer is told the pause is gone');
});

test('ROW 29 control: a turn start on a NON-paused run is left alone (the observer is inert off the pause)', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  assert.equal(await onTurnStart(rig.deps, tm('x1', 'X')), 'not-paused');
  assert.deepEqual(rig.calls, []);
});

test('HUMAN prompt is ALLOWED while paused and un-pauses nothing (ledger D5 row 1); the mark is single-use and is set at the turn START', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  rig.calls.length = 0;
  rig.clock = c.pausedAt + 10; // the human's turn starts AFTER the pause (a mark from before it admits nothing — pre-review M4)
  markPauseHumanTurn('w1', rig.clock);
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'allowed');
  assert.deepEqual(rig.calls, []);
  assert.notEqual(getRunPause(rig.db, 'W'), null, 'the human prompt did not lift the pause');
  rig.clock += 2000;
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'interrupted', 'the mark was consumed: the NEXT unmarked start is trapped');
});

test('F2 a human prompt PARKED for over 10 s behind a running turn, and a SECOND human prompt typed during turn 1, are each allowed: one mark per turn START (not per enqueue, no timed slot)', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  rig.calls.length = 0;
  rig.clock = c.pausedAt + 10;
  // turn 1 (human) starts; promptStream marks it at its yield, the submit hook fires 1 s later
  markPauseHumanTurn('w1', rig.clock);
  rig.clock += 1_000;
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'allowed');
  // a 30 s turn runs; a second human prompt sits parked behind it and is yielded only when turn 1 ends: marked THEN
  rig.clock += 40_000;
  markPauseHumanTurn('w1', rig.clock);
  rig.clock += 1_000;
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'allowed', 'the parked prompt starts 40 s after its enqueue: still allowed');
  // two human turns yielded back to back, hooks arrive later: two marks, two allows
  markPauseHumanTurn('w1', rig.clock);
  markPauseHumanTurn('w1', rig.clock + 1);
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'allowed');
  rig.clock += 2_000;
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'allowed');
  rig.clock += 2_000;
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'interrupted', 'marks are exhausted: a CLI-started turn is still trapped');
  assert.deepEqual(rig.calls.filter((x) => x.startsWith('interrupt')), ['interrupt:w1']);
});

test('F2 a HUMAN turn that STARTS during the trap window is not interrupted; its tools are not killed (only processes older than it are)', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  rig.onSnapshot = () => markPauseHumanTurn('w1', c.pausedAt + 5); // the human's prompt is yielded while the snapshot runs
  await runPauseTrap(rig.deps, c);
  assert.ok(lastHumanTurnStart('w1')! >= c.pausedAt);
  assert.ok(!rig.calls.includes('interrupt:w1'), 'the human turn is allowed: no interrupt');
  const hw = rig.killOpts[0]?.humanWindows;
  assert.equal(typeof hw, 'function', 'the kill re-reads the human-turn windows at EVERY signal (pre-review M5)');
  const wins = (hw as () => Array<{ from: number; to?: number }>)();
  assert.equal(wins.length, 1, 'the kill shields the tool roots the human turn started');
  assert.ok(wins[0].from >= c.pausedAt && wins[0].to === undefined, 'a window opened at the human turn\'s start, still open');
  const row = bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!;
  assert.equal(row.activity?.interrupt, 'skipped');
  assert.match((row.activity?.notes ?? []).join(' '), /HUMAN prompt started a turn during the trap/);
});

test('F2 control: a human mark from BEFORE the trap began does not suppress the interrupt', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  markPauseHumanTurn('w1', rig.clock - 50);
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  assert.ok(rig.calls.includes('interrupt:w1'));
  assert.deepEqual(rig.killOpts[0]?.humanWindows?.(), [], 'no human turn during the trap: every process is a target');
});

test('a stale human mark (older than its TTL) does not whitelist a later CLI-internal start', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  markPauseHumanTurn('w1', c.pausedAt + 1);
  rig.clock = c.pausedAt + 120_000; // far past the 30 s TTL
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'interrupted');
});

test('the pauser is spared only the PAUSE-TIME interrupt/kill: a CLI-started turn on it is a new turn and IS trapped', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'ops-w', 'W');
  const c = pauseW(rig, 'W', 'ops-w');
  recordPauseOrigin(rig.db, 'W', c.pausedAt, CHAIN_FROM_TOOL);
  await runPauseTrap(rig.deps, c);
  assert.equal(bilanForMember(rig.db, 'W', 'ops-w', c.pausedAt)!.activity?.exempt, 'pauser', 'control: the member IS the pauser (by ancestry) and was spared the pause-time interrupt');
  assert.ok(!rig.calls.includes('interrupt:ops-w'));
  rig.calls.length = 0;
  rig.clock = c.pausedAt + 50;
  assert.equal(await onTurnStart(rig.deps, tm('ops-w', 'W')), 'interrupted');
  assert.deepEqual(rig.calls, ['interrupt:ops-w', 'cliOf:ops-w', 'kill:100/90'], 'a CLI-started turn on the pauser is a NEW turn: interrupted and its trees killed');
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


// ── pre-review round 2 (M3 M4 M5 M7 M8 M9) ──

test('M3 a RETRY keeps the FIRST attempt\'s observations (was-doing, snapshot facts, interrupt) — a fresh read after the interrupt says "idle" and must not overwrite them', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const okKill = rig.deps.killTrees;
  rig.deps.killTrees = async () => { throw new Error('kill boom'); }; // attempt 1: incomplete AFTER the interrupt ran (snapshot + activity + interrupt happen)
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  const first = bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!;
  assert.equal(first.activity?.turnRunning, true);
  assert.equal(first.activity?.interrupt, 'interrupted', 'control: attempt 1 interrupted');
  assert.ok(first.activity?.head && first.activity?.changed, 'control: attempt 1 recorded the snapshot facts');
  // attempt 2: everything answers, the turn is long idle now
  rig.deps.killTrees = okKill;
  rig.deps.activityOf = async () => ({ surface: 'sdk', turnRunning: false, inFlightTools: [], bgTasks: [] });
  rig.interruptResult = 'idle';
  await runPauseTrap(rig.deps, getRunPause(rig.db, 'W')!);
  const row = bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!;
  assert.equal(row.activity?.turnRunning, true, 'the pre-interrupt "was doing" survives the retry');
  assert.equal(row.activity?.inFlightTools?.length, 1);
  assert.equal(row.activity?.bgTasks?.length, 1);
  assert.equal(row.activity?.head, first.activity?.head);
  assert.deepEqual(row.activity?.changed, first.activity?.changed);
  assert.equal(row.activity?.interrupt, 'interrupted', 'an interrupt that really happened is not rewritten to "idle"');
  assert.notEqual(row.killed, null, 'and the retry completed the member');
});

test('M7 a LIFT landing while the trap arms / probes the CLI: NOTHING is interrupted or killed (re-checked right before the interrupt)', async (t) => {
  for (const where of ['arm', 'cliOf'] as const) {
    __resetPauseTrapForTests();
    const rig = newRig(t);
    member(rig, 'w1', 'W');
    const c = pauseW(rig);
    const lift = () => assert.equal(setRunPause(rig.db, 'W', false, 'ops-w'), 'lifted');
    if (where === 'arm') rig.deps.arm = async () => lift();
    else rig.deps.cliOf = async () => { lift(); return rig.cliResult; };
    const s = await runPauseTrap(rig.deps, c);
    assert.equal(s.aborted, 'lifted', where);
    assert.ok(!rig.calls.some((x) => x.startsWith('interrupt') || x.startsWith('kill')), `lift during ${where}: ${rig.calls.join(' ')}`);
  }
});

test('M7 a lift DURING the kill step still records what WAS killed (D11: every killed process is listed), never drops the report', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  rig.deps.killTrees = async () => {
    setRunPause(rig.db, 'W', false, 'ops-w');
    return { ...rig.killReport, aborted: 'lifted' as const };
  };
  const s = await runPauseTrap(rig.deps, c);
  assert.equal(s.aborted, 'lifted');
  const row = bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!;
  assert.equal((row.killed as { killed: unknown[] } | null)?.killed.length, 1, 'the round-1 kills are on the Bilan');
});

test('M4 a human mark from BEFORE the pause never admits a CLI-started turn after it (a cron turn right after the trap killed a background task)', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  markPauseHumanTurn('w1', c.pausedAt - 5); // a human turn that started 5 ms BEFORE the pause, mark still inside its 30 s TTL
  rig.clock = c.pausedAt + 50;
  rig.calls.length = 0;
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'interrupted');
  assert.ok(rig.calls.includes('interrupt:w1'));
});

test('M5 a human turn that started AFTER the pause but BEFORE this member\'s trap began (queued behind other members) is not interrupted — the window is anchored on the PAUSE', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  markPauseHumanTurn('w1', c.pausedAt + 5);
  rig.clock = c.pausedAt + 1000; // the member's trap only begins a second after the pause
  await runPauseTrap(rig.deps, c);
  assert.ok(!rig.calls.includes('interrupt:w1'), 'the allowed human turn is not interrupted');
  assert.equal(bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.activity?.interrupt, 'skipped');
});

test('M9 the turn start fired by THIS trap\'s own arm() attach is ignored by the observer: the trap handles the member itself — pauser-aware (a boot-drain pauser is not interrupted by the attach)', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'ops-w', 'W');
  const c = pauseW(rig, 'W', 'ops-w');
  recordPauseOrigin(rig.db, 'W', c.pausedAt, CHAIN_FROM_TOOL);
  let fromArm: string | null = null;
  rig.deps.arm = async (m) => { fromArm = await onTurnStart(rig.deps, m); }; // attach of a detached keeper mid-turn → notifyTurnStart
  await runPauseTrap(rig.deps, c);
  assert.equal(fromArm, 'skipped', 'the observer stood down for the trap\'s own attach');
  assert.ok(!rig.calls.includes('interrupt:ops-w'), 'the pauser (by ancestry) keeps its turn');
  // control: outside an arm window the same start IS trapped
  rig.calls.length = 0;
  rig.clock = c.pausedAt + 50;
  assert.equal(await onTurnStart(rig.deps, tm('ops-w', 'W')), 'interrupted');
});

test('M8 a HUNG arm() cannot stall the member: the deadline turns it into an error, the trap stays OPEN (not stamped) and is retried; a REJECTED arm still does not block', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  rig.deps.armTimeoutMs = 20;
  rig.deps.arm = () => new Promise<void>(() => {}); // never settles
  const c = pauseW(rig);
  const s = await runPauseTrap(rig.deps, c);
  assert.equal(s.done, false);
  assert.equal(s.incomplete, 1);
  const row = bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!;
  assert.match(row.error ?? '', /arm timed out after 20 ms/);
  assert.equal(row.killed, null, 'the member stays owed');
  assert.ok(rig.calls.includes('interrupt:w1'), 'the interrupt/kill still ran');
});

test('round-2 F2 a flaking keeper probe (cliOf error) on attempt 1 NEVER interrupts the pauser: the interrupt waits for a proven CLI; the pauser is then recognised and still never interrupted', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'ops-w', 'W');
  const c = pauseW(rig, 'W', 'ops-w');
  recordPauseOrigin(rig.db, 'W', c.pausedAt, CHAIN_FROM_TOOL);
  rig.cliResult = { error: 'keeper alive but did not answer the probe' };
  const s1 = await runPauseTrap(rig.deps, c);
  assert.equal(s1.done, false, 'attempt 1 is incomplete');
  assert.ok(!rig.calls.includes('interrupt:ops-w'), 'the probe flake did NOT interrupt the pauser');
  assert.equal(bilanForMember(rig.db, 'W', 'ops-w', c.pausedAt)!.activity?.interrupt, 'skipped');
  rig.cliResult = { cli: { pid: 100, startTicks: 1000 }, keeperPid: 90 };
  await runPauseTrap(rig.deps, getRunPause(rig.db, 'W')!);
  assert.ok(!rig.calls.includes('interrupt:ops-w'), 'attempt 2 recognises the pauser (exempt) — never interrupted');
  assert.equal(bilanForMember(rig.db, 'W', 'ops-w', c.pausedAt)!.activity?.exempt, 'pauser');
});

test('round-2 F2 control: a NON-pauser whose probe flaked on attempt 1 is interrupted on the retry (the deferral is not a hole)', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  rig.cliResult = { error: 'keeper unresponsive' };
  await runPauseTrap(rig.deps, c);
  assert.ok(!rig.calls.includes('interrupt:w1'));
  rig.cliResult = { cli: { pid: 100, startTicks: 1000 }, keeperPid: 90 };
  await runPauseTrap(rig.deps, getRunPause(rig.db, 'W')!);
  assert.ok(rig.calls.includes('interrupt:w1') && rig.calls.includes('kill:100/90'));
});

test('round-2 F3 a HUMAN turn in flight is allowed however LATE its hook lands (60 s after the send — a cold-started paused member): exact discriminator, no timer; a CLI-started turn is still trapped', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  rig.calls.length = 0;
  markPauseHumanTurn('w1', c.pausedAt + 1);
  rig.clock = c.pausedAt + 60_000; // the mark is long expired (30 s TTL)
  let human = true;
  rig.deps.humanTurnInFlight = () => human;
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'allowed', 'the human turn is in flight: allowed at +60 s');
  assert.deepEqual(rig.calls, []);
  human = false; // control: no human turn in flight, the (consumed) mark is gone ⇒ a CLI-started turn is trapped
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'interrupted');
});

test('round-2 F3 an exact-allowed start also CONSUMES the fresh mark (a leftover mark must not admit a later CLI-started turn)', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  markPauseHumanTurn('w1', c.pausedAt + 1);
  rig.clock = c.pausedAt + 5; // mark still fresh
  let human = true;
  rig.deps.humanTurnInFlight = () => human;
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'allowed');
  human = false;
  rig.clock = c.pausedAt + 50;
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'interrupted', 'the mark was consumed with the exact allow');
});

test('pre-review r2 #1: a human turn yielded BEFORE the pause whose hook lands late is still TRAPPED — the exact human allow is anchored on the pause (it was in flight when the pause landed)', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  markPauseHumanTurn('w1', Date.now() - 2_000); // yielded 2 s before the pause (real clock: pausedAt is real)
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  rig.calls.length = 0;
  rig.clock = c.pausedAt + 40_000;
  rig.deps.humanTurnInFlight = () => true;
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'interrupted');
  assert.ok(rig.calls.includes('interrupt:w1'));
});

test('pre-review r2 #3: an interrupt attempt 1 made stays on the Bilan when attempt 2\'s probe flakes (never rewritten to "skipped", no second interrupt)', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const okKill = rig.deps.killTrees;
  rig.deps.killTrees = async () => { throw new Error('kill boom'); }; // attempt 1: interrupts, then incomplete
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  assert.equal(bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.activity?.interrupt, 'interrupted');
  rig.calls.length = 0;
  rig.deps.killTrees = okKill;
  rig.cliResult = { error: 'keeper unresponsive' }; // attempt 2: the probe flakes
  await runPauseTrap(rig.deps, getRunPause(rig.db, 'W')!);
  assert.equal(bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.activity?.interrupt, 'interrupted', 'the first attempt\'s interrupt is kept');
  assert.ok(!rig.calls.includes('interrupt:w1'), 'and it is not repeated while the CLI is unproven');
});

// ── round 3 ──

test('round-3 F1c/F3i: the interrupt skip needs a human turn in flight NOW; its WINDOW closes with the turn — a tool root started inside it stays shielded after the end, one started after is not (windows are what the killer gets)', async (t) => {
  for (const inFlight of [false, true]) {
    __resetPauseTrapForTests();
    const rig = newRig(t);
    member(rig, 'w1', 'W');
    const c = pauseW(rig);
    markPauseHumanTurn('w1', c.pausedAt + 5); // a human turn began after the pause
    if (!inFlight) markPauseHumanTurnEnd('w1', c.pausedAt + 100); // ...and ended seconds later (the agent-sdk gate release)
    rig.clock = c.pausedAt + 600_000; // the trap (or its retry) runs 10 minutes later
    rig.deps.humanTurnInFlight = () => inFlight;
    await runPauseTrap(rig.deps, c);
    const wins = rig.killOpts[0]?.humanWindows?.() ?? [];
    assert.equal(wins.length, 1);
    if (inFlight) {
      assert.ok(!rig.calls.includes('interrupt:w1'), 'control: the human turn is in flight — not interrupted');
      assert.equal(wins[0].to, undefined, 'its window is still open');
    } else {
      assert.ok(rig.calls.includes('interrupt:w1'), 'the human turn ended: the interrupt runs');
      assert.equal(wins[0].to, c.pausedAt + 100, 'its window is CLOSED at the turn end: roots started inside stay shielded, later ones are not');
    }
  }
});

test('round-3 F3i: markPauseHumanTurnEnd closes the LAST open window; windows before the pause are not shielded', () => {
  __resetPauseTrapForTests();
  markPauseHumanTurn('w9', 100);
  markPauseHumanTurnEnd('w9', 150);
  markPauseHumanTurn('w9', 200);
  markPauseHumanTurnEnd('w9', 250);
  markPauseHumanTurn('w9', 300); // still open
  assert.deepEqual(humanWindowsSince('w9', 0), [{ from: 100, to: 150 }, { from: 200, to: 250 }, { from: 300 }]);
  assert.deepEqual(humanWindowsSince('w9', 180), [{ from: 200, to: 250 }, { from: 300 }], 'a human turn that began BEFORE the pause was in flight at the pause: trapped, not shielded');
});

test('round-3 F2 (reviewer probe D1): a pauser PROVED on attempt 1 is never interrupted by later probe flakes — not after the 3-deferral bound, not on a healthy retry; a replaced CLI is re-derived', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'ops-w', 'W');
  const c = pauseW(rig, 'W', 'ops-w');
  recordPauseOrigin(rig.db, 'W', c.pausedAt, CHAIN_FROM_TOOL);
  rig.deps.armTimeoutMs = 20;
  rig.deps.arm = () => new Promise<void>(() => {}); // attempt 1: the arm hangs ⇒ incomplete, but cliOf proves the pauser first
  await runPauseTrap(rig.deps, c);
  const r1 = bilanForMember(rig.db, 'W', 'ops-w', c.pausedAt)!;
  assert.equal(r1.activity?.exempt, 'pauser');
  assert.deepEqual(r1.activity?.pauserCli, { pid: 100, startTicks: 1000 });
  rig.deps.arm = async () => {};
  rig.cliResult = { error: 'keeper busy' };
  for (let i = 0; i < MAX_INTERRUPT_DEFERRALS + 3; i++) await runPauseTrap(rig.deps, getRunPause(rig.db, 'W')!); // far past the deferral bound
  assert.ok(!rig.calls.includes('interrupt:ops-w'), 'the proven pauser is never interrupted while its CLI is unreadable');
  assert.equal(bilanForMember(rig.db, 'W', 'ops-w', c.pausedAt)!.activity?.exempt, 'pauser', 'the exemption is carried');
  rig.cliResult = { cli: { pid: 100, startTicks: 1000 }, keeperPid: 90 };
  await runPauseTrap(rig.deps, getRunPause(rig.db, 'W')!);
  assert.ok(!rig.calls.includes('interrupt:ops-w'), 'and a healthy retry re-derives the same pauser');
});

test('round-3 F2: the interrupt deferral is BOUNDED — MAX_INTERRUPT_DEFERRALS attempts with an unproven CLI, then the interrupt runs anyway (a turn must not run under a hard pause for ever); the count survives on the Bilan row', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  rig.cliResult = { error: 'keeper unresponsive' };
  for (let i = 1; i <= MAX_INTERRUPT_DEFERRALS; i++) {
    await runPauseTrap(rig.deps, getRunPause(rig.db, 'W')!);
    assert.ok(!rig.calls.includes('interrupt:w1'), `attempt ${i}: deferred`);
  }
  assert.equal(bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.activity?.interruptDeferrals, MAX_INTERRUPT_DEFERRALS);
  await runPauseTrap(rig.deps, getRunPause(rig.db, 'W')!);
  assert.ok(rig.calls.includes('interrupt:w1'), 'the next attempt interrupts anyway');
  assert.match((bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.activity?.notes ?? []).join(' '), /still unproven after 3 attempts — interrupting anyway/);
});

test('round-3 F5: a CLI that vanished/was replaced mid-trap makes the member INCOMPLETE (retried, never "0 killed, complete"), with a note; what it killed before stays on the Bilan (earlierKilled) and survives the retry', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  rig.killReport = { ...rig.killReport, cliGone: true, error: 'the CLI exited or was replaced DURING the kill (a Restart?)' };
  const s1 = await runPauseTrap(rig.deps, c);
  assert.equal(s1.done, false);
  assert.equal(s1.incomplete, 1);
  const r1 = bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!;
  assert.equal(r1.killed, null, 'the member stays owed');
  assert.match((r1.activity?.notes ?? []).join(' '), /CLI changed identity during the trap/);
  assert.equal(r1.activity?.earlierKilled?.[0]?.pid, 201, 'the kill that did happen is kept');
  rig.killReport = { ...rig.killReport, cliGone: undefined, error: undefined, killed: [] };
  const s2 = await runPauseTrap(rig.deps, getRunPause(rig.db, 'W')!);
  assert.equal(s2.done, true, 'the retry against the current CLI completes');
  assert.equal(bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.activity?.earlierKilled?.[0]?.pid, 201, 'and the earlier kill is still listed');
});

test('round-3 F6: the retry delay DOUBLES per failed attempt up to PAUSE_RETRY_MAX_MS (a persistently failing member is not re-snapshotted every 5 s)', async (t) => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(pauseRetryDelay), [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  assert.equal(PAUSE_RETRY_MAX_MS, 60_000);
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  rig.cliResult = { error: 'unresponsive' };
  pauseW(rig);
  let ran = (await sweepPauseTrap(rig.deps)).length; // attempt 1
  assert.equal(ran, 1);
  rig.clock += pauseRetryDelay(0) + 1;
  assert.equal((await sweepPauseTrap(rig.deps)).length, 1, 'attempt 2 after 5 s');
  rig.clock += pauseRetryDelay(0) + 1; // only 5 s since attempt 2 — the 2nd failure needs 10 s
  assert.equal((await sweepPauseTrap(rig.deps)).length, 0, 'inside the doubled delay: NOT retried');
  rig.clock += pauseRetryDelay(1);
  ran = (await sweepPauseTrap(rig.deps)).length;
  assert.equal(ran, 1, 'after 10 s: retried');
});

test('round-3 F6: a retried trap WARNS ONCE per pause (not on every attempt) and logs its start once', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  rig.cliResult = { error: 'unresponsive' };
  const c = pauseW(rig);
  const warns: string[] = [];
  const infos: string[] = [];
  const ow = log.warn;
  const oi = log.info;
  log.warn = (m: string) => { warns.push(m); };
  log.info = (m: string) => { infos.push(m); };
  try {
    for (let i = 0; i < 4; i++) await runPauseTrap(rig.deps, getRunPause(rig.db, 'W')!);
  } finally {
    log.warn = ow;
    log.info = oi;
  }
  assert.equal(warns.filter((m) => /could not be proven interrupted\/killed/.test(m)).length, 1, `one warning for 4 incomplete attempts: ${warns.join(' | ')}`);
  assert.equal(infos.filter((m) => /hard-paused at/.test(m)).length, 1, 'the start line is logged once');
  void c;
});

test('round-3 verifier MINOR: a turn start within seconds of the trap\'s OWN kill is recorded as the task-notification turn of the killed background task; one 20 s later (aged, not reset) or after a trap that killed NOTHING is not', async (t) => {
  const taskNote = async (kills: boolean, waitMs: number): Promise<string> => {
    __resetPauseTrapForTests();
    const rig = newRig(t);
    member(rig, 'w1', 'W');
    if (!kills) rig.killReport = { ...rig.killReport, killed: [] };
    else rig.killReport = { ...rig.killReport, killed: rig.killReport.killed.map((k) => ({ ...k, via: 'root-under-cli' })) }; // the task's tool ROOT ended by signal
    const c = pauseW(rig);
    await runPauseTrap(rig.deps, c);
    rig.clock += waitMs;
    await onTurnStart(rig.deps, tm('w1', 'W'));
    return (bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.activity?.notes ?? []).filter((n) => /turn started while paused/.test(n)).join(' | ');
  };
  assert.match(await taskNote(true, 1_000), /task-notification of a background task THIS trap just killed/, 'a start 1 s after the trap\'s kill');
  assert.doesNotMatch(await taskNote(true, 20_000), /task-notification/, 'a start 20 s later: outside the window (the stamp ages, it is not cleared)');
  assert.doesNotMatch(await taskNote(false, 1_000), /task-notification/, 'the trap killed nothing: no attribution');
});

test('round-3 review #3: earlierKilled is BOUNDED (the last 100) however many incomplete attempts killed', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  const many = Array.from({ length: 120 }, (_, i) => ({ pid: 1000 + i, comm: 'sleep', cmd: `sleep ${i}`, startTicks: 5, cwd: '/w', evidence: 'test', signal: 'SIGTERM', via: 'chain', outcome: 'exited' }));
  rig.killReport = { ...rig.killReport, killed: many as KillReport['killed'], cliGone: true, error: 'the CLI exited' };
  await runPauseTrap(rig.deps, c);
  const ek = bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.activity?.earlierKilled ?? [];
  assert.equal(ek.length, 100);
  assert.equal(ek[0].pid, 1020, 'the OLDEST entries are the ones dropped');
});

test('round-3 F2 (carry): the deferral COUNT survives an attempt that did not defer (cliOf healthy but the kill failed) — flake, kill-fail, flake counts 2, not 1', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  const okKill = rig.deps.killTrees;
  rig.cliResult = { error: 'flake' };
  await runPauseTrap(rig.deps, c); // attempt 1: deferred (count 1)
  rig.cliResult = { cli: { pid: 100, startTicks: 1000 }, keeperPid: 90 };
  rig.interruptResult = 'idle';
  rig.deps.killTrees = async () => { throw new Error('kill boom'); };
  await runPauseTrap(rig.deps, getRunPause(rig.db, 'W')!); // attempt 2: no deferral, incomplete (the count must be carried)
  assert.equal(bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.activity?.interruptDeferrals, 1, 'carried through the non-deferring attempt');
  rig.deps.killTrees = okKill;
  rig.cliResult = { error: 'flake' };
  await runPauseTrap(rig.deps, getRunPause(rig.db, 'W')!); // attempt 3: deferred again
  assert.equal(bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.activity?.interruptDeferrals, 2);
});

test('round-3 F4e: earlierKilled is written ONLY for attempts that stayed incomplete — a clean, complete trap never shows "killed by EARLIER incomplete attempt(s)"', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c); // complete, with kills (rig.killReport has one)
  const row = bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!;
  assert.notEqual(row.killed, null);
  assert.equal(row.activity?.earlierKilled, undefined);
});

test('round-3 review #5: an OPEN human window with no human turn in flight any more (session stopped/died before the release) is clamped to NOW — it shields nothing started later', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  markPauseHumanTurn('w1', c.pausedAt + 5); // opened, never closed (teardown path)
  rig.clock = c.pausedAt + 900;
  rig.deps.humanTurnInFlight = () => false;
  await runPauseTrap(rig.deps, c);
  const wins = rig.killOpts[0]?.humanWindows?.() ?? [];
  assert.equal(wins.length, 1);
  assert.notEqual(wins[0].to, undefined, 'clamped');
  assert.ok((wins[0].to as number) < c.pausedAt + 600_000);
});

test('round-3 review #6: markPauseHumanTurnEnd closes the LAST open window, not the first (a stale open window stays as it was)', () => {
  __resetPauseTrapForTests();
  markPauseHumanTurn('w8', 100); // stale: its release never fired
  markPauseHumanTurn('w8', 200);
  markPauseHumanTurnEnd('w8', 250);
  assert.deepEqual(humanWindowsSince('w8', 0), [{ from: 100 }, { from: 200, to: 250 }]);
});

test('round-3 review #7: a pauser PROVED on an earlier attempt is still on the Bilan row when the next attempt starts (the provisional write keeps exempt + pauserCli — an app death mid-attempt must not lose it)', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'ops-w', 'W');
  const c = pauseW(rig, 'W', 'ops-w');
  recordPauseOrigin(rig.db, 'W', c.pausedAt, CHAIN_FROM_TOOL);
  rig.deps.armTimeoutMs = 20;
  rig.deps.arm = () => new Promise<void>(() => {}); // attempt 1 stays incomplete
  await runPauseTrap(rig.deps, c);
  let seen: { exempt?: string; pauserCli?: unknown } | undefined;
  rig.deps.arm = async () => { seen = bilanForMember(rig.db, 'W', 'ops-w', c.pausedAt)!.activity ?? undefined; }; // runs right AFTER the provisional write of attempt 2
  await runPauseTrap(rig.deps, getRunPause(rig.db, 'W')!);
  assert.equal(seen?.exempt, 'pauser');
  assert.deepEqual(seen?.pauserCli, { pid: 100, startTicks: 1000 });
});

test('round-3 review #7 (clear): a pauser proved on attempt 1 is NOT carried onto an attempt whose CLI is a DIFFERENT process (replaced) — exempt is cleared and the interrupt runs', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'ops-w', 'W');
  const c = pauseW(rig, 'W', 'ops-w');
  recordPauseOrigin(rig.db, 'W', c.pausedAt, CHAIN_FROM_TOOL);
  rig.deps.armTimeoutMs = 20;
  rig.deps.arm = () => new Promise<void>(() => {}); // attempt 1: pauser proved, incomplete
  await runPauseTrap(rig.deps, c);
  assert.equal(bilanForMember(rig.db, 'W', 'ops-w', c.pausedAt)!.activity?.exempt, 'pauser');
  rig.deps.arm = async () => {};
  rig.cliResult = { cli: { pid: 100, startTicks: 2222 }, keeperPid: 90 }; // the CLI was REPLACED (same pid, other start-time): the recorded chain no longer names it
  await runPauseTrap(rig.deps, getRunPause(rig.db, 'W')!);
  const row = bilanForMember(rig.db, 'W', 'ops-w', c.pausedAt)!;
  assert.equal(row.activity?.exempt, undefined, 'the stale exemption label is gone');
  assert.equal(row.activity?.pauserCli, undefined);
  assert.ok(rig.calls.includes('interrupt:ops-w'), 'and the replaced CLI\'s member is interrupted like any other');
});

test('round-4: a snapshot TIMEOUT is recorded loud (snapshotIncomplete: timeout, no ref) and the pause GOES ON — interrupt + kill run, the member completes', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  rig.deps.snapshot = async () => { throw new SnapshotTimeoutError(120_000); };
  const s = await runPauseTrap(rig.deps, c);
  assert.equal(s.done, true, 'the trap completes');
  assert.ok(rig.calls.includes('interrupt:w1') && rig.calls.includes('kill:100/90'), 'interrupt + kill still ran');
  const row = bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!;
  assert.equal(row.snapshotRef, null);
  assert.equal(row.activity?.snapshotIncomplete, 'timeout');
  assert.match(row.error ?? '', /snapshot incomplete: timeout/);
});

test('round-4 review #1: a TIMED-OUT snapshot is never re-taken on a retry (each retry would wait the full timeout before the interrupt) and the label stays true — no ref, snapshotIncomplete kept', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  let snaps = 0;
  rig.deps.snapshot = async () => { snaps++; throw new SnapshotTimeoutError(120_000); };
  rig.cliResult = { error: 'keeper unresponsive' }; // attempt 1 stays incomplete
  await runPauseTrap(rig.deps, c);
  assert.equal(snaps, 1);
  rig.cliResult = { cli: { pid: 100, startTicks: 1000 }, keeperPid: 90 };
  await runPauseTrap(rig.deps, getRunPause(rig.db, 'W')!); // the retry
  assert.equal(snaps, 1, 'the retry did NOT call the snapshot again');
  const row = bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!;
  assert.equal(row.snapshotRef, null);
  assert.equal(row.activity?.snapshotIncomplete, 'timeout');
  assert.match(row.error ?? '', /snapshot incomplete: timeout/);
  assert.notEqual(row.killed, null, 'and the retry completed the member (interrupt + kill ran)');
});

// ── #255 structured Reprise: the trap stops the moment the Reprise begins, and a RELEASED member is no longer observed ─────────────────────────

test('REPRISE (not a lift) landing mid-trap: no process is touched after `resume_started_at`, the trap is not stamped and is not owed again (E2 stillPaused)', async (t) => {
  for (const where of ['snapshot', 'interrupt'] as const) {
    __resetPauseTrapForTests();
    const rig = newRig(t);
    member(rig, 'w1', 'W');
    member(rig, 'w2', 'W');
    const c = pauseW(rig);
    const begin = () => assert.equal(beginReprise(rig.db, 'W', 'ops-w'), 'resuming');
    if (where === 'snapshot') rig.onSnapshot = begin;
    else rig.onInterrupt = begin;
    const s = await runPauseTrap(rig.deps, c);
    assert.equal(s.done, false, where);
    assert.equal(s.aborted, 'lifted', where);
    assert.ok(!rig.calls.some((x) => x.startsWith('kill:')), `Reprise during ${where}: no kill after it began — ${rig.calls.join(' ')}`);
    if (where === 'snapshot') assert.ok(!rig.calls.some((x) => x.startsWith('interrupt')), `no interrupt either: ${rig.calls.join(' ')}`);
    assert.equal(getRunPause(rig.db, 'W')?.trapAt, null, 'not stamped');
    assert.deepEqual(runsOwingPauseTrap(rig.db), [], 'and a RESUMING carrier owes no trap');
  }
});

test('REPRISE: a CLI-started turn on a RELEASED member is left alone; the same on a member still BLOCKED is interrupted (the observer reads the gate\'s own decision)', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  const w1 = member(rig, 'w1', 'W');
  const w2 = member(rig, 'w2', 'W');
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c); // the Bilan rows the Reprise seeds its roster from
  const nodes = new Map([['W', { id: 'W', kind: 'orchestrator' }], ['w1', { id: 'w1', parentId: 'W' }], ['w2', { id: 'w2', parentId: 'W' }]]);
  rig.deps.carrierFor = (m) => pausedCarrierForWorkspace(rig.db, nodes.get(m.wsId)!, (id) => nodes.get(id));
  assert.equal(beginReprise(rig.db, 'W', 'ops-w'), 'resuming');
  assert.deepEqual(releaseMembers(rig.db, 'W', 'ops-w', ['w1']).released, ['w1']);
  rig.calls.length = 0;
  assert.equal(await onTurnStart(rig.deps, w1), 'not-paused', 'released: not observed');
  assert.ok(!rig.calls.some((x) => x.startsWith('interrupt')), rig.calls.join(' '));
  assert.equal(await onTurnStart(rig.deps, w2), 'interrupted', 'still blocked: a CLI-started turn is trapped');
  assert.ok(rig.calls.includes('interrupt:w2'), rig.calls.join(' '));
});

test('REPRISE: the host SWEEP (sweepPauseTrap) completes a RESUMING carrier\'s roster from the live store and closes it when everyone is released', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  assert.equal(beginReprise(rig.db, 'W', 'ops-w'), 'resuming');
  member(rig, 'late', 'W'); // a live member the Bilan never saw
  await sweepPauseTrap(rig.deps);
  const ws = (rig.db.prepare('SELECT ws_id, released_at FROM pause_members WHERE run_id = ?').all('W') as Array<{ ws_id: string; released_at: number | null }>);
  assert.deepEqual(ws.map((r) => r.ws_id).sort(), ['late', 'ops-w', 'w1'], 'the sweep added the straggler to the roster');
  assert.equal(ws.find((r) => r.ws_id === 'late')!.released_at, null, '…BLOCKED');
  assert.notEqual(getRunPause(rig.db, 'W'), null, 'still RESUMING');
  releaseMembers(rig.db, 'W', 'ops-w', 'all');
  assert.equal(getRunPause(rig.db, 'W'), null, 'closed by the last release');
});

test('RE-PAUSE during RESUMING (pre-review BLOCKING): the NEW epoch has no Bilan rows, so the host trap really snapshots, interrupts and kills a RELEASED member again — not a "complete" no-op over the old epoch', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c1 = pauseW(rig);
  const first = await runPauseTrap(rig.deps, c1);
  assert.equal(first.done, true, 'epoch 1 fully trapped (every Bilan row has killed_json)');
  assert.equal(beginReprise(rig.db, 'W', 'ops-w'), 'resuming');
  assert.deepEqual(releaseMembers(rig.db, 'W', 'ops-w', ['w1']).released, ['w1']); // w1 is released and runs on…
  rig.calls.length = 0;
  const end = Date.now() + 3;
  while (Date.now() < end);
  assert.equal(setRunPause(rig.db, 'W', true, 'ops-w'), 'paused'); // …then a human re-pauses
  const c2 = getRunPause(rig.db, 'W')!;
  assert.ok(c2.pausedAt > c1.pausedAt, 'a new epoch');
  assert.deepEqual(runsOwingPauseTrap(rig.db).map((r) => r.runId), ['W']);
  const second = await runPauseTrap(rig.deps, c2);
  assert.equal(second.done, true);
  for (const step of ['snapshot:w1', 'interrupt:w1']) assert.ok(rig.calls.includes(step), `${step} ran again on the new epoch: ${rig.calls.join(' ')}`);
  assert.ok(rig.calls.some((x) => x.startsWith('kill:')), `the tool trees were killed again: ${rig.calls.join(' ')}`);
  assert.notEqual(bilanForMember(rig.db, 'W', 'w1', c2.pausedAt)?.snapshotRef, null, 'a FRESH snapshot of what w1 did since the Reprise');
});

// ── #282: the kill is handed a `stop_task` bound to THE MEMBER (the CLI ends a bg task itself → no task-notification turn → no model request on a paused member) ──

test('#282: trapMember hands the kill a stopTask bound to THIS member — each task id the killer asks for reaches deps.stopTask(member, id)', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  member(rig, 'w2', 'W');
  const asked: string[] = [];
  rig.deps.stopTask = async (m, taskId) => { asked.push(`${m.wsId}:${taskId}`); return { ok: true }; };
  const origKill = rig.deps.killTrees;
  rig.deps.killTrees = async (cli, keeper, opts) => {
    assert.equal(typeof opts?.stopTask, 'function', 'the kill gets a stopTask');
    assert.deepEqual(await opts!.stopTask!('bt1'), { ok: true });
    return origKill(cli, keeper, opts);
  };
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  assert.deepEqual(asked.sort(), ['w1:bt1', 'w2:bt1'], 'each member\'s kill asks THROUGH its own member (never another session)');
});

test('#282: without deps.stopTask (PTY agent, fallback) the kill gets NO stopTask — signals only, as before', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  assert.equal(rig.killOpts.length, 1);
  assert.equal('stopTask' in (rig.killOpts[0] ?? {}), false);
});

test('#282: the turn OBSERVER\'s kill goes through stop_task too (a CLI-started turn\'s bg task SIGTERMed there would start yet another notification turn)', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  rig.killOpts.length = 0;
  const asked: string[] = [];
  rig.deps.stopTask = async (m, taskId) => { asked.push(`${m.wsId}:${taskId}`); return { ok: true }; };
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'interrupted');
  assert.equal(typeof rig.killOpts[0]?.stopTask, 'function');
  await rig.killOpts[0]!.stopTask!('bt9');
  assert.deepEqual(asked, ['w1:bt9']);
});

test('#282: a stop_task that FAILED is said in the Bilan (the signal kill ended it: a task-notification turn may follow, the observer interrupts it) — never silent', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  rig.killReport = { ...rig.killReport, stopTask: [{ taskId: 'bfail01', pid: 200, cmd: 'sleep 7718', ok: false, note: 'stop_task: unknown task' }] };
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  const row = bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!;
  assert.ok((row.activity?.notes ?? []).some((n) => /stop_task failed for bfail01 \(sleep 7718: stop_task: unknown task\) — not confirmed: the task was ended by signal/.test(n)), JSON.stringify(row.activity?.notes));
  assert.equal(row.error, null, 'a failed stop is a note, not an error: the signal path still ended the task, so the trap is complete');
  const ok = newRig(t);
  member(ok, 'w1', 'W');
  ok.killReport = { ...ok.killReport, stopTask: [{ taskId: 'bgood001', pid: 200, cmd: 'sleep 7718', ok: true }] };
  const c2 = pauseW(ok);
  await runPauseTrap(ok.deps, c2);
  assert.ok(!(bilanForMember(ok.db, 'W', 'w1', c2.pausedAt)!.activity?.notes ?? []).some((n) => /stop_task failed/.test(n)), 'a stop that worked adds no note');
});

test('#282: stop_task is offered ONLY once the member\'s turn is provably over (interrupted / idle) and for a STRUCTURED member (a proven keeper): the exempt pauser, a failed / unresponsive / no-session / skipped interrupt and a PTY agent (no keeper) get signals only — a foreground tool\'s shell carries a task id too, stopping it under a live turn would just continue that turn', async (t) => {
  const offered = async (setup: (rig: Rig) => void | Promise<void>, pauser = false): Promise<boolean> => {
    __resetPauseTrapForTests();
    const rig = newRig(t);
    member(rig, pauser ? 'ops-w' : 'w1', 'W');
    rig.deps.stopTask = async () => ({ ok: true });
    await setup(rig);
    const c = pauseW(rig, 'W', 'ops-w');
    if (pauser) recordPauseOrigin(rig.db, 'W', c.pausedAt, CHAIN_FROM_TOOL);
    await runPauseTrap(rig.deps, c);
    return typeof rig.killOpts[0]?.stopTask === 'function';
  };
  assert.equal(await offered(() => {}), true, 'interrupted: offered');
  assert.equal(await offered((r) => { r.interruptResult = 'idle'; }), true, 'idle (no turn was running): offered');
  assert.equal(await offered((r) => { r.interruptResult = 'attached-then-interrupted'; }), true, 'attached-then-interrupted: offered');
  assert.equal(await offered(() => {}, true), false, 'the exempt PAUSER keeps its turn: signals only');
  assert.equal(await offered((r) => { r.interruptResult = 'unresponsive'; }), false, 'an interrupt that could not be confirmed');
  assert.equal(await offered((r) => { r.interruptResult = 'failed'; }), false, 'a failed interrupt');
  assert.equal(await offered((r) => { r.interruptResult = 'no-session'; }), false, 'no session: nothing to ask');
  assert.equal(await offered((r) => { r.cliResult = { cli: { pid: 100, startTicks: 1000 }, keeperPid: null }; }), false, 'a PTY agent (the pty child IS the CLI, no keeper) has no SDK session to ask');
  // a HUMAN turn started during the trap: the trap skips its interrupt (that turn is allowed) — its foreground tools may be running, so no stop_task
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  rig.deps.stopTask = async () => ({ ok: true });
  const c = pauseW(rig);
  rig.onSnapshot = () => markPauseHumanTurn('w1', c.pausedAt + 5);
  await runPauseTrap(rig.deps, c);
  assert.equal(bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.activity?.interrupt, 'skipped');
  assert.equal('stopTask' in (rig.killOpts[0] ?? {}), false, 'a skipped interrupt (a human turn in flight): signals only');
});

test('#282: the structured-member gate reads THIS attempt\'s proven keeper, not the surface a retry carried over — a first attempt that could not probe (surface none) must not disable stop_task for the retry that reaches a good keeper', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  rig.deps.stopTask = async () => ({ ok: true });
  let n = 0;
  const act = rig.deps.activityOf;
  rig.deps.activityOf = async (m) => ({ ...(await act(m)), surface: n++ === 0 ? 'none' : 'sdk' });
  const origCli = rig.deps.cliOf;
  let k = 0;
  rig.deps.cliOf = async (m) => (k++ === 0 ? { error: 'keeper 90 is alive (keeper) but did not answer the probe (busy/unresponsive)' } : origCli(m));
  const c = pauseW(rig);
  const first = await runPauseTrap(rig.deps, c);
  assert.equal(first.done, false, 'attempt 1 could not prove the CLI: the trap stays open');
  assert.equal(rig.killOpts.length, 0);
  const next = await runPauseTrap(rig.deps, c);
  assert.equal(next.done, true);
  assert.equal(bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.activity?.surface, 'none', 'the retry carried the first attempt\'s surface');
  assert.equal(typeof rig.killOpts[0]?.stopTask, 'function', '…yet the proven keeper of THIS attempt lets stop_task be offered');
});

test('#282: the turn OBSERVER offers stop_task only after its interrupt took effect (a failed interrupt ⇒ signals only)', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  rig.deps.stopTask = async () => ({ ok: true });
  rig.killOpts.length = 0;
  rig.deps.interrupt = async () => { throw new Error('boom'); };
  assert.equal(await onTurnStart(rig.deps, tm('w1', 'W')), 'interrupted');
  assert.equal('stopTask' in (rig.killOpts[0] ?? {}), false, 'interrupt failed: no stop_task');
  void c;
});

test('#282: a kill ended by the CLI (stop_task) is NOT attributed to a later turn as "the task-notification of a task THIS trap killed" — the stop suppresses that notification; a SIGNAL kill still is', async (t) => {
  const note = async (signal: string): Promise<string> => {
    __resetPauseTrapForTests();
    const rig = newRig(t);
    member(rig, 'w1', 'W');
    rig.killReport = { ...rig.killReport, killed: [{ ...rig.killReport.killed[0], signal: signal as 'SIGTERM', via: 'root-under-cli' }] };
    const c = pauseW(rig);
    await runPauseTrap(rig.deps, c);
    rig.clock += 1_000;
    await onTurnStart(rig.deps, tm('w1', 'W'));
    return (bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.activity?.notes ?? []).filter((n) => /turn started while paused/.test(n)).join(' | ');
  };
  assert.match(await note('SIGTERM'), /task-notification of a background task THIS trap just killed/);
  assert.doesNotMatch(await note('stop_task'), /task-notification/);
  // an ORPHAN killed by signal is no task: it cannot be followed by a notification, so it stamps nothing (the mixed case: root stopped by the CLI + a daemonized job SIGTERMed)
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  rig.killReport = { ...rig.killReport, killed: [{ ...rig.killReport.killed[0], signal: 'stop_task', via: 'cli-stop-task' }, { ...rig.killReport.killed[0], pid: 700, signal: 'SIGTERM', via: 'env' }] };
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  rig.clock += 1_000;
  await onTurnStart(rig.deps, tm('w1', 'W'));
  assert.doesNotMatch((bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.activity?.notes ?? []).filter((n) => /turn started while paused/.test(n)).join(' | '), /task-notification/);
});

test('#282: a tool ROOT ended by signal although stop_task was offered had no task link — the Bilan says so (the original bug can silently return for a CLI whose output path differs); a linked/stopped root adds no such note', async (t) => {
  __resetPauseTrapForTests();
  const rig = newRig(t);
  member(rig, 'w1', 'W');
  rig.deps.stopTask = async () => ({ ok: true });
  rig.killReport = { ...rig.killReport, killed: [{ pid: 201, comm: 'sleep', cmd: 'sleep 7718', startTicks: 5, cwd: '/w', evidence: 'x', signal: 'SIGTERM', via: 'root-under-cli', outcome: 'exited' }] };
  const c = pauseW(rig);
  await runPauseTrap(rig.deps, c);
  assert.ok((bilanForMember(rig.db, 'W', 'w1', c.pausedAt)!.activity?.notes ?? []).some((n) => /ended by signal with no task link \(sleep 7718\)/.test(n)));
  const ok = newRig(t);
  member(ok, 'w1', 'W');
  ok.deps.stopTask = async () => ({ ok: true });
  ok.killReport = { ...ok.killReport, killed: [{ pid: 201, comm: 'sleep', cmd: 'sleep 7718', startTicks: 5, cwd: '/w', evidence: 'x', signal: 'stop_task', via: 'cli-stop-task', outcome: 'exited' }], stopTask: [{ taskId: 'b1', pid: 201, cmd: 'sleep 7718', ok: true }] };
  const c2 = pauseW(ok);
  await runPauseTrap(ok.deps, c2);
  assert.ok(!(bilanForMember(ok.db, 'W', 'w1', c2.pausedAt)!.activity?.notes ?? []).some((n) => /no task link/.test(n)));
  // a root that WAS asked (the stop failed) and ended by signal is the failed-stop note's business — not also "no task link"
  const bad = newRig(t);
  member(bad, 'w1', 'W');
  bad.deps.stopTask = async () => ({ ok: false });
  bad.killReport = { ...bad.killReport, killed: [{ pid: 201, comm: 'sleep', cmd: 'sleep 7718', startTicks: 5, cwd: '/w', evidence: 'x', signal: 'SIGTERM', via: 'root-under-cli', outcome: 'exited' }], stopTask: [{ taskId: 'b1', pid: 201, cmd: 'sleep 7718', ok: false, note: 'unknown task' }] };
  const c3 = pauseW(bad);
  await runPauseTrap(bad.deps, c3);
  const notes = bilanForMember(bad.db, 'W', 'w1', c3.pausedAt)!.activity?.notes ?? [];
  assert.ok(notes.some((n) => /stop_task failed for b1/.test(n)) && !notes.some((n) => /no task link/.test(n)), JSON.stringify(notes));
});
