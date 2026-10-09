// The keeper's kill watch against a VIRTUAL cgroup + /proc (every read goes through `readFile`): a kill is a counter move plus a member that vanished.
// The real thing — a real scope, a real OOM kill — is scripts/e2e-memory-cap.mjs; this pins the decision logic and its edges without systemd.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPageSize, startMemoryWatch } from './memory-watch.ts';
import type { KernelOomKill, MemKillRecord, MemSoftRecord } from '../shared/memory-scope.ts';

const DIR = '/vcg/scope';
type Proc = { start: number; comm: string; cmdline: string; rssPages: number; adj: number };

class World {
  procs = new Map<number, Proc>();
  events = { high: 0, max: 0, oom: 0, oom_kill: 0, oom_group_kill: 0 };
  maxBytes = 300 * 1024 * 1024;
  current = 100 * 1024 * 1024;
  /** Reclaimable page cache inside `current` (memory.stat inactive_file). */
  inactiveFile = 0;
  add(pid: number, p: Partial<Proc> & { comm: string }): void {
    this.procs.set(pid, { start: pid * 7, cmdline: p.comm, rssPages: 100, adj: 0, ...p });
  }
  /** What the kernel does: kill the process and count it. */
  oomKill(pid: number, { hard = true } = {}): void {
    this.procs.delete(pid);
    this.events.oom_kill += 1;
    if (hard) this.events.oom += 1;
  }
  read = (p: string): string => {
    if (p === `${DIR}/memory.events`) return Object.entries(this.events).map(([k, v]) => `${k} ${v}`).join('\n') + '\n';
    if (p === `${DIR}/cgroup.procs`) return [...this.procs.keys()].join('\n') + '\n';
    if (p === `${DIR}/memory.max`) return `${this.maxBytes}\n`;
    if (p === `${DIR}/memory.current`) return `${this.current}\n`;
    if (p === `${DIR}/memory.stat`) return `anon ${Math.max(0, this.current - this.inactiveFile)}\ninactive_file ${this.inactiveFile}\nactive_file 0\n`;
    const m = /^\/proc\/(\d+)\/(stat|statm|cmdline|oom_score_adj)$/.exec(p);
    if (m) {
      const proc = this.procs.get(Number(m[1]));
      if (!proc) throw new Error('ENOENT');
      if (m[2] === 'stat') return `${m[1]} (${proc.comm}) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${proc.start} 1000000 ${proc.rssPages}\n`;
      if (m[2] === 'statm') return `1000 ${proc.rssPages} 10 1 0 1 0\n`;
      if (m[2] === 'cmdline') return proc.cmdline.split(' ').join('\0') + '\0';
      return `${proc.adj}\n`;
    }
    throw new Error(`ENOENT ${p}`);
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 2000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await wait(5);
  }
  return pred();
}

function watch(w: World, kills: MemKillRecord[], extra: Partial<Parameters<typeof startMemoryWatch>[0]> = {}) {
  return startMemoryWatch({ cgroupDir: DIR, unit: 'u.scope', onKill: (r) => kills.push(r), log: () => {}, readFile: w.read, hotMs: 5, fastMs: 5, idleMs: 5, pageSize: 4096, ...extra });
}

test('a kill is named: the member that vanished when oom_kill moved, ranked by the kernel badness (a +1000 tool beats a bigger adj-0 CLI)', async () => {
  const w = new World();
  w.add(10, { comm: 'node', cmdline: 'node keeper.js ws', rssPages: 15_000 });
  w.add(11, { comm: 'claude', cmdline: 'claude --output-format stream-json', rssPages: 30_000 });
  w.add(12, { comm: 'python3', cmdline: 'python3 hog.py 400', rssPages: 20_000, adj: 1000 });
  const kills: MemKillRecord[] = [];
  const mw = watch(w, kills);
  await wait(40); // a few snapshots
  w.oomKill(12);
  assert.ok(await until(() => kills.length === 1), 'the kill is reported');
  assert.equal(kills[0].command, 'python3 hog.py 400');
  assert.equal(kills[0].pid, 12);
  assert.equal(kills[0].level, 'hard');
  assert.equal(kills[0].seq, 1);
  assert.equal(kills[0].unit, 'u.scope');
  assert.equal(kills[0].hardBytes, w.maxBytes);
  mw.stop();
});

test('the same kill is reported ONCE (the inotify callback and the tick both look)', async () => {
  const w = new World();
  w.add(12, { comm: 'hog', cmdline: 'hog', adj: 1000, rssPages: 9000 });
  const kills: MemKillRecord[] = [];
  const mw = watch(w, kills);
  await wait(30);
  w.oomKill(12);
  await until(() => kills.length === 1);
  await Promise.all([mw.check(), mw.check()]);
  await wait(60);
  assert.equal(kills.length, 1);
  assert.deepEqual(mw.records().map((r) => r.seq), [1]);
  mw.stop();
});

test('a process that exited normally is not a kill: no counter movement ⇒ no record; and its name is not reused by a LATER kill', async () => {
  const w = new World();
  w.add(12, { comm: 'sleep', cmdline: 'sleep 1', rssPages: 10 });
  w.add(13, { comm: 'hog', cmdline: 'hog 2', rssPages: 9000, adj: 1000 });
  const kills: MemKillRecord[] = [];
  const mw = watch(w, kills);
  await wait(30);
  w.procs.delete(12); // normal exit
  await wait(60);
  assert.equal(kills.length, 0, 'an exit is not a kill');
  w.oomKill(13);
  await until(() => kills.length === 1);
  assert.equal(kills[0].command, 'hog 2');
  assert.deepEqual(kills[0].candidates, [], 'sleep 1 exited normally in an EARLIER look: it is not even a candidate for a later kill');
  // A second, later kill must not re-name the first victim.
  w.add(14, { comm: 'hog', cmdline: 'hog 3', rssPages: 9000, adj: 1000 });
  await wait(40);
  w.oomKill(14);
  await until(() => kills.length === 2);
  assert.equal(kills[1].command, 'hog 3');
  assert.equal(kills[1].seq, 2);
  mw.stop();
});

test('a process that lived less than one snapshot is counted but NOT named (command null), never given a made-up name', async () => {
  const w = new World();
  w.add(10, { comm: 'node', cmdline: 'node keeper.js', rssPages: 15_000 });
  const kills: MemKillRecord[] = [];
  const mw = watch(w, kills, { hotMs: 10_000, fastMs: 10_000, idleMs: 10_000 }); // the tick will not run again: only the inotify/check path
  w.add(99, { comm: 'flash', cmdline: 'flash', adj: 1000 });
  w.oomKill(99); // born and killed between two snapshots
  await mw.check();
  assert.equal(kills.length, 1);
  assert.equal(kills[0].command, null);
  assert.equal(kills[0].pid, null);
  mw.stop();
});

test('a kill by an outside OOM (the scope\'s own `oom` counter did not move) is labelled external, not hard', async () => {
  const w = new World();
  w.add(12, { comm: 'hog', cmdline: 'hog', adj: 1000, rssPages: 9000 });
  const kills: MemKillRecord[] = [];
  const mw = watch(w, kills);
  await wait(30);
  w.oomKill(12, { hard: false });
  await until(() => kills.length === 1);
  assert.equal(kills[0].level, 'external');
  mw.stop();
});

test('a pid reused after the kill (same pid, new start time) does not hide the victim', async () => {
  const w = new World();
  w.add(12, { comm: 'hog', cmdline: 'hog', adj: 1000, rssPages: 9000 });
  const kills: MemKillRecord[] = [];
  const mw = watch(w, kills, { hotMs: 10_000, fastMs: 10_000, idleMs: 10_000 });
  w.events.oom_kill = 0;
  // one snapshot has happened (the start tick); now the victim dies and a NEW process takes pid 12 before the next look
  w.oomKill(12);
  w.add(12, { comm: 'bash', cmdline: 'bash', start: 987_654, rssPages: 10 });
  await mw.check();
  assert.equal(kills[0]?.command, 'hog');
  mw.stop();
});

test('stop() ends the watch: no record after it, no timer left running', async () => {
  const w = new World();
  w.add(12, { comm: 'hog', cmdline: 'hog', adj: 1000 });
  const kills: MemKillRecord[] = [];
  const mw = watch(w, kills);
  await wait(20);
  mw.stop();
  w.oomKill(12);
  await mw.check();
  await wait(60);
  assert.equal(kills.length, 0);
});

test('PRE-REVIEW MAJOR 1: a big command that exited NORMALLY just before a smaller hog is killed is not named as the victim', async () => {
  const w = new World();
  w.add(10, { comm: 'node', cmdline: 'node keeper.js', rssPages: 15_000 });
  w.add(20, { comm: 'runner', cmdline: 'pnpm-test-runner', rssPages: 50_000, adj: 1000 }); // 200 MB at 4 KiB pages, finishes cleanly
  w.add(21, { comm: 'python3', cmdline: 'python3 hog.py', rssPages: 10_000, adj: 1000 }); // 40 MB, the real victim
  const kills: MemKillRecord[] = [];
  const mw = watch(w, kills);
  await wait(40);
  w.procs.delete(20); // exits normally; no counter movement
  await wait(60); // several looks go by: it is forgotten
  w.oomKill(21);
  await until(() => kills.length === 1);
  assert.equal(kills[0].command, 'python3 hog.py', 'the victim, not the earlier exiter');
  assert.deepEqual(kills[0].candidates, []);
  mw.stop();
});

test('the counter moves just BEFORE the victim dies: a look that sees the bump first waits a moment and still names the victim', async () => {
  const w = new World();
  w.add(12, { comm: 'hog', cmdline: 'hog --big', adj: 1000, rssPages: 9000 });
  const kills: MemKillRecord[] = [];
  const mw = watch(w, kills, { hotMs: 10_000, fastMs: 10_000, idleMs: 10_000 }); // only the explicit looks run
  w.events.oom_kill += 1;
  w.events.oom += 1; // the kernel has counted the kill...
  const looking = mw.check(); // ...the look sees the bump with the victim still alive
  setTimeout(() => w.procs.delete(12), 10); // ...and the victim dies a few ms later
  await looking;
  assert.equal(kills.length, 1);
  assert.equal(kills[0].command, 'hog --big');
  mw.stop();
});

test('detectPageSize: derives the kernel page from our own /proc (16 KiB on Asahi), 4096 when unreadable', () => {
  const files: Record<string, string> = { '/proc/self/statm': '100 1000 10 1 0 1 0\n', '/proc/self/status': 'Name:\tnode\nVmRSS:\t   16000 kB\n' };
  assert.equal(detectPageSize((p) => files[p] ?? ''), 16384);
  files['/proc/self/status'] = 'VmRSS:\t4000 kB\n';
  assert.equal(detectPageSize((p) => files[p] ?? ''), 4096);
  assert.equal(detectPageSize(() => { throw new Error('no /proc'); }), 4096);
});

// ─── F1 of the verifier's gate on 1981ec9e: the kernel counts `oom` BEFORE `oom_kill` ────────────────────────────────────────

test('F1 (gate): a look BETWEEN the `oom` bump and the `oom_kill` bump must not turn a real hard-level kill into "external" — the credit carries to the look that sees the kill', async () => {
  const w = new World();
  w.add(12, { comm: 'hog', cmdline: 'python3 hog.py', adj: 1000, rssPages: 9000 });
  const kills: MemKillRecord[] = [];
  const mw = watch(w, kills, { hotMs: 10_000, fastMs: 10_000, idleMs: 10_000 }); // only the explicit looks run
  await mw.check(); // look 0: nothing yet
  w.events.max += 5;
  w.events.oom += 1; // look A sees the OOM event counted...
  await mw.check();
  assert.equal(kills.length, 0, 'no kill yet: nothing to report');
  w.procs.delete(12);
  w.events.oom_kill += 1; // ...look B sees the kill, with an `oom` delta of ZERO
  await mw.check();
  assert.equal(kills.length, 1);
  assert.equal(kills[0].level, 'hard', 'oom=1 and oom_kill=1 in total: the kill IS the scope\'s own limit');
  assert.equal(kills[0].command, 'python3 hog.py');
  mw.stop();
});

test('the carried credit is SPENT by a kill: a later kill with no new `oom` event is external; and a credit that never produced a kill expires (it cannot hard-label an outside OOM minutes later)', async () => {
  let clock = 1_000_000;
  const w = new World();
  w.add(12, { comm: 'a', cmdline: 'a', adj: 1000, rssPages: 9000 });
  w.add(13, { comm: 'b', cmdline: 'b', adj: 1000, rssPages: 8000 });
  const kills: MemKillRecord[] = [];
  const mw = watch(w, kills, { hotMs: 10_000, fastMs: 10_000, idleMs: 10_000, now: () => clock });
  await mw.check();
  w.events.oom += 1;
  await mw.check(); // credit 1
  w.procs.delete(12);
  w.events.oom_kill += 1;
  await mw.check(); // spends it
  assert.deepEqual(kills.map((k) => k.level), ['hard']);
  w.procs.delete(13);
  w.events.oom_kill += 1; // a second kill, NO new oom event
  await mw.check();
  assert.deepEqual(kills.map((k) => k.level), ['hard', 'external'], 'one credit, one hard kill');
  // expiry
  w.add(14, { comm: 'c', cmdline: 'c', adj: 1000, rssPages: 7000 });
  await mw.check();
  w.events.oom += 1; // an OOM event that kills nothing...
  await mw.check();
  clock += 60_000; // ...and a minute later an outside kill
  w.procs.delete(14);
  w.events.oom_kill += 1;
  await mw.check();
  assert.equal(kills.at(-1)?.level, 'external', 'a stale credit does not make a later outside-OOM kill «hard»');
  mw.stop();
});

test('two kills in one look with ONE unit of credit: [hard, external]; with two: [hard, hard]', async () => {
  const w = new World();
  w.add(12, { comm: 'a', cmdline: 'a', adj: 1000, rssPages: 9000 });
  w.add(13, { comm: 'b', cmdline: 'b', adj: 1000, rssPages: 8000 });
  w.add(14, { comm: 'c', cmdline: 'c', adj: 1000, rssPages: 7000 });
  w.add(15, { comm: 'd', cmdline: 'd', adj: 1000, rssPages: 6000 });
  const kills: MemKillRecord[] = [];
  const mw = watch(w, kills, { hotMs: 10_000, fastMs: 10_000, idleMs: 10_000 });
  await mw.check();
  w.events.oom += 1;
  w.procs.delete(12);
  w.procs.delete(13);
  w.events.oom_kill += 2;
  await mw.check();
  assert.deepEqual(kills.map((k) => k.level), ['hard', 'external']);
  w.events.oom += 2;
  w.procs.delete(14);
  w.procs.delete(15);
  w.events.oom_kill += 2;
  await mw.check();
  assert.deepEqual(kills.slice(2).map((k) => k.level), ['hard', 'hard']);
  mw.stop();
});

test('re-gate MINOR: two `oom` events, the two kills in two SEPARATE looks ⇒ [hard, hard] — the leftover credit of a look is carried to the NEXT kill', async () => {
  const w = new World();
  w.add(12, { comm: 'a', cmdline: 'a', adj: 1000, rssPages: 9000 });
  w.add(13, { comm: 'b', cmdline: 'b', adj: 1000, rssPages: 8000 });
  const kills: MemKillRecord[] = [];
  const mw = watch(w, kills, { hotMs: 10_000, fastMs: 10_000, idleMs: 10_000 });
  await mw.check();
  w.events.oom += 2; // the kernel has counted TWO memcg OOM events...
  await mw.check();
  assert.equal(kills.length, 0);
  w.procs.delete(12);
  w.events.oom_kill += 1; // ...look A sees the first kill
  await mw.check();
  assert.deepEqual(kills.map((k) => k.level), ['hard']);
  w.procs.delete(13);
  w.events.oom_kill += 1; // ...look B sees the second, with NO new oom event: it spends the credit look A left over
  await mw.check();
  assert.deepEqual(kills.map((k) => k.level), ['hard', 'hard'], 'a look must not throw away the credit it did not spend');
  assert.deepEqual(kills.map((k) => k.command), ['a', 'b']);
  mw.stop();
});

// ─── #322: the warning level, and the kernel naming its victim ────────────────────────────────────────────────────────

const MB = 1024 * 1024;
function watchSoft(w: World, softs: MemSoftRecord[], kills: MemKillRecord[] = [], extra: Partial<Parameters<typeof startMemoryWatch>[0]> = {}) {
  return startMemoryWatch({ cgroupDir: DIR, unit: 'u.scope', onKill: (r) => kills.push(r), onSoft: (r) => softs.push(r), softBytes: 200 * MB, log: () => {}, readFile: w.read, hotMs: 5, fastMs: 5, idleMs: 5, pageSize: 4096, ...extra });
}

test('#322 D-Q2: the warning level fires ONCE per upward crossing of the working set, re-arms below 90 % of the level, and nothing else (no kill, no throttle)', async () => {
  const w = new World();
  w.current = 100 * MB;
  const softs: MemSoftRecord[] = [];
  const kills: MemKillRecord[] = [];
  const mw = watchSoft(w, softs, kills, { softMinIntervalMs: 0 }); // the rate bound has its own test below
  await wait(40);
  assert.equal(softs.length, 0, 'below the level: silent');
  w.current = 210 * MB;
  assert.ok(await until(() => softs.length === 1), 'crossing up ⇒ one record');
  assert.deepEqual({ bytes: softs[0].bytes, soft: softs[0].softBytes, hard: softs[0].hardBytes, unit: softs[0].unit, kind: softs[0].kind }, { bytes: 210 * MB, soft: 200 * MB, hard: w.maxBytes, unit: 'u.scope', kind: 'soft' });
  w.current = 230 * MB;
  await wait(60);
  assert.equal(softs.length, 1, 'staying above ⇒ no repeat');
  w.current = 190 * MB; // below the level but above 90 % (180 MB): still disarmed — a scope hovering at the level must not report every sample
  await wait(40);
  w.current = 205 * MB;
  await wait(60);
  assert.equal(softs.length, 1, 'hovering around the level ⇒ no flapping');
  w.current = 150 * MB; // below 90 % ⇒ re-armed
  await wait(40);
  w.current = 205 * MB;
  assert.ok(await until(() => softs.length === 2), 'a NEW crossing ⇒ a new record');
  assert.equal(softs[1].seq, softs[0].seq + 1);
  assert.equal(kills.length, 0, 'a warning kills nothing');
  mw.stop();
});

test('#322: no softBytes (or no onSoft) ⇒ no warning, however high the scope goes', async () => {
  const w = new World();
  w.current = 290 * MB;
  const softs: MemSoftRecord[] = [];
  const a = watchSoft(w, softs, [], { softBytes: null });
  const b = startMemoryWatch({ cgroupDir: DIR, unit: 'u.scope', onKill: () => {}, softBytes: 100 * MB, log: () => {}, readFile: w.read, hotMs: 5, fastMs: 5, idleMs: 5, pageSize: 4096 });
  await wait(60);
  assert.equal(softs.length, 0);
  a.stop();
  b.stop();
});

test('#322: kills and warnings share ONE seq counter in EMISSION order (the host cursor is a high-water mark: a lower seq arriving later would be dropped)', async () => {
  const w = new World();
  w.current = 100 * MB;
  w.add(12, { comm: 'hog', cmdline: 'hog', adj: 1000, rssPages: 9000 });
  const softs: MemSoftRecord[] = [];
  const kills: MemKillRecord[] = [];
  const order: number[] = [];
  const mw = startMemoryWatch({ cgroupDir: DIR, unit: 'u.scope', softBytes: 200 * MB, onSoft: (r) => (softs.push(r), order.push(r.seq)), onKill: (r) => (kills.push(r), order.push(r.seq)), log: () => {}, readFile: w.read, hotMs: 5, fastMs: 5, idleMs: 5, pageSize: 4096,
    // the kernel log answers late: the warning below is emitted WHILE the kill waits for it
    kernelLog: async () => { await wait(120); return [{ atMs: Date.now(), pid: 12, comm: 'hog', oomMemcg: '/s/u.scope', taskMemcg: '/s/u.scope' }]; } });
  await wait(30);
  w.oomKill(12);
  await wait(20);
  w.current = 250 * MB; // crosses while the kill is waiting for the log
  assert.ok(await until(() => softs.length === 1 && kills.length === 1, 3000));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), `emission order ${order} is increasing`);
  assert.equal(new Set(order).size, 2);
  mw.stop();
});

const kline = (pid: number, comm: string, cg = '/user.slice/app.slice/u.scope'): KernelOomKill => ({ atMs: Date.now(), pid, comm, oomMemcg: cg, taskMemcg: cg });

test('#322 m2: a LARGER command that exited normally in the same window is NOT named — the kernel log names the real (never snapshotted) victim', async () => {
  const w = new World();
  w.add(10, { comm: 'node', cmdline: 'node keeper.js', rssPages: 5000 });
  w.add(12, { comm: 'bigbuild', cmdline: 'bigbuild --all', rssPages: 40_000, adj: 1000 });
  const kills: MemKillRecord[] = [];
  const mw = watchSoft(w, [], kills, { kernelLog: async () => [kline(99, 'python3')] });
  await wait(50); // 12 is snapshotted, big
  w.procs.delete(12); // exits NORMALLY …
  w.add(99, { comm: 'python3', cmdline: 'python3 leak.py', adj: 1000 });
  w.oomKill(99); // … and in the same window a small, never-snapshotted process is OOM-killed
  assert.ok(await until(() => kills.length === 1, 3000));
  assert.equal(kills[0].source, 'kernel');
  assert.equal(kills[0].pid, 99);
  assert.equal(kills[0].command, 'python3');
  assert.deepEqual(kills[0].candidates, []);
  mw.stop();
});

test('#322 m2 control: WITHOUT the kernel log the same window names the bigger command that exited normally (the m2 failure) — and says it is only inferred', async () => {
  const w = new World();
  w.add(12, { comm: 'bigbuild', cmdline: 'bigbuild --all', rssPages: 40_000, adj: 1000 });
  const kills: MemKillRecord[] = [];
  const mw = watchSoft(w, [], kills, { kernelLog: async () => null });
  await wait(50);
  w.procs.delete(12);
  w.add(99, { comm: 'python3', adj: 1000 });
  w.oomKill(99);
  assert.ok(await until(() => kills.length === 1, 4000));
  assert.equal(kills[0].source, 'inferred', 'an unreadable journal ⇒ the record says it is a guess');
  assert.equal(kills[0].command, 'bigbuild --all');
  mw.stop();
});

test('#322 m2: the journal line lands a moment AFTER the counter moves — the watch polls; another scope\'s line and an already-used line never name this kill', async () => {
  const w = new World();
  w.add(12, { comm: 'hog', cmdline: 'hog', adj: 1000, rssPages: 9000 });
  let calls = 0;
  const kills: MemKillRecord[] = [];
  const stranger = kline(555, 'neighbour', '/user.slice/app.slice/other.scope'); // a neighbour's kill: never ours
  const line12 = kline(12, 'hog'); // a journal line has ONE timestamp for ever
  const mw = watchSoft(w, [], kills, {
    kernelLog: async () => {
      calls += 1;
      return calls < 3 ? [stranger] : [stranger, line12];
    },
  });
  await wait(40);
  w.oomKill(12);
  assert.ok(await until(() => kills.length === 1, 4000));
  assert.ok(calls >= 3, `polled until the line appeared (${calls} calls)`);
  assert.equal(kills[0].pid, 12);
  assert.equal(kills[0].source, 'kernel');
  // a SECOND kill: the first kernel line is already attributed and must not be paired again
  w.add(13, { comm: 'hog2', cmdline: 'hog2', adj: 1000, rssPages: 9000 });
  await wait(40);
  w.oomKill(13);
  assert.ok(await until(() => kills.length === 2, 4000));
  assert.notEqual(kills[1].source === 'kernel' && kills[1].pid, 12, 'the used line is not reused');
  assert.equal(kills[1].source, 'inferred', 'no new line for this kill ⇒ the inference stands, labelled');
  mw.stop();
});

test('#322 R5: the warning keys on the WORKING SET — a scope full of reclaimable page cache (a pnpm install) does NOT warn; the same total in anon memory does', async () => {
  const w = new World();
  w.current = 100 * MB;
  const softs: MemSoftRecord[] = [];
  const mw = watchSoft(w, softs);
  await wait(40);
  w.current = 260 * MB; // far above the 200 MB level …
  w.inactiveFile = 220 * MB; // … but 220 MB of it is inactive file cache: working set 40 MB
  await wait(80);
  assert.equal(softs.length, 0, 'cache alone is not a warning (the kernel reclaims it before any kill)');
  w.inactiveFile = 20 * MB; // the same total, now mostly anon: working set 240 MB
  assert.ok(await until(() => softs.length === 1), 'the working set crossing the level warns');
  assert.equal(softs[0].bytes, 240 * MB, 'the record carries the working set, not memory.current');
  mw.stop();
});

test('#322 R5: memory.stat unreadable ⇒ the raw memory.current is the fallback (noisier, never silent)', async () => {
  const w = new World();
  w.current = 100 * MB;
  const softs: MemSoftRecord[] = [];
  const read = (p: string): string => { if (p.endsWith('/memory.stat')) throw new Error('ENOENT'); return w.read(p); };
  const mw = startMemoryWatch({ cgroupDir: DIR, unit: 'u.scope', onKill: () => {}, onSoft: (r) => softs.push(r), softBytes: 200 * MB, log: () => {}, readFile: read, hotMs: 5, fastMs: 5, idleMs: 5, pageSize: 4096 });
  await wait(30);
  w.current = 220 * MB;
  assert.ok(await until(() => softs.length === 1));
  assert.equal(softs[0].bytes, 220 * MB);
  mw.stop();
});

test('#322 m2: the kernel-log lookup (a fork INSIDE the scope) waits for headroom — it is not spawned while the scope is still at its limit, and it still runs after the bounded wait', async () => {
  const w = new World();
  w.maxBytes = 300 * MB;
  w.current = 100 * MB;
  w.add(12, { comm: 'hog', cmdline: 'hog', adj: 1000, rssPages: 9000 });
  const kills: MemKillRecord[] = [];
  let calledAtCurrent: number[] = [];
  const mw = watchSoft(w, [], kills, { softBytes: null, kernelLog: async () => { calledAtCurrent.push(w.current); return [kline(12, 'hog')]; } });
  await wait(40);
  w.current = 299 * MB; // the scope is full when the victim dies …
  w.oomKill(12);
  await wait(250);
  assert.equal(calledAtCurrent.length, 0, 'no fork while the scope is at its limit');
  w.current = 150 * MB; // … and the victim\'s memory is released
  assert.ok(await until(() => kills.length === 1, 3000));
  assert.deepEqual(calledAtCurrent.map((c) => c < 0.92 * w.maxBytes), [true], 'the lookup ran only once there was headroom');
  assert.equal(kills[0].source, 'kernel');
  // a scope that NEVER frees (the wait is bounded): NO fork at all — the record arrives promptly, labelled `inferred`
  const w2 = new World();
  w2.maxBytes = 300 * MB;
  w2.current = 299 * MB;
  w2.add(13, { comm: 'hog', cmdline: 'hog', adj: 1000, rssPages: 9000 });
  const kills2: MemKillRecord[] = [];
  let forks2 = 0;
  const mw2 = watchSoft(w2, [], kills2, { softBytes: null, kernelLog: async () => { forks2 += 1; return [kline(13, 'hog')]; } });
  await wait(40);
  w2.oomKill(13);
  assert.ok(await until(() => kills2.length === 1, 4000), 'bounded wait ⇒ the record still arrives');
  assert.equal(forks2, 0, 'a scope that stays at its limit is never forked into');
  assert.equal(kills2[0].source, 'inferred', 'and the record says it is a guess');
  mw.stop();
  mw2.stop();
});

// ─── #322 pre-review fixes (F1 stale/ambiguous kernel lines, F2 stop during the wait, F5 headroom on the working set) ───

test('review F1: a STALE journal line of an earlier kill (whose lookup was skipped) never names the next kill — the pid already named is dropped, an ambiguous surplus stays «inferred»', async () => {
  const w = new World();
  w.maxBytes = 300 * MB;
  w.current = 299 * MB; // the scope is saturated: kill 1's lookup is skipped (no fork)
  w.add(12, { comm: 'workerA', cmdline: 'workerA', adj: 1000, rssPages: 9000 });
  w.add(13, { comm: 'workerB', cmdline: 'workerB', adj: 1000, rssPages: 8000 });
  const kills: MemKillRecord[] = [];
  const L1 = kline(12, 'workerA');
  const L2 = kline(13, 'workerB');
  let lines: KernelOomKill[] = [L1];
  const mw = watchSoft(w, [], kills, { softBytes: null, kernelLog: async () => lines });
  await wait(40);
  w.oomKill(12);
  assert.ok(await until(() => kills.length === 1, 4000));
  assert.equal(kills[0].source, 'inferred', 'saturated ⇒ no lookup ⇒ a guess, labelled');
  assert.equal(kills[0].pid, 12);
  w.current = 100 * MB; // headroom is back; the journal now holds the STALE line of kill 1 and the line of kill 2
  lines = [L1, L2];
  w.oomKill(13);
  assert.ok(await until(() => kills.length === 2, 4000));
  assert.equal(kills[1].pid, 13, 'kill 2 is workerB — not workerA a second time');
  assert.equal(kills[1].source, 'kernel');
  mw.stop();
});

test('review F1: a stale line whose pid was NOT named by the earlier (wrong) guess is SET ASIDE as that earlier kill\'s (it owes a line), and the current kill is named by its OWN line', async () => {
  const w = new World();
  w.maxBytes = 300 * MB;
  w.current = 299 * MB;
  w.add(20, { comm: 'decoy', cmdline: 'decoy', adj: 1000, rssPages: 20000 }); // exits NORMALLY, bigger than the victim: the guess for kill 1
  w.add(12, { comm: 'victim1', cmdline: 'victim1', adj: 1000, rssPages: 5000 });
  const kills: MemKillRecord[] = [];
  const L1 = kline(12, 'victim1'); // kill 1's REAL line, never consumed (the lookup was skipped)
  const L2 = kline(13, 'victim2');
  let lines: KernelOomKill[] = [];
  const mw = watchSoft(w, [], kills, { softBytes: null, kernelLog: async () => lines });
  await wait(40);
  w.procs.delete(20);
  w.oomKill(12);
  assert.ok(await until(() => kills.length === 1, 4000));
  assert.equal(kills[0].pid, 20, 'the guess is the decoy (the m2 failure, honestly labelled)');
  assert.equal(kills[0].source, 'inferred');
  w.current = 100 * MB;
  lines = [L1, L2];
  w.add(13, { comm: 'victim2', cmdline: 'victim2', adj: 1000, rssPages: 6000 });
  await wait(30);
  w.oomKill(13);
  assert.ok(await until(() => kills.length === 2, 4000));
  assert.equal(kills[1].source, 'kernel', 'kill 1 owes a line: the OLDEST unclaimed line (L1) is its, kill 2 gets L2');
  assert.equal(kills[1].pid, 13);
  mw.stop();
});

test('review F1: ONE journal line for TWO kills in one look ⇒ both stay inferred and name two DIFFERENT processes (the second never repeats the first)', async () => {
  const w = new World();
  w.add(12, { comm: 'w1', cmdline: 'w1', adj: 1000, rssPages: 9000 });
  w.add(13, { comm: 'w2', cmdline: 'w2', adj: 1000, rssPages: 8000 });
  const kills: MemKillRecord[] = [];
  const mw = watchSoft(w, [], kills, { softBytes: null, kernelLog: async () => [kline(12, 'w1')] });
  await wait(40);
  w.oomKill(12);
  w.oomKill(13);
  assert.ok(await until(() => kills.length === 2, 4000));
  assert.deepEqual(kills.map((k) => k.source), ['inferred', 'inferred']);
  assert.equal(new Set(kills.map((k) => k.pid)).size, 2, 'two kills, two different pids');
  mw.stop();
});

test('review F2: stop() while a kill waits for the kernel log emits it NOW, labelled inferred, exactly once — the keeper exiting must not eat the report', async () => {
  const w = new World();
  w.add(12, { comm: 'hog', cmdline: 'hog', adj: 1000, rssPages: 9000 });
  const kills: MemKillRecord[] = [];
  const mw = watchSoft(w, [], kills, { softBytes: null, kernelLog: async () => { await wait(600); return [kline(12, 'hog')]; } });
  await wait(40);
  w.oomKill(12);
  await wait(60); // the look has seen the kill and is now waiting for the journal
  assert.equal(kills.length, 0, 'precondition: the record is still pending');
  mw.stop();
  assert.equal(kills.length, 1, 'stop() flushed the pending kill synchronously');
  assert.equal(kills[0].source, 'inferred');
  assert.equal(kills[0].pid, 12);
  await wait(800);
  assert.equal(kills.length, 1, 'and the resumed look does not emit it a second time');
});

test('review F5: the headroom check keys on the WORKING SET — a scope full of reclaimable page cache still gets its kernel-log lookup', async () => {
  const w = new World();
  w.maxBytes = 300 * MB;
  w.current = 299 * MB;
  w.inactiveFile = 250 * MB; // working set 49 MB: the kernel would reclaim the cache before charging a fork
  w.add(12, { comm: 'hog', cmdline: 'hog', adj: 1000, rssPages: 9000 });
  const kills: MemKillRecord[] = [];
  let called = 0;
  const mw = watchSoft(w, [], kills, { softBytes: null, kernelLog: async () => { called += 1; return [kline(12, 'hog')]; } });
  await wait(40);
  w.oomKill(12);
  assert.ok(await until(() => kills.length === 1, 3000));
  assert.equal(called >= 1, true, 'the lookup ran although memory.current was at the limit');
  assert.equal(kills[0].source, 'kernel');
  mw.stop();
});

// ─── #322 review round 2 (F2 storm: a stale line must not be re-offered; F4 final look on stop; F5 rate bound) ───

test('review-2 F2: under a printk-ratelimited storm a line already accounted for is never re-offered, a kill whose own line was dropped stays «inferred», and the debt of a dropped line EXPIRES (our clock) so later kills are named again', async () => {
  const w = new World();
  w.add(10, { comm: 'node', cmdline: 'node keeper.js', rssPages: 5000 });
  const journal: KernelOomKill[] = [];
  const kills: MemKillRecord[] = [];
  let clock = 1_000_000;
  const mw = watchSoft(w, [], kills, { softBytes: null, now: () => clock, kernelLog: async () => [...journal] });
  await wait(40);
  // look 1: TWO kills of processes no snapshot ever saw, but the kernel logged ONE line (ratelimit) ⇒ not pairable ⇒ both inferred, unnamed; they owe 1 line
  journal.push(kline(501, 'hog'));
  w.events.oom += 2;
  w.events.oom_kill += 2;
  assert.ok(await until(() => kills.length === 2, 5000));
  assert.deepEqual(kills.map((k) => [k.source, k.pid]), [['inferred', null], ['inferred', null]]);
  // look 2, 0.4 s later: ONE more kill (503) whose line the kernel DROPPED — the only line in the journal is look 1's, still there
  await wait(400);
  w.events.oom += 1;
  w.events.oom_kill += 1;
  assert.ok(await until(() => kills.length === 3, 5000));
  assert.equal(kills[2].source, 'inferred', 'the line look 1 already accounted for is not offered a second time');
  assert.equal(kills[2].pid, null, 'and it is not carried as this kill\'s pid');
  // the dropped lines are gone for good: after the debt TTL a fresh kill with its fresh line is named again
  clock += 6000;
  journal.push(kline(504, 'hog'));
  w.events.oom += 1;
  w.events.oom_kill += 1;
  assert.ok(await until(() => kills.length === 4, 5000));
  assert.equal(kills[3].source, 'kernel');
  assert.equal(kills[3].pid, 504, 'the fresh line names its own kill once the dropped lines are forgiven');
  mw.stop();
});

test('verifier repro 3: only kill 1\'s STALE line is in the journal when kill 2 is first looked up (its own lands one poll later) — never kernel-certain with the wrong pid; the poll resolves it to the RIGHT one', async () => {
  const w = new World();
  w.current = 299 * MB;
  w.add(20, { comm: 'decoy', cmdline: 'decoy', adj: 1000, rssPages: 20000 });
  w.add(12, { comm: 'victim1', cmdline: 'victim1', adj: 1000, rssPages: 5000 });
  const kills: MemKillRecord[] = [];
  let phase2 = false;
  let call = 0;
  let L1: KernelOomKill | null = null;
  let L2: KernelOomKill | null = null;
  const mw = watchSoft(w, [], kills, { softBytes: null, kernelLog: async () => { if (!phase2) return []; call += 1; return call === 1 ? [L1!] : [L1!, L2!]; } });
  await wait(40);
  w.procs.delete(20);
  w.oomKill(12);
  L1 = kline(12, 'victim1');
  assert.ok(await until(() => kills.length === 1, 5000));
  assert.equal(kills[0].source, 'inferred');
  w.current = 100 * MB;
  w.add(13, { comm: 'victim2', cmdline: 'victim2', adj: 1000, rssPages: 6000 });
  await wait(30);
  w.oomKill(13);
  L2 = kline(13, 'victim2');
  phase2 = true;
  assert.ok(await until(() => kills.length === 2, 5000));
  assert.ok(kills[1].source !== 'kernel' || kills[1].pid === 13, `WRONG CERTAINTY: kill 2 (pid 13) recorded as ${kills[1].source} pid ${kills[1].pid}`);
  assert.equal(kills[1].pid, 13, 'and the poll found its own line');
  mw.stop();
});

test('verifier repro 4 (the rig instability): two kills 33 ms apart, a look sees the counter between them while the journal already holds BOTH lines — BOTH are named by the kernel, oldest first', async () => {
  const w = new World();
  w.add(20, { comm: 'decoy', cmdline: 'decoy', adj: 1000, rssPages: 20000 }); // exits normally with the first kill (unseen victim ⇒ a wrong guess)
  w.add(12, { comm: 'victim1', cmdline: 'victim1', adj: 1000, rssPages: 5000 });
  w.add(13, { comm: 'victim2', cmdline: 'victim2', adj: 1000, rssPages: 6000 });
  const kills: MemKillRecord[] = [];
  let L12: KernelOomKill | null = null;
  let L13: KernelOomKill | null = null;
  const mw = watchSoft(w, [], kills, { softBytes: null, kernelLog: async () => (L12 && L13 ? [L12, L13] : []) });
  await wait(40);
  w.procs.delete(20);
  w.oomKill(12);
  L12 = kline(12, 'victim1');
  L13 = kline(13, 'victim2'); // the journal already has victim2's line: the look below happens before its counter bump
  assert.ok(await until(() => kills.length === 1, 5000));
  w.oomKill(13);
  assert.ok(await until(() => kills.length === 2, 5000));
  assert.deepEqual(kills.map((k) => [k.source, k.pid]), [['kernel', 12], ['kernel', 13]], 'surplus waits unclaimed for the next round: no kill degrades');
  mw.stop();
});

test('review-2 F4: stop() runs a LAST look — a kill the counter shows but no look has processed yet (the CLI is the victim, the keeper exits at once) still leaves exactly one record', async () => {
  const w = new World();
  w.add(10, { comm: 'node', cmdline: 'node keeper.js', rssPages: 5000 });
  w.add(11, { comm: 'claude', cmdline: 'claude --output-format stream-json', rssPages: 30_000 });
  const kills: MemKillRecord[] = [];
  const mw = startMemoryWatch({ cgroupDir: DIR, unit: 'u.scope', onKill: (r) => kills.push(r), log: () => {}, readFile: w.read, hotMs: 60_000, fastMs: 60_000, idleMs: 60_000, pageSize: 4096 }); // no tick before stop()
  // inotify is not available on the virtual file; the first tick already ran at start()
  w.oomKill(11);
  assert.equal(kills.length, 0, 'precondition: nothing processed it yet');
  mw.stop();
  assert.equal(kills.length, 1, 'the final look recorded it');
  assert.equal(kills[0].pid, 11);
  await wait(30);
  mw.stop();
  assert.equal(kills.length, 1, 'and a second stop() adds nothing');
});

test('review-2 F4: the final look never double-counts a delta a look already accounted (the kernel-log wait)', async () => {
  const w = new World();
  w.add(12, { comm: 'hog', cmdline: 'hog', adj: 1000, rssPages: 9000 });
  const kills: MemKillRecord[] = [];
  const mw = watchSoft(w, [], kills, { softBytes: null, kernelLog: async () => { await wait(500); return [kline(12, 'hog')]; } });
  await wait(40);
  w.oomKill(12);
  await wait(80);
  mw.stop();
  await wait(700);
  assert.equal(kills.length, 1, 'one kill, one record');
});

test('review-2 F5: warnings are rate-bounded — a scope pulsing around its level yields ONE warning per interval; the swallowed crossings are counted and told with the next one', async () => {
  const w = new World();
  w.current = 100 * MB;
  const softs: MemSoftRecord[] = [];
  let clock = 1_000_000;
  const mw = startMemoryWatch({ cgroupDir: DIR, unit: 'u.scope', onKill: () => {}, onSoft: (r) => softs.push(r), softBytes: 200 * MB, softMinIntervalMs: 30_000, now: () => clock, log: () => {}, readFile: w.read, hotMs: 5, fastMs: 5, idleMs: 5, pageSize: 4096 });
  const pulse = async (): Promise<void> => {
    w.current = 230 * MB;
    await wait(40);
    w.current = 100 * MB; // below 90 % ⇒ re-armed
    await wait(40);
  };
  await pulse(); // t = 0: warns
  await pulse(); // swallowed
  await pulse(); // swallowed
  assert.equal(softs.length, 1, 'three crossings, one warning');
  clock += 31_000;
  w.current = 230 * MB;
  assert.ok(await until(() => softs.length === 2));
  assert.equal(softs[1].suppressed, 2, 'the two swallowed crossings are told with the next warning');
  assert.equal(softs[0].suppressed, undefined);
  mw.stop();
});

test('round 2 M3: a CLI killed (the cap\'s last resort) while an earlier tool kill waits for the kernel log, then stop() - BOTH victims are recorded once each, the tool is not named twice and the CLI is not lost', async () => {
  const w = new World();
  w.add(10, { comm: 'node', cmdline: 'node keeper.js', rssPages: 5000 });
  w.add(12, { comm: 'hogA', cmdline: 'hogA', adj: 1000, rssPages: 9000 });
  w.add(13, { comm: 'claude', cmdline: 'claude --output-format stream-json', adj: 0, rssPages: 30_000 });
  const kills: MemKillRecord[] = [];
  const mw = watchSoft(w, [], kills, { softBytes: null, kernelLog: async () => { await wait(500); return []; } });
  await wait(40);
  w.oomKill(12);
  await wait(80); // the look has seen kill 1 and waits for the journal
  w.oomKill(13); // the CLI dies too
  mw.stop();
  assert.deepEqual(kills.map((k) => k.pid).sort(), [12, 13], 'one record each - not [12, 12]');
});

test('round 2 m1: a crossing swallowed by the rate bound whose scope is STILL above the level is told once, deferred, when the interval is over - and not again every interval', async () => {
  const w = new World();
  w.current = 100 * MB;
  const softs: MemSoftRecord[] = [];
  let clock = 5_000_000;
  const mw = startMemoryWatch({ cgroupDir: DIR, unit: 'u.scope', onKill: () => {}, onSoft: (r) => softs.push(r), softBytes: 200 * MB, softMinIntervalMs: 30_000, now: () => clock, log: () => {}, readFile: w.read, hotMs: 5, fastMs: 5, idleMs: 5, pageSize: 4096 });
  w.current = 230 * MB;
  assert.ok(await until(() => softs.length === 1));
  w.current = 100 * MB;
  await wait(40); // re-armed
  clock += 5_000;
  w.current = 280 * MB; // crosses again inside the interval: swallowed - and it STAYS high
  await wait(60);
  assert.equal(softs.length, 1, 'swallowed');
  clock += 31_000; // the interval is over
  assert.ok(await until(() => softs.length === 2), 'told once, deferred');
  assert.equal(softs[1].suppressed, 1);
  assert.equal(softs[1].bytes, 280 * MB, 'with the CURRENT reading');
  clock += 120_000;
  await wait(80);
  assert.equal(softs.length, 2, 'and not repeated every interval while it stays high');
  mw.stop();
});

// ─── follow-up pins for the verifier's #322 MINORs (M1, M2) — tests only ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('M1 (verifier pin, `lineDebts = lineDebts.slice(plan.debtsSettled)`): kill 1 skipped its lookup (owes L1); kill 2 finds [L1, L2] → L1 set aside, the debt is SETTLED; kill 3 inside the debt TTL is named by its OWN line L3', async () => {
  const w = new World();
  w.current = 299 * MB;
  w.add(20, { comm: 'decoy', cmdline: 'decoy', adj: 1000, rssPages: 20000 });
  w.add(12, { comm: 'v1', cmdline: 'v1', adj: 1000, rssPages: 5000 });
  const kills: MemKillRecord[] = [];
  const journal: KernelOomKill[] = [];
  const mw = watchSoft(w, [], kills, { softBytes: null, kernelLog: async () => [...journal] });
  await wait(40);
  w.procs.delete(20);
  w.oomKill(12);
  assert.ok(await until(() => kills.length === 1, 8000));
  assert.equal(kills[0].source, 'inferred');
  journal.push(kline(12, 'v1')); // the line lands AFTER the first look (which, at the headroom limit, never reads the journal) — a stalled loop must not age it out of the look's 3 s window
  w.current = 100 * MB;
  w.add(13, { comm: 'v2', cmdline: 'v2', adj: 1000, rssPages: 6000 });
  await wait(30);
  w.oomKill(13);
  journal.push(kline(13, 'v2'));
  assert.ok(await until(() => kills.length === 2, 8000));
  assert.equal(kills[1].source, 'kernel');
  assert.equal(kills[1].pid, 13);
  w.add(14, { comm: 'v3', cmdline: 'v3', adj: 1000, rssPages: 7000 });
  await wait(30);
  w.oomKill(14);
  journal.push(kline(14, 'v3'));
  assert.ok(await until(() => kills.length === 3, 8000));
  mw.stop();
  assert.equal(kills[2].source, 'kernel', `kill 3 (pid 14) is named by its own line, not eaten by the settled debt: got ${kills[2].source} pid=${kills[2].pid}`);
  assert.equal(kills[2].pid, 14);
});

test('M2 (`softSuppressed = 0`): the «N further crossing(s)» of a told warning counts only the crossings swallowed SINCE the previous told warning — never the ones it already told', async () => {
  const w = new World();
  w.current = 100 * MB;
  const softs: MemSoftRecord[] = [];
  let clock = 5_000_000;
  const mw = startMemoryWatch({ cgroupDir: DIR, unit: 'u.scope', onKill: () => {}, onSoft: (r) => softs.push(r), softBytes: 200 * MB, softMinIntervalMs: 30_000, now: () => clock, log: () => {}, readFile: w.read, hotMs: 5, fastMs: 5, idleMs: 5, pageSize: 4096 });
  const cross = async (advance: number): Promise<void> => {
    w.current = 100 * MB;
    await wait(40); // re-armed
    clock += advance;
    w.current = 250 * MB;
  };
  w.current = 230 * MB;
  assert.ok(await until(() => softs.length === 1, 8000));
  await cross(5_000); // inside the 30 s bound: swallowed (1)
  await wait(40);
  await cross(5_000); // swallowed (2)
  await wait(40);
  assert.equal(softs.length, 1, 'both swallowed');
  await cross(31_000); // the bound is over: told, with the two it swallowed
  assert.ok(await until(() => softs.length === 2, 8000));
  assert.equal(softs[1].suppressed, 2);
  await cross(5_000); // swallowed (1 since the last told one)
  await wait(40);
  await cross(31_000);
  assert.ok(await until(() => softs.length === 3, 8000));
  assert.equal(softs[2].suppressed, 1, 'only the one swallowed since the previous told warning (3 would re-count the two already told)');
  mw.stop();
});

/** A manual clock + an empty-then-filled journal: kills whose lookup finds NO line owe it (debts), deterministically — no headroom wait, no debt TTL running on the wall clock. */
function debtWorld() {
  const w = new World();
  w.current = 100 * MB;
  const kills: MemKillRecord[] = [];
  const journal: KernelOomKill[] = [];
  const clock = 5_000_000;
  const mw = watchSoft(w, [], kills, { softBytes: null, now: () => clock, kernelLog: async () => [...journal] });
  /** A victim + a bigger decoy that exits at the same moment: the inference names the DECOY, the kernel line names the victim. */
  const kill = async (victim: number, decoy: number): Promise<void> => {
    w.add(decoy, { comm: `d${decoy}`, cmdline: `d${decoy}`, adj: 1000, rssPages: 20000 });
    w.add(victim, { comm: `v${victim}`, cmdline: `v${victim}`, adj: 1000, rssPages: 5000 });
    await wait(30);
    w.procs.delete(decoy);
    w.oomKill(victim);
  };
  return { w, kills, journal, mw, kill };
}

test('M1b (over/under-settling, `lineDebts = lineDebts.slice(plan.debtsSettled)`): two kills owe their lines; one round finds both and pairs the third kill; the FOURTH kill, inside the debt TTL, is named by its OWN line', async () => {
  const { kills, journal, mw, kill } = debtWorld();
  await wait(40);
  await kill(12, 20); // journal empty: the lookup polls, finds nothing, the kill stays inferred and OWES its line
  assert.ok(await until(() => kills.length === 1, 8000));
  await kill(13, 21);
  assert.ok(await until(() => kills.length === 2, 8000));
  assert.deepEqual(kills.map((k) => k.source), ['inferred', 'inferred']);
  journal.push(kline(12, 'v12'), kline(13, 'v13')); // the two late lines
  await kill(14, 22);
  journal.push(kline(14, 'v14'));
  assert.ok(await until(() => kills.length === 3, 8000));
  assert.equal(kills[2].source, 'kernel');
  assert.equal(kills[2].pid, 14, 'the third kill is paired with ITS line, the two late ones set aside');
  await kill(15, 23);
  journal.push(kline(15, 'v15'));
  assert.ok(await until(() => kills.length === 4, 8000));
  mw.stop();
  assert.equal(kills[3].pid, 15, `the fourth kill is named by its own line, not eaten by debts the third round already settled: got ${kills[3].source} pid=${kills[3].pid}`);
  assert.equal(kills[3].source, 'kernel');
});

test('M1c (settle exactly what was found, also when the round cannot pair): two debts, a round that finds only ONE of the late lines settles ONE (and owes its own); the later lines then go to the debts, and the next kill is named by its own line', async () => {
  const { kills, journal, mw, kill } = debtWorld();
  await wait(40);
  await kill(12, 20);
  assert.ok(await until(() => kills.length === 1, 8000));
  await kill(13, 21);
  assert.ok(await until(() => kills.length === 2, 8000));
  journal.push(kline(12, 'v12')); // only the FIRST late line is in the journal when kill 3 looks
  await kill(14, 22);
  assert.ok(await until(() => kills.length === 3, 8000));
  assert.equal(kills[2].source, 'inferred', 'nothing honest to pair: it stays a guess and owes its line');
  journal.push(kline(13, 'v13'), kline(14, 'v14')); // the rest arrive late
  await kill(15, 23);
  journal.push(kline(15, 'v15'));
  assert.ok(await until(() => kills.length === 4, 8000));
  mw.stop();
  assert.equal(kills[3].pid, 15, `exactly the debts still owed (2) are set aside, the fourth kill keeps its own line: got ${kills[3].source} pid=${kills[3].pid}`);
  assert.equal(kills[3].source, 'kernel');
});

test('M2b (the reset also covers the DEFERRED warning): a crossing swallowed by the rate bound and told later (deferred) counts once; the next told warning counts only what was swallowed since', async () => {
  const w = new World();
  w.current = 100 * MB;
  const softs: MemSoftRecord[] = [];
  let clock = 5_000_000;
  const mw = startMemoryWatch({ cgroupDir: DIR, unit: 'u.scope', onKill: () => {}, onSoft: (r) => softs.push(r), softBytes: 200 * MB, softMinIntervalMs: 30_000, now: () => clock, log: () => {}, readFile: w.read, hotMs: 5, fastMs: 5, idleMs: 5, pageSize: 4096 });
  w.current = 230 * MB;
  assert.ok(await until(() => softs.length === 1, 8000));
  w.current = 100 * MB;
  await wait(40);
  clock += 5_000;
  w.current = 280 * MB; // swallowed (1) — and it STAYS high
  await wait(60);
  assert.equal(softs.length, 1);
  clock += 31_000; // bound over, still high: the DEFERRED warning, with the one swallowed crossing
  assert.ok(await until(() => softs.length === 2, 8000));
  assert.equal(softs[1].suppressed, 1);
  w.current = 100 * MB;
  await wait(40); // re-armed
  clock += 5_000;
  w.current = 250 * MB; // swallowed again (1 since the deferred one)
  await wait(60);
  w.current = 100 * MB;
  await wait(40);
  clock += 31_000;
  w.current = 250 * MB;
  assert.ok(await until(() => softs.length === 3, 8000));
  mw.stop();
  assert.equal(softs[2].suppressed, 1, 'only the crossing swallowed since the deferred warning (2 would re-count the one it already told)');
});
