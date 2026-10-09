// #326 — the per-member Veille verdict over a FAKE port: no port / unknown census / no Reliquat ⇒ today's Veille; live Reliquats ⇒ the delay (fast Veille excepted); past the delay ⇒ stop,
// tell, then Veille; a stop that could not look defers the Veille. Each arm names the clause it protects (in-place mutants: scripts/veille-reliquats-mutants.list.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeVeille, type JudgeDeps, type VeilleReliquatPort } from './veille-reliquats.ts';
import { emptyReliquatReport, type ReliquatKilled, type ReliquatReport } from '../shared/pause-reliquats.ts';
import { stripControl } from '../shared/pause-consigne.ts';
import type { HibernationSignals } from '../shared/hibernation.ts';
import type { Workspace } from '../shared/types.ts';

const NOW = 1_000_000_000;
const MIN = 60_000;
const THRESHOLD = 5 * MIN;
const DELAY = 30 * MIN;

/** A FLEET member by default (it has a coordinator): the Reliquat machinery is for the fleet (OPS ruling R11, #326-fu m4). */
const ws = (over: Partial<Workspace> = {}): Workspace => ({ id: 'w1', name: 'n', repoPath: '/r', worktreePath: '/w', branch: 'b', baseBranch: 'main', createdAt: 1, status: 'idle', agent: 'claude', parentId: 'coord', ...over }) as Workspace;
const sig = (idleMs: number, over: Partial<Omit<HibernationSignals, 'liveReliquats'>> = {}): Omit<HibernationSignals, 'liveReliquats'> => ({
  now: NOW, lastActivityAt: NOW - idleMs, isActive: false, hasLivePty: false, hasLiveSdk: true, hasLiveRunPty: false, hasLiveBackgroundTask: false,
  thresholdMs: THRESHOLD, monotonicIdleMs: idleMs, admissionHeld: false, reliquatDelayMs: DELAY, ...over,
});
const K = (pid: number): ReliquatKilled => ({ pid, startTicks: pid, comm: 'x', cmd: `proc-${pid}`, cwd: null, startedAt: 0, scope: 's', evidence: 'e', signal: 'SIGTERM', outcome: 'exited' });

class FakePort implements VeilleReliquatPort {
  live: number | 'unknown' | Error = 0;
  report: ReliquatReport | null | Error = null;
  tellOk: boolean | Error = true;
  calls: string[] = [];
  told: Array<{ wsId: string; text: string }> = [];
  async census(wsId: string): Promise<number | 'unknown'> {
    this.calls.push(`census:${wsId}`);
    if (this.live instanceof Error) throw this.live;
    return this.live;
  }
  stopCtx: { stillWanted(): boolean } | undefined;
  async stop(wsId: string, ctx?: { stillWanted(): boolean }): Promise<ReliquatReport | null> {
    this.stopCtx = ctx;
    this.calls.push(`stop:${wsId}`);
    if (this.report instanceof Error) throw this.report;
    return this.report;
  }
  async tell(wsId: string, text: string): Promise<boolean> {
    this.calls.push(`tell:${wsId}`);
    if (this.tellOk instanceof Error) throw this.tellOk;
    if (this.tellOk) this.told.push({ wsId, text });
    return this.tellOk;
  }
}
const deps = (port: VeilleReliquatPort | null, log: string[] = []): JudgeDeps => ({ port, strip: stripControl, info: (m) => log.push(`info: ${m}`), warn: (m) => log.push(`warn: ${m}`) });

test('positive control: no port registered ⇒ today\'s Veille — eligible past the threshold, nothing asked of anyone', async () => {
  const v = await judgeVeille(ws(), sig(10 * MIN), deps(null));
  assert.equal(v.hibernate, true);
  assert.equal((v as { liveReliquats: number }).liveReliquats, 0);
});

test('not past the NORMAL threshold (or any other guard) ⇒ not eligible, and NOT ONE census is paid for it', async () => {
  const p = new FakePort();
  p.live = 3;
  assert.deepEqual(await judgeVeille(ws(), sig(2 * MIN), deps(p)), { hibernate: false, why: 'not-eligible' });
  assert.deepEqual(await judgeVeille(ws({ status: 'running' }), sig(60 * MIN), deps(p)), { hibernate: false, why: 'not-eligible' });
  assert.deepEqual(await judgeVeille(ws(), sig(60 * MIN, { isActive: true }), deps(p)), { hibernate: false, why: 'not-eligible' });
  assert.deepEqual(p.calls, []);
});

test('no live Reliquat ⇒ Veille at the NORMAL threshold, nothing stopped, nobody told', async () => {
  const p = new FakePort();
  const v = await judgeVeille(ws(), sig(10 * MIN), deps(p));
  assert.deepEqual(p.calls, ['census:w1']);
  assert.equal(v.hibernate, true);
  assert.equal((v as { stopped: boolean }).stopped, false);
});

test('the census CANNOT say (unknown, or it throws) ⇒ NO Veille this pass (R11, #326-fu m3: UNKNOWN is not NONE), nothing stopped on a guess — and it is logged', async () => {
  for (const live of ['unknown', new Error('boom')] as const) {
    const p = new FakePort();
    p.live = live;
    const log: string[] = [];
    const v = await judgeVeille(ws(), sig(10 * MIN), deps(p, log));
    assert.deepEqual(v, { hibernate: false, why: 'reliquat-census-unknown' }, String(live));
    assert.deepEqual(p.calls, ['census:w1'], 'nothing stopped, nobody told');
    assert.ok(log.some((l) => /could not be counted|census .* threw/.test(l)), log.join('|'));
    assert.ok(log.some((l) => /Veille deferred/.test(l)), log.join('|'));
  }
});

test('the census recovers ⇒ the very next pass puts the member in Veille (a deferral is one sweep, not a ban)', async () => {
  const p = new FakePort();
  p.live = 'unknown';
  assert.equal((await judgeVeille(ws(), sig(10 * MIN), deps(p))).hibernate, false);
  p.live = 0;
  assert.equal((await judgeVeille(ws(), sig(10 * MIN), deps(p))).hibernate, true);
});

test('#326-fu m4 (R11): a member WITHOUT a coordinator is never counted, waited for or stopped — today\'s Veille at the normal threshold, no census paid', async () => {
  const p = new FakePort();
  p.live = 5;
  const v = await judgeVeille(ws({ parentId: undefined }), sig(10 * MIN), deps(p));
  assert.equal(v.hibernate, true);
  assert.equal((v as { stopped: boolean }).stopped, false);
  assert.deepEqual(p.calls, [], 'the port is not consulted at all');
  assert.equal((await judgeVeille(ws({ parentId: undefined }), sig(10 * MIN, { admissionHeld: true }), deps(p))).hibernate, true, 'nor under a held Admission');
  assert.deepEqual(p.calls, []);
  assert.deepEqual(await judgeVeille(ws({ parentId: undefined }), sig(2 * MIN), deps(p)), { hibernate: false, why: 'not-eligible' }, 'the normal threshold still governs');
});

test('#326-fu m2: the wait is judged on BOTH clocks — a wall clock that jumped (idle 3 h) over a member active a moment ago on the monotonic one WAITS, nothing stopped', async () => {
  const p = new FakePort();
  p.live = 2;
  p.report = { ...emptyReliquatReport(['s']), killed: [K(501)] };
  const v = await judgeVeille(ws(), sig(3 * 60 * MIN, { monotonicIdleMs: 20_000 }), deps(p));
  assert.equal(v.hibernate, false);
  assert.equal((v as { why: string }).why, 'reliquat-delay');
  assert.deepEqual(p.calls, ['census:w1'], 'no stop, no notice');
});

test('#326-fu m2: the notice states the idle time the wait was judged on — the SMALLER clock, never a jumped wall figure', async () => {
  const p = new FakePort();
  p.live = 1;
  p.report = { ...emptyReliquatReport(['s']), killed: [K(501)] };
  await judgeVeille(ws(), sig(3 * 60 * MIN, { monotonicIdleMs: 32 * MIN }), deps(p));
  assert.match(p.told[0].text, /because you had been idle for 32m/);
});

test('#326-fu m1: the member is judged AGAIN on fresh state BEFORE the first signal — a prompt delivered while the census awaited keeps its Reliquats alive', async () => {
  const p = new FakePort();
  p.live = 3;
  p.report = { ...emptyReliquatReport(['s']), killed: [K(501)] };
  const asked: number[] = [];
  const log: string[] = [];
  const v = await judgeVeille(ws(), sig(40 * MIN), { ...deps(p, log), stillEligible: (n) => { asked.push(n); return false; } });
  assert.deepEqual(v, { hibernate: false, why: 'not-eligible' });
  assert.deepEqual(p.calls, ['census:w1'], 'no stop, no notice');
  assert.deepEqual(asked, [3], 'asked with the number of Reliquats still to wait for');
  assert.ok(log.some((l) => /no longer eligible/.test(l) && /NOT stopped/.test(l)), log.join('|'));
});

test('#326-fu m1: the same fresh question guards EVERY signal round — the stop is handed `wanted` = (the sweep\'s epoch check) AND (fresh eligibility), both read live', async () => {
  const p = new FakePort();
  p.live = 2;
  p.report = { ...emptyReliquatReport(['s']), killed: [K(501)] };
  let epochOk = true;
  let eligible = true;
  const asked: number[] = [];
  await judgeVeille(ws(), sig(40 * MIN), { ...deps(p), stillWanted: () => epochOk, stillEligible: (n) => { asked.push(n); return eligible; } });
  asked.length = 0;
  assert.equal(p.stopCtx?.stillWanted(), true);
  assert.deepEqual(asked, [2]);
  eligible = false;
  assert.equal(p.stopCtx?.stillWanted(), false, 'a prompt / status change / fresh activity mid-stop ends the signal rounds');
  eligible = true;
  epochOk = false;
  assert.equal(p.stopCtx?.stillWanted(), false, 'a wake or delete mid-stop does too');
  epochOk = true;
  assert.equal(p.stopCtx?.stillWanted(), true, 'control: both hold');
});

test('#326-fu m1: no fresh-eligibility dependency (a rig that does not wire it) ⇒ the previous behaviour, unchanged', async () => {
  const p = new FakePort();
  p.live = 1;
  p.report = { ...emptyReliquatReport(['s']), killed: [K(501)] };
  const v = await judgeVeille(ws(), sig(40 * MIN), deps(p));
  assert.equal(v.hibernate, true);
  assert.deepEqual(p.calls, ['census:w1', 'stop:w1', 'tell:w1']);
});

test('live Reliquats, idle 10 min (< the 30 min delay) ⇒ NO Veille, says how long is left; nothing is stopped yet', async () => {
  const p = new FakePort();
  p.live = 2;
  const v = await judgeVeille(ws(), sig(10 * MIN), deps(p));
  assert.deepEqual(v, { hibernate: false, why: 'reliquat-delay', liveReliquats: 2, waitMs: 20 * MIN });
  assert.deepEqual(p.calls, ['census:w1']);
});

test('live Reliquats, idle 31 min ⇒ STOP them, TELL the member, then Veille — in that order', async () => {
  const p = new FakePort();
  p.live = 1;
  p.report = { ...emptyReliquatReport(['s']), killed: [K(501)] };
  const v = await judgeVeille(ws(), sig(31 * MIN), deps(p));
  assert.deepEqual(p.calls, ['census:w1', 'stop:w1', 'tell:w1']);
  assert.equal(v.hibernate, true);
  const h = v as Extract<typeof v, { hibernate: true }>;
  assert.equal(h.stopped, true);
  assert.equal(h.told, true);
  assert.equal(h.fast, false);
  assert.match(p.told[0].text, /^Orchestra stopped 1 leftover process\(es\) of yours \(Reliquats\) because you had been idle for 31m/);
  assert.match(p.told[0].text, /proc-501/);
});

test('FAST Veille (Admission held, fleet member) is not delayed: idle 1 min with Reliquats ⇒ stop + tell + Veille, worded as memory pressure', async () => {
  const p = new FakePort();
  p.live = 4;
  p.report = { ...emptyReliquatReport(['s']), killed: [K(501)] };
  const v = await judgeVeille(ws({ parentId: 'coord' }), sig(1 * MIN, { admissionHeld: true }), deps(p));
  assert.deepEqual(p.calls, ['census:w1', 'stop:w1', 'tell:w1']);
  assert.equal(v.hibernate, true);
  assert.equal((v as { fast: boolean }).fast, true);
  assert.match(p.told[0].text, /Reliquats\) early, to free memory \(Admission is held\)/);
  // control: the SAME member with Admission open waits
  const p2 = new FakePort();
  p2.live = 4;
  assert.equal((await judgeVeille(ws({ parentId: 'coord' }), sig(1 * MIN), deps(p2))).hibernate, false);
});

test('a stop that found NOTHING to report (they died meanwhile) ⇒ Veille, nobody told', async () => {
  const p = new FakePort();
  p.live = 1;
  p.report = null;
  const v = await judgeVeille(ws(), sig(40 * MIN), deps(p));
  assert.deepEqual(p.calls, ['census:w1', 'stop:w1']);
  assert.equal((v as { told: boolean }).told, false);
  assert.equal(v.hibernate, true);
});

test('a stop that could not LOOK (report.unknown / report.error / it throws) ⇒ the Veille WAITS for the next sweep (UNKNOWN is not NONE); what WAS stopped is still told', async () => {
  const p = new FakePort();
  p.live = 2;
  p.report = { ...emptyReliquatReport(['s']), killed: [K(501)], unknown: 'scope s: cgroup.procs unreadable' };
  const log: string[] = [];
  const v = await judgeVeille(ws(), sig(40 * MIN), deps(p, log));
  assert.deepEqual(v, { hibernate: false, why: 'reliquat-stop-incomplete', liveReliquats: 2, detail: 'scope s: cgroup.procs unreadable' });
  assert.deepEqual(p.calls, ['census:w1', 'stop:w1', 'tell:w1']);
  assert.ok(log.some((l) => /stop incomplete/.test(l) && /member was told what WAS stopped/.test(l)));
  const p2 = new FakePort();
  p2.live = 2;
  p2.report = { ...emptyReliquatReport(), error: 'process identity unavailable' };
  assert.equal((await judgeVeille(ws(), sig(40 * MIN), deps(p2))).hibernate, false);
  assert.deepEqual(p2.calls, ['census:w1', 'stop:w1'], 'nothing to tell');
  const p3 = new FakePort();
  p3.live = 2;
  p3.report = new Error('boom');
  const v3 = await judgeVeille(ws(), sig(40 * MIN), deps(p3));
  assert.equal(v3.hibernate, false);
  assert.equal((v3 as { why: string }).why, 'reliquat-stop-incomplete');
});

test('the notice could not be queued (false / throws) ⇒ the Veille still happens (a lost notice is logged, never a reason to keep the member awake)', async () => {
  for (const tellOk of [false, new Error('disk full')] as const) {
    const p = new FakePort();
    p.live = 1;
    p.report = { ...emptyReliquatReport(['s']), killed: [K(501)] };
    p.tellOk = tellOk;
    const log: string[] = [];
    const v = await judgeVeille(ws(), sig(40 * MIN), deps(p, log));
    assert.equal(v.hibernate, true, String(tellOk));
    assert.equal((v as { told: boolean }).told, false);
    assert.ok(log.some((l) => l.startsWith('warn: veille: the Reliquat notice')), log.join('|'));
  }
});

test('the Reliquat delay is read from the SIGNAL: a setting changed between two passes changes the next verdict (hot)', async () => {
  const p = new FakePort();
  p.live = 1;
  p.report = { ...emptyReliquatReport(['s']), killed: [K(501)] };
  assert.equal((await judgeVeille(ws(), sig(10 * MIN, { reliquatDelayMs: 30 * MIN }), deps(p))).hibernate, false);
  assert.equal((await judgeVeille(ws(), sig(10 * MIN, { reliquatDelayMs: 8 * MIN }), deps(p))).hibernate, true);
});

test('the stop is handed the sweep\'s « still wanted » check (a wake / delete mid-stop ends the signal rounds); a stop that was ABORTED defers the Veille and still tells what was stopped', async () => {
  const p = new FakePort();
  p.live = 1;
  p.report = { ...emptyReliquatReport(['s']), killed: [K(501)], aborted: 'lifted' };
  let wanted = true;
  const v = await judgeVeille(ws(), sig(40 * MIN), { ...deps(p), stillWanted: () => wanted });
  assert.equal(p.stopCtx?.stillWanted(), true);
  wanted = false;
  assert.equal(p.stopCtx?.stillWanted(), false, 'it is the sweep\'s check, read live');
  assert.equal(v.hibernate, false);
  assert.equal((v as { why: string }).why, 'reliquat-stop-incomplete');
  assert.match((v as { detail: string }).detail, /aborted \(lifted\)/);
  assert.deepEqual(p.calls, ['census:w1', 'stop:w1', 'tell:w1']);
});
