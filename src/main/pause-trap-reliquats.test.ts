// #325 — the HOST TRAP kills the member's RELIQUATS (ledger #329, FI-1 v1): over a REAL bus, the process/session layer faked (as in pause-trap.test.ts / pause-trap-containers.test.ts).
// `deps.killReliquats` is the seam the production host binds to `killReliquats` over the member scope (the real killer is pause-reliquats.test.ts; the real keeper in a real scope is the rig).
// Each arm names the clause it protects (in-place mutants: scripts/pause-trap/mutants-reliquats.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBus, type BusDb } from './bus.ts';
import { startRun } from './bus-runs.ts';
import { setRunPause, getRunPause, beginReprise } from './bus-pause.ts';
import { appendBilanNote, bilanForMember, recordPauseOrigin } from './bus-pause-records.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';
import { __resetPauseTrapForTests, runPauseTrap, trapMember, type TrapDeps, type TrapMember } from './pause-trap.ts';
import type { KillReport } from './pause-kill.ts';
import type { ReliquatKillOptions } from './pause-reliquats.ts';
import { emptyReliquatReport, type ReliquatKilled, type ReliquatReport } from '../shared/pause-reliquats.ts';

const ROOT = path.join(os.homedir(), '.cache', `pause-trap-reliquats-${process.pid}`);
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let n = 0;

interface Rig {
  db: BusDb;
  deps: TrapDeps;
  calls: string[];
  roster: TrapMember[];
  /** What the next `killReliquats` call answers (a function = per call). */
  answer: ((o: ReliquatKillOptions, call: number) => ReliquatReport | null | Promise<ReliquatReport | null>) | ReliquatReport | null;
  opts: ReliquatKillOptions[];
  cliResult: { cli: { pid: number; startTicks: number }; keeperPid: number | null } | { error: string } | null;
}

const member = (wsId: string, extra: Partial<TrapMember> = {}): TrapMember => ({ wsId, runId: 'W', worktreePath: `/w/${wsId}`, remote: false, status: null, lastTask: null, ...extra });
const killedOf = (pid: number, extra: Partial<ReliquatKilled> = {}): ReliquatKilled => ({ pid, startTicks: 1000 + pid, comm: 'chrome', cmd: `/usr/bin/chrome --headless --n=${pid}`, cwd: '/w/m1', startedAt: 1_700_000_000_000, scope: 'orchestra-rig-wh-m1-abc.scope', evidence: 'e', signal: 'SIGTERM', outcome: 'exited', ...extra });
const reportOf = (...pids: number[]): ReliquatReport => ({ ...emptyReliquatReport(['orchestra-rig-wh-m1-abc.scope']), killed: pids.map((p) => killedOf(p)), rounds: 1 });

function newRig(withReliquats = true): Rig {
  fs.mkdirSync(ROOT, { recursive: true });
  const db = openBus(path.join(ROOT, `b${n++}.sqlite`));
  const sw = { ...DEFAULT_BUS_SWITCHES, pause: true };
  startRun(db, { id: 'M', kind: 'mission', coordinator: 'lead' }, sw);
  startRun(db, { id: 'W', kind: 'vague', coordinator: 'ops-w', parentRunId: 'M' }, sw);
  const calls: string[] = [];
  const rig: Rig = { db, calls, roster: [member('m1')], answer: reportOf(500, 501), opts: [], cliResult: { cli: { pid: 100, startTicks: 1000 }, keeperPid: 90 }, deps: undefined as unknown as TrapDeps };
  const toolReport: KillReport = { cliPid: 100, cli: { pid: 100, startTicks: 1000 }, killed: [], refused: [], spared: [], survivors: [], rounds: 1 };
  let clock = 10_000;
  rig.deps = {
    getBus: () => db,
    now: () => clock++,
    members: (runIds) => rig.roster.filter((m) => runIds.includes(m.runId)),
    activityOf: async () => ({ surface: 'sdk', turnRunning: false, inFlightTools: [], bgTasks: [] }),
    interrupt: async () => 'idle',
    cliOf: async () => rig.cliResult,
    snapshot: async (i) => ({ ref: `refs/orchestra/pause/${i.runId}/${i.wsId}/1`, commit: 'c', tree: 't', head: 'h', branch: 'b', dirty: false, changed: { modified: 0, added: 0, deleted: 0 }, skippedLarge: [], skippedLargeCount: 0, notes: [], warnings: [], submodules: [] }),
    killTrees: async () => {
      calls.push('killTrees');
      return toolReport;
    },
    sleep: async () => {},
    settleMs: 0,
    originWaitMs: 0,
    ...(withReliquats
      ? {
          killReliquats: async (_m: TrapMember, o: ReliquatKillOptions) => {
            calls.push('killReliquats');
            rig.opts.push(o);
            const a = rig.answer;
            return typeof a === 'function' ? a(o, rig.opts.length) : a;
          },
        }
      : {}),
  };
  return rig;
}

function pause(rig: Rig): NonNullable<ReturnType<typeof getRunPause>> {
  assert.equal(setRunPause(rig.db, 'W', true, 'ops-w'), 'paused');
  return getRunPause(rig.db, 'W')!;
}

test('a Pause dure kills the member\'s Reliquats AFTER the tool-tree kill and records them in the Bilan (activity.reliquats: command, pid, start-time, start) — the trap is complete', async () => {
  __resetPauseTrapForTests();
  const rig = newRig();
  const c = pause(rig);
  assert.equal(await trapMember(rig.deps, rig.db, c, rig.roster[0]), 'complete');
  assert.deepEqual(rig.calls.filter((x) => x === 'killTrees' || x === 'killReliquats'), ['killTrees', 'killReliquats'], 'order: tool trees THEN Reliquats');
  const row = bilanForMember(rig.db, 'W', 'm1', c.pausedAt)!;
  assert.notEqual(row.killed, null, 'stamped complete');
  const rq = row.activity!.reliquats!;
  assert.deepEqual(rq.killed.map((k) => [k.pid, k.startTicks, k.cmd, k.startedAt]), [[500, 1500, '/usr/bin/chrome --headless --n=500', 1_700_000_000_000], [501, 1501, '/usr/bin/chrome --headless --n=501', 1_700_000_000_000]]);
  assert.deepEqual(rq.scopes, ['orchestra-rig-wh-m1-abc.scope']);
});

test('the killer gets the trap\'s PROVEN keeper + CLI (never signalled), the lift check, the HUMAN windows — and runs only after a proven session', async () => {
  __resetPauseTrapForTests();
  const rig = newRig();
  const c = pause(rig);
  await trapMember(rig.deps, rig.db, c, rig.roster[0]);
  const o = rig.opts[0];
  assert.deepEqual([o.keeperPid, o.cliPid], [90, 100]);
  assert.equal(o.stillPaused?.(), true);
  assert.equal(typeof o.humanWindows, 'function', 'D9: a human turn that began during the trap shields what it started');
  // the lift flips the same callback the killer re-checks before EVERY signal
  assert.equal(beginReprise(rig.db, 'W', 'ops-w'), 'resuming');
  assert.equal(o.stillPaused?.(), false);
});

test('an UNPROVEN CLI/keeper (alive but unresponsive) ⇒ no Reliquat is touched and the trap stays open; a member with NO live CLI (no keeper at all) IS given the step with keeper/cli null', async () => {
  __resetPauseTrapForTests();
  const rig = newRig();
  rig.cliResult = { error: 'keeper 90 is alive (keeper) but did not answer the probe' };
  const c = pause(rig);
  assert.equal(await trapMember(rig.deps, rig.db, c, rig.roster[0]), 'incomplete');
  assert.ok(!rig.calls.includes('killReliquats'), 'fail closed: nothing signalled under an unprovable session');
  assert.doesNotMatch(bilanForMember(rig.db, 'W', 'm1', c.pausedAt)!.error ?? '', /reliquats/, 'the step is not even ATTEMPTED under an unprovable session (a crash caught inside it would look like a refusal and hide a missing guard)');
  __resetPauseTrapForTests();
  const rig2 = newRig();
  rig2.cliResult = null;
  const c2 = pause(rig2);
  assert.equal(await trapMember(rig2.deps, rig2.db, c2, rig2.roster[0]), 'complete');
  assert.deepEqual([rig2.opts[0].keeperPid, rig2.opts[0].cliPid], [null, null]);
  assert.equal(bilanForMember(rig2.db, 'W', 'm1', c2.pausedAt)!.activity!.reliquats!.killed.length, 2);
});

test('NO tracked scope (the killer answers null): nothing is recorded — the Bilan row is byte-identical to the one a trap WITHOUT the step writes; no dep at all ⇒ same', async () => {
  __resetPauseTrapForTests();
  const a = newRig(true);
  a.answer = null;
  const ca = pause(a);
  await trapMember(a.deps, a.db, ca, a.roster[0]);
  const b = newRig(false);
  const cb = pause(b);
  await trapMember(b.deps, b.db, cb, b.roster[0]);
  const ra = bilanForMember(a.db, 'W', 'm1', ca.pausedAt)!;
  const rb = bilanForMember(b.db, 'W', 'm1', cb.pausedAt)!;
  assert.equal('reliquats' in (ra.activity ?? {}), false);
  assert.deepEqual([ra.activity, ra.killed, ra.error, ra.dirty, ra.snapshotRef?.replace(/\/\d+$/, '')], [rb.activity, rb.killed, rb.error, rb.dirty, rb.snapshotRef?.replace(/\/\d+$/, '')]);
  assert.ok(a.calls.includes('killReliquats') && !b.calls.includes('killReliquats'));
});

test('a remote/sandbox member never reaches the step (its processes live in a container)', async () => {
  __resetPauseTrapForTests();
  const rig = newRig();
  rig.roster = [member('m1', { remote: true })];
  const c = pause(rig);
  assert.equal(await trapMember(rig.deps, rig.db, c, rig.roster[0]), 'complete');
  assert.ok(!rig.calls.includes('killReliquats'));
});

test('UNKNOWN is not NONE: an unreadable scope leaves killed_json NULL (trap owed), records why, and the RETRY redoes the step and merges what the first attempt killed', async () => {
  __resetPauseTrapForTests();
  const rig = newRig();
  rig.answer = (_o, call) => (call === 1 ? { ...reportOf(500), unknown: 'scope orchestra-rig-wh-m1-abc.scope: cgroup.procs unreadable — its Reliquats could not be listed' } : reportOf(501));
  const c = pause(rig);
  assert.equal(await trapMember(rig.deps, rig.db, c, rig.roster[0]), 'incomplete');
  const r1 = bilanForMember(rig.db, 'W', 'm1', c.pausedAt)!;
  assert.equal(r1.killed, null, 'owed');
  assert.match(r1.error ?? '', /reliquats: scope .*unreadable.*retried/);
  assert.deepEqual(r1.activity!.reliquats!.killed.map((k) => k.pid), [500], 'what was killed is kept, never dropped');
  // the retry's PROVISIONAL Bilan write (before it touches any process) must not erase what attempt 1 recorded: an app that dies right there would lose the list
  let atCliOf: number[] | null = null;
  const realCliOf = rig.deps.cliOf;
  rig.deps.cliOf = async (mm) => {
    atCliOf = (bilanForMember(rig.db, 'W', 'm1', c.pausedAt)!.activity?.reliquats?.killed ?? []).map((k) => k.pid);
    return realCliOf(mm);
  };
  assert.equal(await trapMember(rig.deps, rig.db, c, rig.roster[0]), 'complete');
  assert.deepEqual(atCliOf, [500], 'attempt 1\'s Reliquats survive the retry\'s provisional write');
  const r2 = bilanForMember(rig.db, 'W', 'm1', c.pausedAt)!;
  assert.notEqual(r2.killed, null);
  assert.deepEqual(r2.activity!.reliquats!.killed.map((k) => k.pid).sort(), [500, 501], 'merged BY IDENTITY across attempts');
  assert.equal(r2.error, null, 'a clean retry clears the earlier unknown');
});

test('the killer THROWING never loses the member: recorded, trap incomplete, retried', async () => {
  __resetPauseTrapForTests();
  const rig = newRig();
  rig.answer = () => { throw new Error('cgroup exploded'); };
  const c = pause(rig);
  assert.equal(await trapMember(rig.deps, rig.db, c, rig.roster[0]), 'incomplete');
  assert.match(bilanForMember(rig.db, 'W', 'm1', c.pausedAt)!.error ?? '', /reliquats: cgroup exploded.*retried/);
});

test('SURVIVORS are loud (error on the row, listed) like tool survivors — and do not keep the trap open', async () => {
  __resetPauseTrapForTests();
  const rig = newRig();
  rig.answer = { ...reportOf(500), survivors: [{ pid: 502, comm: 'chrome', cmd: 'chrome --stuck', reason: 'still-alive-after-kill' }] };
  const c = pause(rig);
  assert.equal(await trapMember(rig.deps, rig.db, c, rig.roster[0]), 'complete');
  const row = bilanForMember(rig.db, 'W', 'm1', c.pausedAt)!;
  assert.match(row.error ?? '', /reliquats: 1 leftover process\(es\) still alive/);
  assert.equal(row.activity!.reliquats!.survivors[0].pid, 502);
});

test('the pause LIFTED while the Reliquats are being killed: the trap returns `lifted`, and what WAS killed stays in the Bilan', async () => {
  __resetPauseTrapForTests();
  const rig = newRig();
  rig.answer = { ...reportOf(500), aborted: 'lifted' };
  const c = pause(rig);
  assert.equal(await trapMember(rig.deps, rig.db, c, rig.roster[0]), 'lifted');
  assert.deepEqual(bilanForMember(rig.db, 'W', 'm1', c.pausedAt)!.activity!.reliquats!.killed.map((k) => k.pid), [500]);
});

test('WRITE-AHEAD: a Reliquat the killer reports through onProgress is in the PERSISTED Bilan before the killer returns (an app that dies mid-kill still lists it)', async () => {
  __resetPauseTrapForTests();
  const rig = newRig();
  let seenDuringCall: number[] = [];
  let noteSurvived = false;
  rig.answer = (o) => {
    const at = getRunPause(rig.db, 'W')!.pausedAt;
    appendBilanNote(rig.db, 'W', 'm1', at, 'a note the turn observer appended meanwhile');
    o.onProgress?.(reportOf(500));
    const row = bilanForMember(rig.db, 'W', 'm1', at)!;
    seenDuringCall = row.activity!.reliquats!.killed.map((k) => k.pid);
    noteSurvived = (row.activity!.notes ?? []).includes('a note the turn observer appended meanwhile');
    return reportOf(500, 501);
  };
  const c = pause(rig);
  await trapMember(rig.deps, rig.db, c, rig.roster[0]);
  assert.deepEqual(seenDuringCall, [500]);
  assert.equal(noteSurvived, true, 'the progress write touches only activity.reliquats');
  assert.deepEqual(bilanForMember(rig.db, 'W', 'm1', c.pausedAt)!.activity!.reliquats!.killed.map((k) => k.pid), [500, 501]);
});

test('the PAUSER\'s whole process chain is handed to the killer as protected (it never signals the call that ran `orchestra run pause`)', async () => {
  __resetPauseTrapForTests();
  const rig = newRig();
  const c = pause(rig);
  // the CLI recorded the pausing call's chain: CLI(100) → bash tool(300) → node cli(301)
  recordPauseOrigin(rig.db, 'W', c.pausedAt, [{ pid: 301, ppid: 300, startTicks: 3, comm: 'node' }, { pid: 300, ppid: 100, startTicks: 2, comm: 'bash' }, { pid: 100, ppid: 90, startTicks: 1000, comm: 'claude' }]);
  await trapMember(rig.deps, rig.db, c, rig.roster[0]);
  assert.deepEqual([...(rig.opts[0].protectPids ?? [])].sort((a, b) => a - b), [100, 300, 301]);
  // a non-pauser trap passes none
  __resetPauseTrapForTests();
  const plain = newRig();
  const cp = pause(plain);
  await trapMember(plain.deps, plain.db, cp, plain.roster[0]);
  assert.equal(plain.opts[0].protectPids, undefined);
});

test('runPauseTrap over the roster: every member gets the step before the trap is stamped; one member\'s unknown holds the stamp back', async () => {
  __resetPauseTrapForTests();
  const rig = newRig();
  rig.roster = [member('m1'), member('m2')];
  rig.answer = (_o, call) => (call === 2 ? { ...reportOf(600), unknown: 'scope unreadable' } : reportOf(500));
  const c = pause(rig);
  const sum = await runPauseTrap(rig.deps, c);
  assert.equal(sum.done, false);
  assert.equal(sum.incomplete, 1);
  assert.equal(getRunPause(rig.db, 'W')!.trapAt ?? null, null, 'not stamped while a scope is unknown');
  rig.answer = (_o, call) => reportOf(700 + call);
  const sum2 = await runPauseTrap(rig.deps, c);
  assert.equal(sum2.done, true);
  assert.notEqual(getRunPause(rig.db, 'W')!.trapAt ?? null, null);
});
