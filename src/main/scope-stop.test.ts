import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopMemberScope, type ScopeStopDeps } from './scope-stop.ts';
import { emptyReliquatReport, type ReliquatReport, type ScopeListing, type ScopeMember, type ScopeRef } from '../shared/pause-reliquats.ts';

const mem = (pid: number, role: ScopeMember['role']): ScopeMember => ({ pid, startTicks: pid * 10, ppid: 1, comm: 'x', role });
const scope = (unit: string): ScopeRef => ({ unit, cgroupDir: `/sys/fs/cgroup/x/${unit}` });

function world(over: { scopes?: ScopeRef[] | Error; lists?: Record<string, ScopeListing[]>; rel?: Partial<ReliquatReport> | null | Error; own?: (u: string) => boolean; stopFails?: string[]; stayAfterStop?: string[]; keeperAlive?: boolean; scopesSeq?: ScopeRef[][] } = {}) {
  const calls: string[] = [];
  let lookups = 0;
  const stopped = new Set<string>();
  const lists = new Map(Object.entries(over.lists ?? {}).map(([k, v]) => [k, [...v]]));
  const deps: ScopeStopDeps = {
    scopes: () => {
      if (over.scopes instanceof Error) throw over.scopes;
      const now = over.scopesSeq ? over.scopesSeq[Math.min(lookups++, over.scopesSeq.length - 1)] : (over.scopes ?? [scope('orchestra-ws-aaa-g1.scope')]);
      return now.filter((s) => !stopped.has(s.unit) || over.stayAfterStop?.includes(s.unit));
    },
    list: (s) => {
      if (stopped.has(s.unit) && !over.stayAfterStop?.includes(s.unit)) return 'gone';
      const q = lists.get(s.unit);
      if (!q) return [];
      return q.length > 1 ? q.shift()! : q[0];
    },
    killReliquats: async () => {
      calls.push('kill');
      if (over.rel instanceof Error) throw over.rel;
      return over.rel === null ? null : { ...emptyReliquatReport(['u']), ...(over.rel ?? {}) };
    },
    stopUnit: async (u) => {
      calls.push(`stop ${u}`);
      if (over.stopFails?.includes(u)) throw new Error('Unit not loaded');
      stopped.add(u);
    },
    ownsUnit: over.own ?? ((u) => u.startsWith('orchestra-ws-aaa-')),
    keeperAlive: () => over.keeperAlive === true,
    sleep: async () => {},
    log: { info: () => {}, warn: () => {} },
  };
  return { deps, calls };
}

test('#327: no tracked scope (switch OFF, unsupported host) ⇒ null and NOTHING is killed or stopped', async () => {
  const w = world({ scopes: [] });
  assert.equal(await stopMemberScope('aaa', 'delete', w.deps), null);
  assert.deepEqual(w.calls, []);
});

test('#327: the Reliquats are killed FIRST (by identity), then each of the member\'s units is stopped and verified gone', async () => {
  const w = world({ scopes: [scope('orchestra-ws-aaa-g1.scope'), scope('orchestra-ws-aaa-g2.scope')], rel: { killed: [{ pid: 9 } as never] }, lists: { 'orchestra-ws-aaa-g1.scope': [[mem(9, 'reliquat')]], 'orchestra-ws-aaa-g2.scope': [[mem(8, 'reliquat')]] } });
  const r = await stopMemberScope('aaa', 'delete', w.deps);
  assert.deepEqual(w.calls, ['kill', 'stop orchestra-ws-aaa-g1.scope', 'stop orchestra-ws-aaa-g2.scope']);
  assert.deepEqual(r?.stopped, ['orchestra-ws-aaa-g1.scope', 'orchestra-ws-aaa-g2.scope']);
  assert.equal(r?.killed, 1);
  assert.deepEqual(r?.kept, []);
});

test('#327 fail closed: an UNKNOWN from the Reliquat kill (unreadable scope, failed lookup, no process identity) stops NO unit; neither does a throw', async () => {
  for (const rel of [{ unknown: 'scope u: cgroup.procs unreadable' }, { error: 'process identity unavailable' }, new Error('boom')]) {
    const w = world({ rel });
    const r = await stopMemberScope('aaa', 'delete', w.deps);
    assert.deepEqual(w.calls, ['kill'], 'no systemctl stop on an unknown');
    assert.ok(r?.unknown, 'and it is said');
    assert.deepEqual(r?.stopped, []);
  }
  const w2 = world({ scopes: new Error('EMFILE') });
  const r2 = await stopMemberScope('aaa', 'delete', w2.deps);
  assert.deepEqual(w2.calls, [], 'a failed scope lookup kills and stops nothing');
  assert.match(r2?.unknown ?? '', /scope lookup failed: EMFILE/);
});

test('#327 fail closed: a Reliquat REFUSED by the identity check (unreadable / changed) keeps the unit — a unit stop would kill it unchecked', async () => {
  const w = world({ rel: { refused: [{ pid: 7, comm: 'x', cmd: 'x', reason: 'identity unreadable' }] } });
  const r = await stopMemberScope('aaa', 'delete', w.deps);
  assert.deepEqual(w.calls, ['kill']);
  assert.match(r?.kept[0]?.reason ?? '', /refused/);
});

test('#327 fail closed: a scope whose cgroup.procs is unreadable is kept, not stopped', async () => {
  const w = world({ lists: { 'orchestra-ws-aaa-g1.scope': ['unreadable'] } });
  const r = await stopMemberScope('aaa', 'archive', w.deps);
  assert.deepEqual(w.calls, ['kill']);
  assert.match(r?.kept[0]?.reason ?? '', /unreadable/);
});

test('#327: a LIVE session of the member in a scope (a restart started a new generation while we worked) is not ours to stop — the old generation still is', async () => {
  const w = world({
    scopes: [scope('orchestra-ws-aaa-old.scope'), scope('orchestra-ws-aaa-new.scope')],
    lists: { 'orchestra-ws-aaa-old.scope': [[mem(5, 'reliquat')]], 'orchestra-ws-aaa-new.scope': [[mem(20, 'keeper'), mem(21, 'cli'), mem(22, 'session')]] },
  });
  const r = await stopMemberScope('aaa', 'clear', w.deps);
  assert.deepEqual(w.calls, ['kill', 'stop orchestra-ws-aaa-old.scope'], 'the new generation\'s unit is never stopped');
  assert.deepEqual(r?.stopped, ['orchestra-ws-aaa-old.scope']);
  assert.match(r?.kept[0]?.reason ?? '', /live session/);
});

test('#327: a unit that does not parse as THIS workspace\'s own is never stopped, whatever the lookup returned', async () => {
  const w = world({ scopes: [scope('orchestra-ws-bbb-g1.scope'), scope('orchestra-ws-aaa-g1.scope')] });
  const r = await stopMemberScope('aaa', 'delete', w.deps);
  assert.deepEqual(w.calls, ['kill', 'stop orchestra-ws-aaa-g1.scope']);
  assert.match(r?.kept.find((k) => k.unit === 'orchestra-ws-bbb-g1.scope')?.reason ?? '', /not a scope of this workspace/);
});

test('#327: a failing `systemctl stop` and a unit that stays listed are reported, never thrown; an already-gone unit counts as stopped without a stop call', async () => {
  const fails = world({ stopFails: ['orchestra-ws-aaa-g1.scope'] });
  const r1 = await stopMemberScope('aaa', 'delete', fails.deps);
  assert.match(r1?.kept[0]?.reason ?? '', /systemctl stop failed: Unit not loaded/);
  assert.equal(r1?.kept.length, 1, 'reported ONCE, and not then waited on as if it had been stopped');
  assert.deepEqual(r1?.stopped, []);
  const stays = world({ stayAfterStop: ['orchestra-ws-aaa-g1.scope'] });
  const r2 = await stopMemberScope('aaa', 'delete', stays.deps);
  assert.match(r2?.kept[0]?.reason ?? '', /still listed after systemctl stop/);
  const gone = world({ lists: { 'orchestra-ws-aaa-g1.scope': ['gone'] } });
  const r3 = await stopMemberScope('aaa', 'delete', gone.deps);
  assert.deepEqual(gone.calls, ['kill'], 'every process died with the kill: nothing left to stop');
  assert.deepEqual(r3?.stopped, ['orchestra-ws-aaa-g1.scope']);
});

test("#327: while the member's keeper is still ALIVE nothing is killed or stopped — the detached jobs of a RUNNING member are not Reliquats (the caller must stop the session first)", async () => {
  const w = world({ keeperAlive: true });
  const r = await stopMemberScope('aaa', 'archive', w.deps);
  assert.deepEqual(w.calls, []);
  assert.match(r?.unknown ?? '', /keeper is still alive/);
});

test('#327: the units to stop come from a FRESH lookup AFTER the kill — one that appeared meanwhile is stopped, one that vanished is not asked for', async () => {
  const g1 = scope('orchestra-ws-aaa-g1.scope');
  const g2 = scope('orchestra-ws-aaa-g2.scope');
  const appeared = world({ scopesSeq: [[g1], [g1, g2]] });
  const r1 = await stopMemberScope('aaa', 'delete', appeared.deps);
  assert.deepEqual(appeared.calls, ['kill', `stop ${g1.unit}`, `stop ${g2.unit}`]);
  assert.deepEqual(r1?.scopes, [g1.unit, g2.unit]);
  const vanished = world({ scopesSeq: [[g1, g2], [g1]] });
  const r2 = await stopMemberScope('aaa', 'delete', vanished.deps);
  assert.deepEqual(vanished.calls, ['kill', `stop ${g1.unit}`], 'a generation that is gone by the fresh lookup is not stopped');
  assert.deepEqual(r2?.stopped, [g1.unit]);
});
