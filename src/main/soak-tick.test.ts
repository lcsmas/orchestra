// The REAL `soakTick` (src/main/soak-tick.ts) driven over fake deps (C5 #212): it launches when — and only when — the pure decision says so, yields
// to the user, keeps at most one campaign alive, and records outcomes so that only a campaign that RAN to its end advances the change gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soakTick, isSoakRunning, EMPTY_SOAK_STATE, type SoakDeps, type SoakRunResult } from './soak-tick.ts';
import type { SoakActivity, SoakState } from '../shared/soak-schedule.ts';

const GB = 1048576, H = 3600_000, NOW = 1_800_000_000_000;
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const idle = (over: Partial<SoakActivity> = {}): SoakActivity => ({ appUptimeMs: 5 * H, windowFocused: false, lastFocusedAt: NOW - 3 * H, systemIdleSec: 7200, workspaces: [], ...over });

interface Rig { deps: SoakDeps; logs: string[]; launches: Array<{ repo: string; sessions: number }>; yields: string[]; states: SoakState[]; finish(r: SoakRunResult): Promise<void>; fail(e: Error): Promise<void>; setActivity(a: SoakActivity): void; setIdentity(i: { codeId: string | null; cliVersion: string | null }): void; setNow(n: number): void }
function rig(opts: { state?: SoakState; enabled?: boolean; repo?: string | null } = {}): Rig {
  let state: SoakState = opts.state ?? EMPTY_SOAK_STATE;
  let activity = idle();
  let identity: { codeId: string | null; cliVersion: string | null } = { codeId: 'code-1', cliVersion: '2.1.284' };
  let now = NOW;
  const logs: string[] = [], launches: Rig['launches'] = [], yields: string[] = [], states: SoakState[] = [];
  let resolveDone: (r: SoakRunResult) => void = () => {}, rejectDone: (e: Error) => void = () => {};
  const deps: SoakDeps = {
    now: () => now, resolveRepo: () => (opts.repo === undefined ? '/repo' : opts.repo), enabled: () => opts.enabled ?? true,
    readState: () => state, writeState: (s) => { state = s; states.push(s); },
    identity: async () => identity, activity: () => activity, machine: () => ({ memAvailKB: 20 * GB, load1: 3 }),
    launch: (o) => {
      launches.push(o);
      const done = new Promise<SoakRunResult>((res, rej) => { resolveDone = res; rejectDone = rej; });
      return { done, yieldNow: (why) => yields.push(why) };
    },
    log: { info: (m) => logs.push(`INFO ${m}`), warn: (m) => logs.push(`WARN ${m}`), debug: (m) => logs.push(`DEBUG ${m}`) },
  };
  return { deps, logs, launches, yields, states, finish: async (r) => { resolveDone(r); await flush(); }, fail: async (e) => { rejectDone(e); await flush(); }, setActivity: (a) => { activity = a; }, setIdentity: (i) => { identity = i; }, setNow: (n) => { now = n; } };
}
const ok = (t: string, extra: Partial<SoakRunResult> = {}): SoakRunResult => ({ terminator: t, reportJson: '/soak/r.json', failing: [], detail: 'rc=0', ...extra });

test('first ever tick on an idle machine launches ONE campaign, sized by the RAM, and records the attempt', async () => {
  const r = rig();
  const d = await soakTick(r.deps);
  assert.equal(d.run, true);
  assert.equal(r.launches.length, 1);
  assert.deepEqual(r.launches[0], { repo: '/repo', sessions: 10 });
  assert.equal(r.states[0].lastAttempt?.outcome, 'started');
  assert.equal(isSoakRunning(), true);
  assert.ok(r.logs.some((l) => /^INFO starting a 10-session campaign \(60 min, fake API, zero tokens\) — no campaign has completed yet/.test(l)));
  const again = await soakTick(r.deps); // never two at once
  assert.equal(again.run, false);
  assert.equal(r.launches.length, 1);
  await r.finish(ok('PASS'));
  assert.equal(isSoakRunning(), false);
});

test('MUST-NOT-LAUNCH: unchanged code + CLI, user active, no checkout, disabled, unreadable identity', async () => {
  const done: SoakState = { schema: 1, lastCompleted: { codeId: 'code-1', cliVersion: '2.1.284', at: NOW - 24 * H, terminator: 'PASS', reportJson: '' }, lastAttempt: { at: NOW - 24 * H, outcome: 'pass' } };
  const cases: Array<[string, Rig]> = [
    ['unchanged', rig({ state: done })],
    ['no repo', rig({ repo: null })],
    ['disabled', rig({ enabled: false })],
  ];
  for (const [name, r] of cases) { const d = await soakTick(r.deps); assert.equal(d.run, false, name); assert.equal(r.launches.length, 0, name); }
  const busy = rig(); busy.setActivity(idle({ windowFocused: true }));
  assert.equal((await soakTick(busy.deps)).run, false); assert.equal(busy.launches.length, 0);
  const blind = rig(); blind.setIdentity({ codeId: null, cliVersion: '2.1.284' });
  assert.equal((await soakTick(blind.deps)).run, false); assert.equal(blind.launches.length, 0);
  assert.equal(isSoakRunning(), false);
});

test('a code change after a PASS launches again; the gate key is the identity read at LAUNCH time', async () => {
  const r = rig();
  await soakTick(r.deps);
  r.setIdentity({ codeId: 'code-2', cliVersion: '2.1.284' }); // the checkout moves while the campaign runs
  await r.finish(ok('PASS'));
  assert.equal(r.states.at(-1)!.lastCompleted?.codeId, 'code-1', 'recorded as what it actually ran, not the newer code');
  assert.equal(r.states.at(-1)!.lastCompleted?.terminator, 'PASS');
  r.setNow(NOW + 7 * H);
  const d = await soakTick(r.deps);
  assert.equal(d.run, true, 'the code moved on → another campaign');
  await r.finish(ok('PASS'));
});

test('a BREACH is ONE WARN line naming the broken budgets and the report; it also advances the gate (the campaign RAN)', async () => {
  const r = rig();
  await soakTick(r.deps);
  await r.finish(ok('FAIL', { failing: ['soak.memory.slopeMBPerMin.s3', 'soak.wedge.session.s5'] }));
  const warns = r.logs.filter((l) => l.startsWith('WARN'));
  assert.equal(warns.length, 1);
  assert.match(warns[0], /campaign BREACH — 2 budget\(s\) broken \(soak\.memory\.slopeMBPerMin\.s3, soak\.wedge\.session\.s5\) with 10 sessions — report \/soak\/r\.json/);
  assert.equal(r.states.at(-1)!.lastCompleted?.terminator, 'FAIL');
});

test('a PASS surfaces as INFO only (no warning); VOID / ABORTED / BROKE are attempts that do NOT advance the gate', async () => {
  const pass = rig(); await soakTick(pass.deps); await pass.finish(ok('PASS'));
  assert.equal(pass.logs.filter((l) => l.startsWith('WARN')).length, 0);
  assert.ok(pass.logs.some((l) => /^INFO campaign PASS/.test(l)));
  for (const term of ['VOID', 'ABORTED', 'BROKE']) {
    const r = rig(); await soakTick(r.deps); await r.finish(ok(term));
    assert.equal(r.states.at(-1)!.lastCompleted, null, `${term} must not mark the code as covered`);
    assert.equal(r.states.at(-1)!.lastAttempt?.outcome, term.toLowerCase());
    assert.equal(r.logs.filter((l) => l.startsWith('WARN')).length, 0, `${term} is not a breach`);
  }
});

test('a runner that fails to report is recorded as broke, and the scheduler is free again', async () => {
  const r = rig(); await soakTick(r.deps);
  await r.fail(new Error('spawn exploded'));
  assert.equal(r.states.at(-1)!.lastAttempt?.outcome, 'broke');
  assert.equal(r.states.at(-1)!.lastCompleted, null);
  assert.equal(isSoakRunning(), false);
  assert.ok(r.logs.some((l) => /WARN campaign runner failed to report: spawn exploded/.test(l)));
});

test('a RUNNING campaign yields when the user comes back — once per tick, with the reason — and keeps going when they stay away', async () => {
  const r = rig(); await soakTick(r.deps);
  const stay = await soakTick(r.deps);
  assert.equal(stay.run === false && stay.skip, 'campaign-running');
  assert.deepEqual(r.yields, [], 'idle user: no yield');
  r.setActivity(idle({ windowFocused: true }));
  await soakTick(r.deps);
  assert.equal(r.yields.length, 1);
  assert.match(r.yields[0], /window is focused/);
  assert.ok(r.logs.some((l) => /campaign yields to the user: the Orchestra window is focused/.test(l)));
  await r.finish(ok('ABORTED'));
  assert.equal(isSoakRunning(), false);
});
