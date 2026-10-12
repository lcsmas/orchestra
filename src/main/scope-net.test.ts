import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createScopeNet, needleFor, type ScopeNetDeps } from './scope-net.ts';
import type { KernelOomKill, MemKillRecord } from '../shared/memory-scope.ts';

const SLICE = '/user.slice/user-1000.slice/user@1000.service/app.slice';
const U = 'orchestra-ws-ab12-mv0s5wm6.scope';
const U2 = 'orchestra-ws-cd34-mv0s5wm9.scope';
const GIB = 1024 ** 3;
const kline = (unit: string, over: Partial<KernelOomKill> & { oom?: string; task?: string } = {}): KernelOomKill => ({
  atMs: 5_000,
  pid: 100,
  comm: 'node-22',
  oomMemcg: over.oom ?? `${SLICE}/${unit}`,
  taskMemcg: over.task ?? `${SLICE}/${unit}/k`,
  ...over,
});

interface Rig {
  deps: ScopeNetDeps;
  delivered: Array<{ wsId: string; rec: MemKillRecord }>;
  logs: string[];
  reads: number[];
  sleeps: number[];
  timers: Array<() => void>;
  journal: { lines: KernelOomKill[] | null; failFrom: number };
  alive: Set<string>;
  deliverFails: { n: number };
  ledgerFile: string;
}

function rig(ledgerFile?: string): Rig {
  const dir = ledgerFile ? path.dirname(ledgerFile) : fs.mkdtempSync(path.join(os.tmpdir(), 'scope-net-'));
  const file = ledgerFile ?? path.join(dir, 'memscopes.json');
  const r: Rig = { delivered: [], logs: [], reads: [], sleeps: [], timers: [], journal: { lines: [], failFrom: -1 }, alive: new Set(), deliverFails: { n: 0 }, ledgerFile: file, deps: null as never };
  r.deps = {
    ledgerFile: file,
    now: () => 10_000,
    readKernelKills: async (since) => {
      r.reads.push(since);
      return r.journal.lines;
    },
    scopeAlive: (u) => r.alive.has(u),
    deliver: (wsId, rec) => {
      if (r.deliverFails.n > 0) {
        r.deliverFails.n -= 1;
        throw new Error('bus down');
      }
      r.delivered.push({ wsId, rec });
    },
    sleep: async (ms) => {
      r.sleeps.push(ms);
    },
    log: { info: (m) => r.logs.push(m), warn: (m) => r.logs.push(m) },
    setTimer: (fn) => {
      r.timers.push(fn);
      return {};
    },
  };
  return r;
}
const note = (sn: ReturnType<typeof createScopeNet>, unit = U, wsId = 'ab12') => sn.note(unit, { wsId, startedAt: 1_000, hardBytes: 6 * GIB, backstopBytes: 7 * GIB });

test('#343 H1: a keeper-leaf kill in the kernel log is reported ONCE with the session flag — a second end, an `exit` AND a `close`, add nothing', async () => {
  const r = rig();
  const sn = createScopeNet(r.deps);
  note(sn);
  r.journal.lines = [kline(U)];
  await Promise.all([sn.sessionEnded('ab12'), sn.sessionEnded('ab12')]);
  await sn.sessionEnded('ab12');
  assert.equal(r.delivered.length, 1, 'one notice, one coordinator message');
  assert.equal(r.reads.length, 1, 'ONE journal read for the three triggers: the second and third find the unit closed (per-workspace chain; a mutant that runs them side by side reads twice)');
  assert.equal(sn.ledger()[U].done, true, 'told + the scope is gone ⇒ closed at once');
  const { wsId, rec } = r.delivered[0];
  assert.equal(wsId, 'ab12');
  assert.equal(rec.level, 'net');
  assert.equal(rec.net!.sessionEnded, true);
  assert.equal(rec.hardBytes, 6 * GIB);
  assert.equal(rec.net!.backstopBytes, 7 * GIB);
  assert.equal(r.logs.filter((l) => /SCOPE BACKSTOP kill/.test(l)).length, 1, 'one log line');
  assert.deepEqual(sn.ledger()[U].reported, ['5000:100']);
});

test('#343 H2: reported once ACROSS an app restart — a new instance on the same ledger really LOOKS again (the scope is still alive, so the unit is not done) and tells nothing; a NEW kernel line is still told', async () => {
  const r = rig();
  r.alive.add(U); // the scope outlives the session (Reliquats, or a keeper that stayed): the unit is NOT done
  const a = createScopeNet(r.deps);
  note(a);
  r.journal.lines = [kline(U)];
  await a.sessionEnded('ab12');
  assert.equal(r.delivered.length, 1);
  assert.equal(a.ledger()[U].done, false);
  const r2 = rig(r.ledgerFile);
  r2.alive.add(U);
  r2.journal.lines = [kline(U)];
  const b = createScopeNet(r2.deps);
  assert.deepEqual(b.ledger()[U].reported, ['5000:100'], 'the ledger survived the restart (written to disk, not kept in memory)');
  await b.sessionEnded('ab12');
  await b.sweep(() => true);
  assert.ok(r2.reads.length >= 1, 'non-vacuous: the restarted app DID read the journal');
  assert.equal(r2.delivered.length, 0, 'the restarted app does not tell it again');
  r2.journal.lines = [kline(U), kline(U, { atMs: 9_000, pid: 222, comm: 'claude' })];
  await b.sessionEnded('ab12');
  assert.equal(r2.delivered.length, 1, 'a NEW line is still told');
  assert.equal(r2.delivered[0].rec.pid, 222);
});

test('#343 H3: a delivery that fails (bus down) stays OWED, is retried by the timer, and is told exactly once when it goes through', async () => {
  const r = rig();
  const sn = createScopeNet(r.deps);
  note(sn);
  r.journal.lines = [kline(U)];
  r.deliverFails.n = 2;
  await sn.sessionEnded('ab12');
  assert.equal(r.delivered.length, 0);
  assert.equal(r.timers.length, 1, 'a retry is scheduled');
  assert.deepEqual(sn.ledger()[U].reported, [], 'not marked reported');
  r.timers.shift()!();
  await new Promise((res) => setImmediate(res));
  await new Promise((res) => setImmediate(res));
  assert.equal(r.delivered.length, 0, 'second attempt failed too');
  assert.equal(r.timers.length, 1);
  r.timers.shift()!();
  await new Promise((res) => setImmediate(res));
  await new Promise((res) => setImmediate(res));
  assert.equal(r.delivered.length, 1);
  assert.equal(r.logs.filter((l) => /SCOPE BACKSTOP kill/.test(l)).length, 1, 'the log line is written once, not per attempt');
  assert.deepEqual(sn.ledger()[U].reported, ['5000:100']);
});

test('#343 H4: the journal lags the kill — the line shows up on a later attempt and is still found; the waits are the declared schedule', async () => {
  const r = rig();
  const sn = createScopeNet({ ...r.deps, attemptDelaysMs: [10, 20, 30] });
  note(sn);
  let calls = 0;
  r.deps.readKernelKills = async () => {
    calls += 1;
    return calls >= 3 ? [kline(U)] : [];
  };
  const sn2 = createScopeNet({ ...r.deps, attemptDelaysMs: [10, 20, 30] });
  await sn2.sessionEnded('ab12');
  assert.equal(calls >= 3, true);
  assert.equal(r.delivered.length, 1);
  assert.deepEqual(r.sleeps.slice(0, 3), [10, 20, 30]);
  void sn;
});

test('#343 H5: nothing found + the scope is gone ⇒ the unit is DONE (no more journal reads for it); a LIVE scope is never marked done', async () => {
  const r = rig();
  const sn = createScopeNet(r.deps);
  note(sn);
  note(sn, U2, 'cd34');
  r.alive.add(U2);
  await sn.sessionEnded('ab12');
  await sn.sessionEnded('cd34');
  assert.equal(sn.ledger()[U].done, true);
  assert.equal(sn.ledger()[U2].done, false, 'a live scope may still be hit');
  const before = r.reads.length;
  await sn.sessionEnded('ab12');
  assert.equal(r.reads.length, before, 'done ⇒ not read again');
});

test('#343 H6: an UNREADABLE journal is UNKNOWN, not « nothing happened »: nothing delivered, nothing marked done, ONE warning', async () => {
  const r = rig();
  const sn = createScopeNet(r.deps);
  note(sn);
  r.journal.lines = null;
  await sn.sessionEnded('ab12');
  await sn.sessionEnded('ab12');
  assert.equal(r.delivered.length, 0);
  assert.equal(sn.ledger()[U].done, false);
  assert.equal(r.logs.filter((l) => /unreadable by this user/.test(l)).length, 1);
  r.journal.lines = [kline(U)];
  const again = createScopeNet(r.deps);
  await again.sweep(() => true);
  assert.equal(r.delivered.length, 1, 'a later start with a readable journal still finds it');
});

test('#343 H7: only THIS unit\'s backstop lines count — a tool-leaf kill (the Plafond at work), another member\'s scope and an old line are ignored', async () => {
  const r = rig();
  const sn = createScopeNet(r.deps);
  sn.note(U, { wsId: 'ab12', startedAt: 100_000, hardBytes: 6 * GIB, backstopBytes: 7 * GIB });
  r.journal.lines = [
    kline(U, { atMs: 120_000, oom: `${SLICE}/${U}/w`, task: `${SLICE}/${U}/w` }),
    kline(U2, { atMs: 120_000 }),
    kline(U, { atMs: 5_000 }), // before the scope existed (a recycled name from an earlier life)
  ];
  await sn.sessionEnded('ab12');
  assert.equal(r.delivered.length, 0);
});

test('#343 H8: boot sweep — ONE journal read for every workspace with something pending; live scopes skipped; a deleted workspace is closed without a word', async () => {
  const r = rig();
  const sn = createScopeNet(r.deps);
  note(sn);
  note(sn, U2, 'cd34');
  sn.note('orchestra-ws-ef56-mv0s5wma.scope', { wsId: 'ef56', startedAt: 1_000, hardBytes: 1, backstopBytes: 2 });
  sn.note('orchestra-ws-gh78-mv0s5wmb.scope', { wsId: 'gh78', startedAt: 1_000, hardBytes: 1, backstopBytes: 2 });
  r.alive.add('orchestra-ws-gh78-mv0s5wmb.scope');
  r.journal.lines = [kline(U), kline(U2, { pid: 300 }), kline('orchestra-ws-ef56-mv0s5wma.scope', { pid: 400 }), kline('orchestra-ws-gh78-mv0s5wmb.scope', { pid: 500 })];
  await sn.sweep((id) => id !== 'ef56');
  assert.equal(r.reads.length, 1, 'one read');
  assert.deepEqual(r.delivered.map((d) => d.wsId).sort(), ['ab12', 'cd34'], 'the live scope\'s kill is left to its own session end; the deleted workspace is not told');
  assert.equal(sn.ledger()['orchestra-ws-ef56-mv0s5wma.scope'].done, true);
  assert.equal(sn.ledger()['orchestra-ws-gh78-mv0s5wmb.scope'].done, false);
  assert.ok(r.delivered.every((d) => d.rec.net!.sessionEnded), 'a scope that is gone is a session that ended');
});

test('#343 H9: a corrupt ledger starts empty with a warning; the ledger is bounded and drops FINISHED scopes first, then the oldest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-net-'));
  const file = path.join(dir, 'memscopes.json');
  fs.writeFileSync(file, '{not json');
  const r = rig(file);
  const sn = createScopeNet(r.deps);
  assert.ok(r.logs.some((l) => /ledger .* unreadable/.test(l)));
  // 3 finished scopes, then 200 open ones: the finished ones must be the first to go, whatever their age
  for (let i = 0; i < 3; i++) {
    const u = `orchestra-ws-done${i}-mv0s5wm6.scope`;
    sn.note(u, { wsId: `done${i}`, startedAt: 1, hardBytes: 1, backstopBytes: 2 });
    r.journal.lines = [];
    await sn.sessionEnded(`done${i}`); // nothing found + scope gone ⇒ done
    assert.equal(sn.ledger()[u].done, true, `precondition: ${u} is finished`);
  }
  for (let i = 0; i < 200; i++) sn.note(`orchestra-ws-w${i}-mv0s5wm6.scope`, { wsId: `w${i}`, startedAt: 1, hardBytes: 1, backstopBytes: 2 });
  const keys = Object.keys(sn.ledger());
  assert.equal(keys.length, 200);
  assert.ok(!keys.some((k) => k.includes('done')), 'the three finished scopes were evicted first');
  assert.ok(keys.includes('orchestra-ws-w0-mv0s5wm6.scope') && keys.includes('orchestra-ws-w199-mv0s5wm6.scope'), 'every open scope survived');
  for (let i = 200; i < 230; i++) sn.note(`orchestra-ws-w${i}-mv0s5wm6.scope`, { wsId: `w${i}`, startedAt: 1, hardBytes: 1, backstopBytes: 2 });
  const after = Object.keys(sn.ledger());
  assert.equal(after.length, 200);
  assert.ok(!after.includes('orchestra-ws-w0-mv0s5wm6.scope') && after.includes('orchestra-ws-w229-mv0s5wm6.scope'), 'with no finished scope left, the OLDEST goes');
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).length <= 200);
});

test('#343 H10: a workspace with no remembered scope costs nothing — no journal read for a member that was never capped', async () => {
  const r = rig();
  const sn = createScopeNet(r.deps);
  await sn.sessionEnded('uncapped-ws');
  assert.equal(r.reads.length, 0);
});

test('#343 H11: the first look WAITS for the burst — the keeper and the CLI are killed within ms of each other; the report is ONE record naming both victims, not two messages', async () => {
  const r = rig();
  const sn = createScopeNet(r.deps);
  note(sn);
  const first = kline(U, { atMs: 5_000, pid: 100, comm: 'claude' });
  const second = kline(U, { atMs: 5_020, pid: 101, comm: 'node-22' });
  r.journal.lines = [first]; // what the journal holds the instant the CLI exits…
  r.deps.sleep = async (ms) => {
    r.sleeps.push(ms);
    if (ms >= 300) r.journal.lines = [first, second]; // …and what it holds half a second later
  };
  const sn2 = createScopeNet(r.deps);
  void sn;
  await sn2.sessionEnded('ab12');
  assert.equal(r.delivered.length, 1, 'ONE report for the burst');
  assert.deepEqual(r.delivered[0].rec.net!.victims.map((v) => v.comm), ['claude', 'node-22']);
  assert.ok(r.sleeps[0] >= 300, 'the first read comes AFTER a wait');
});

test('#343 H12: the journal is grepped for the units asked about (the window is hours or days; an unfiltered read can overflow its buffer and read as « unreadable »)', async () => {
  assert.equal(needleFor([U]), 'orchestra-ws-ab12-mv0s5wm6\\.scope', 'dots escaped: they are regex metacharacters');
  assert.equal(needleFor([U, U2]), 'orchestra-ws-ab12-mv0s5wm6\\.scope|orchestra-ws-cd34-mv0s5wm9\\.scope');
  const many = Array.from({ length: 12 }, (_, i) => `orchestra-ws-w${i}-mv0s5wm6.scope`);
  assert.equal(needleFor(many), 'orchestra-ws-w', 'past 8 units: their common prefix');
  assert.equal(needleFor(['a.scope', 'b.scope', 'c.scope', 'd.scope', 'e.scope', 'f.scope', 'g.scope', 'h.scope', 'i.scope']), '', 'nothing in common ⇒ an empty group, which matches every line');
  const r = rig();
  const asked: Array<string | undefined> = [];
  r.deps.readKernelKills = async (_since, needle) => {
    asked.push(needle);
    return [kline(U)];
  };
  const sn = createScopeNet({ ...r.deps, attemptDelaysMs: [0] });
  note(sn);
  await sn.sessionEnded('ab12');
  assert.deepEqual(asked, [needleFor([U])], 'a session end asks about ITS units only');
  const r2 = rig();
  const asked2: Array<string | undefined> = [];
  r2.deps.readKernelKills = async (_s, needle) => {
    asked2.push(needle);
    return [];
  };
  const sw = createScopeNet(r2.deps);
  note(sw);
  note(sw, U2, 'cd34');
  await sw.sweep(() => true);
  assert.equal(asked2.length, 1);
  assert.equal(asked2[0], needleFor([U, U2]), 'the sweep asks about every pending unit in ONE read');
});
