import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopMemberScope, type ScopeStopDeps } from './scope-stop.ts';
import { emptyReliquatReport, type ReliquatKilled, type ReliquatReport, type ScopeListing, type ScopeMember, type ScopeRef } from '../shared/pause-reliquats.ts';

const mem = (pid: number, role: ScopeMember['role']): ScopeMember => ({ pid, startTicks: pid * 10, ppid: 1, comm: 'x', role });
const scope = (unit: string): ScopeRef => ({ unit, cgroupDir: `/sys/fs/cgroup/x/${unit}` });
const killed = (pid: number, outcome: ReliquatKilled['outcome']): ReliquatKilled => ({ pid, startTicks: pid * 10, comm: 'x', cmd: 'x', cwd: null, startedAt: 0, scope: 'u', outcome });
const G1 = 'orchestra-ws-aaa-g1.scope';
const G2 = 'orchestra-ws-aaa-g2.scope';

interface WorldOpts {
  scopes?: ScopeRef[] | Error;
  /** successive `scopes()` answers (the last one repeats) */
  scopesSeq?: Array<ScopeRef[] | Error>;
  lists?: Record<string, ScopeListing[]>;
  rel?: Partial<ReliquatReport> | null | Error;
  own?: (u: string) => boolean;
  stopFails?: string[];
  stayAfterStop?: string[];
  liveUnit?: string | null | 'unknown' | Error;
}

function world(over: WorldOpts = {}) {
  const calls: string[] = [];
  const warns: string[] = [];
  const infos: string[] = [];
  let lookups = 0;
  const stopped = new Set<string>();
  const lists = new Map(Object.entries(over.lists ?? {}).map(([k, v]) => [k, [...v]]));
  const deps: ScopeStopDeps = {
    scopes: () => {
      if (over.scopes instanceof Error) throw over.scopes;
      const now = over.scopesSeq ? over.scopesSeq[Math.min(lookups++, over.scopesSeq.length - 1)] : (over.scopes ?? [scope(G1)]);
      if (now instanceof Error) throw now;
      return now.filter((s) => !stopped.has(s.unit) || over.stayAfterStop?.includes(s.unit));
    },
    list: (s) => {
      if (stopped.has(s.unit) && !over.stayAfterStop?.includes(s.unit)) return 'gone';
      const q = lists.get(s.unit);
      if (!q) return [];
      return q.length > 1 ? q.shift()! : q[0];
    },
    killReliquats: async (only) => {
      calls.push(`kill ${only.map((s) => s.unit).join(',')}`);
      if (over.rel instanceof Error) throw over.rel;
      return over.rel === null ? null : { ...emptyReliquatReport(only.map((s) => s.unit)), ...(over.rel ?? {}) };
    },
    stopUnit: async (u) => {
      calls.push(`stop ${u}`);
      if (over.stopFails?.includes(u)) throw new Error('Unit not loaded');
      stopped.add(u);
    },
    ownsUnit: over.own ?? ((u) => u.startsWith('orchestra-ws-aaa-')),
    liveKeeperUnit: () => {
      if (over.liveUnit instanceof Error) throw over.liveUnit;
      return over.liveUnit ?? null;
    },
    sleep: async () => {},
    log: { info: (m) => infos.push(m), warn: (m) => warns.push(m) },
  };
  return { deps, calls, warns, infos };
}

test('#327: no tracked scope (switch OFF, unsupported host) ⇒ null and NOTHING is killed or stopped', async () => {
  const w = world({ scopes: [] });
  assert.equal(await stopMemberScope('aaa', 'delete', w.deps), null);
  assert.deepEqual(w.calls, []);
});

test("#327: the Reliquats are killed FIRST (by identity), then each of the member's units is stopped and verified gone; only EXITED Reliquats count as killed, the survivors are said", async () => {
  const w = world({
    scopes: [scope(G1), scope(G2)],
    rel: { killed: [killed(9, 'exited'), killed(8, 'survived')], survivors: [{ pid: 8, comm: 'stubborn', cmd: 'stubborn', reason: 'x' } as never] },
    lists: { [G1]: [[mem(9, 'reliquat')]], [G2]: [[mem(8, 'reliquat')]] },
  });
  const r = await stopMemberScope('aaa', 'delete', w.deps);
  assert.deepEqual(w.calls, [`kill ${G1},${G2}`, `stop ${G1}`, `stop ${G2}`]);
  assert.deepEqual(r?.stopped, [G1, G2]);
  assert.equal(r?.killed, 1, 'the one that survived is NOT counted as killed (m2)');
  assert.equal(r?.survivors, 1);
  assert.deepEqual(r?.kept, []);
  assert.ok(w.warns.some((m) => /1 Reliquat\(s\) still alive after the kill rounds: 8:stubborn/.test(m)), `survivors are logged: ${w.warns.join(' | ')}`);
  assert.ok(w.infos.some((m) => /killed 1 \(\+1 survivor\(s\)\), stopped 2\/2/.test(m)), w.infos.join(' | '));
});

test('#327 fail closed: an UNKNOWN from the Reliquat kill (unreadable scope, failed lookup, no process identity, a throw, NO report) stops NO unit', async () => {
  for (const rel of [{ unknown: 'scope u: cgroup.procs unreadable' }, { error: 'process identity unavailable' }, new Error('boom'), null]) {
    const w = world({ rel });
    const r = await stopMemberScope('aaa', 'delete', w.deps);
    assert.deepEqual(w.calls, [`kill ${G1}`], 'no systemctl stop on an unknown');
    assert.ok(r?.unknown, 'and it is said');
    assert.deepEqual(r?.stopped, []);
  }
  const thrown = await stopMemberScope('aaa', 'delete', world({ rel: new Error('boom') }).deps);
  assert.match(thrown?.unknown ?? '', /Reliquat kill failed: boom/, 'a THROWN kill says why');
  const noReport = await stopMemberScope('aaa', 'delete', world({ rel: null }).deps);
  assert.match(noReport?.unknown ?? '', /returned no report/);
  const w2 = world({ scopes: new Error('EMFILE') });
  const r2 = await stopMemberScope('aaa', 'delete', w2.deps);
  assert.deepEqual(w2.calls, [], 'a failed scope lookup kills and stops nothing');
  assert.match(r2?.unknown ?? '', /scope lookup failed: EMFILE/);
});

test('#327 fail closed: a Reliquat REFUSED by the identity check (unreadable / changed) keeps the unit — a unit stop would kill it unchecked', async () => {
  const w = world({ rel: { refused: [{ pid: 7, comm: 'x', cmd: 'x', reason: 'identity unreadable' } as never] } });
  const r = await stopMemberScope('aaa', 'delete', w.deps);
  assert.deepEqual(w.calls, [`kill ${G1}`]);
  assert.match(r?.kept[0]?.reason ?? '', /refused/);
  assert.deepEqual(r?.stopped, []);
});

test('#327 fail closed: a scope whose cgroup.procs is UNREADABLE is kept untouched — and with no other scope nothing is killed at all', async () => {
  const w = world({ lists: { [G1]: ['unreadable'] } });
  const r = await stopMemberScope('aaa', 'delete', w.deps);
  assert.deepEqual(w.calls, []);
  assert.match(r?.kept[0]?.reason ?? '', /unreadable/);
});

test('#327 m3/m1: a scope holding a LIVE member (keeper / cli / session in its listing) is NEVER touched — its Reliquat kill and its unit stop are skipped — while the member\'s dead generation beside it IS killed and stopped', async () => {
  for (const role of ['keeper', 'cli', 'session'] as const) {
    const w = world({ scopes: [scope(G1), scope(G2)], lists: { [G1]: [[mem(1, 'reliquat')]], [G2]: [[mem(2, role), mem(3, 'reliquat')]] } });
    const r = await stopMemberScope('aaa', 'clear', w.deps);
    assert.deepEqual(w.calls, [`kill ${G1}`, `stop ${G1}`], `${role}: only the dead generation is acted on`);
    assert.deepEqual(r?.stopped, [G1]);
    assert.match(r?.kept.find((k) => k.unit === G2)?.reason ?? '', /live session of this member runs in it/);
  }
  const allLive = world({ lists: { [G1]: [[mem(2, 'keeper')]] } });
  const r2 = await stopMemberScope('aaa', 'clear', allLive.deps);
  assert.deepEqual(allLive.calls, [], 'every scope live ⇒ no kill, no stop');
  assert.deepEqual(r2?.stopped, []);
});

test("#327 m1: the TRACKED keeper's unit is live even when its listing shows no keeper role (an unclassified keeper); a keeper that cannot be placed ⇒ nothing at all is touched", async () => {
  const w = world({ scopes: [scope(G1), scope(G2)], liveUnit: G2, lists: { [G1]: [[mem(1, 'reliquat')]], [G2]: [[mem(3, 'reliquat')]] } });
  const r = await stopMemberScope('aaa', 'archive', w.deps);
  assert.deepEqual(w.calls, [`kill ${G1}`, `stop ${G1}`], "the keeper's own unit keeps its detached jobs");
  assert.match(r?.kept.find((k) => k.unit === G2)?.reason ?? '', /live session/);
  for (const liveUnit of ['unknown', new Error('proc')] as const) {
    const u = world({ liveUnit });
    const ru = await stopMemberScope('aaa', 'archive', u.deps);
    assert.deepEqual(u.calls, [], 'unplaceable keeper ⇒ fail closed');
    assert.match(ru?.unknown ?? '', /cannot be placed/);
  }
});

test('#327: a unit the workspace does not own is never killed in nor stopped', async () => {
  const w = world({ scopes: [scope(G1), scope('orchestra-ws-bbb-g1.scope')] });
  const r = await stopMemberScope('aaa', 'delete', w.deps);
  assert.deepEqual(w.calls, [`kill ${G1}`, `stop ${G1}`]);
  assert.match(r?.kept.find((k) => k.unit === 'orchestra-ws-bbb-g1.scope')?.reason ?? '', /not a scope of this workspace/);
});

test('#327: a failing `systemctl stop` and a unit that stays listed are reported, never thrown; an already-gone unit counts as stopped without a stop call', async () => {
  const fails = world({ stopFails: [G1] });
  const r1 = await stopMemberScope('aaa', 'delete', fails.deps);
  assert.match(r1?.kept[0]?.reason ?? '', /systemctl stop failed: Unit not loaded/);
  assert.equal(r1?.kept.length, 1, 'reported ONCE, and not then waited on as if it had been stopped');
  assert.deepEqual(r1?.stopped, []);
  const stays = world({ stayAfterStop: [G1] });
  const r2 = await stopMemberScope('aaa', 'delete', stays.deps);
  assert.match(r2?.kept[0]?.reason ?? '', /still listed after systemctl stop/);
  const gone = world({ lists: { [G1]: ['gone'] } });
  const r3 = await stopMemberScope('aaa', 'delete', gone.deps);
  assert.deepEqual(gone.calls, [], 'already gone: nothing to kill, nothing to stop');
  assert.deepEqual(r3?.stopped, [G1]);
});

test('#327: the lookup AFTER the kill — a unit systemd removed (the kill emptied it) counts as stopped; one that appeared is reported kept, not stopped; a failed lookup is UNKNOWN', async () => {
  const emptied = world({ scopesSeq: [[scope(G1)], []], rel: { killed: [killed(9, 'exited')] } });
  const r0 = await stopMemberScope('aaa', 'delete', emptied.deps);
  assert.deepEqual(emptied.calls, [`kill ${G1}`], 'nothing left to stop');
  assert.deepEqual(r0?.stopped, [G1], 'never "stopped 0/1"');
  assert.deepEqual(r0?.kept, []);
  const appeared = world({ scopesSeq: [[scope(G1)], [scope(G1), scope(G2)]] });
  const r1 = await stopMemberScope('aaa', 'delete', appeared.deps);
  assert.deepEqual(appeared.calls, [`kill ${G1}`, `stop ${G1}`], 'the newcomer was not examined by the kill: not stopped');
  assert.match(r1?.kept.find((k) => k.unit === G2)?.reason ?? '', /appeared after the lookup/);
  assert.deepEqual(r1?.scopes, [G1, G2]);
  const vanished = world({ scopesSeq: [[scope(G1), scope(G2)], [scope(G1)]] });
  const r2 = await stopMemberScope('aaa', 'delete', vanished.deps);
  assert.deepEqual(vanished.calls, [`kill ${G1},${G2}`, `stop ${G1}`], 'a generation that is gone by the fresh lookup is not asked to stop');
  assert.deepEqual([...(r2?.stopped ?? [])].sort(), [G1, G2], '...but it IS counted stopped (it is gone)');
  const foreign = world({ scopesSeq: [[scope(G1)], []], own: () => false });
  assert.deepEqual((await stopMemberScope('aaa', 'delete', foreign.deps))?.stopped, [], 'a unit the workspace does not own is never claimed');
  const lookupFails = world({ scopesSeq: [[scope(G1)], new Error('EIO')] });
  const r3 = await stopMemberScope('aaa', 'delete', lookupFails.deps);
  assert.deepEqual(lookupFails.calls, [`kill ${G1}`]);
  assert.match(r3?.unknown ?? '', /scope lookup failed after the kill: EIO/);
  assert.deepEqual(r3?.stopped, []);
});

test('#327: a live member that appears in a dead scope DURING the kill keeps its unit — the listing is re-read right before each stop', async () => {
  const w = world({ lists: { [G1]: [[mem(1, 'reliquat')], [mem(2, 'keeper')]] } });
  const r = await stopMemberScope('aaa', 'delete', w.deps);
  assert.deepEqual(w.calls, [`kill ${G1}`], 'no systemctl stop');
  assert.match(r?.kept[0]?.reason ?? '', /came up meanwhile/);
  assert.deepEqual(r?.stopped, []);
});
