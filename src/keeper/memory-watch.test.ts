// The keeper's kill watch against a VIRTUAL cgroup + /proc (every read goes through `readFile`): a kill is a counter move plus a member that vanished.
// The real thing — a real scope, a real OOM kill — is scripts/e2e-memory-cap.mjs; this pins the decision logic and its edges without systemd.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPageSize, startMemoryWatch } from './memory-watch.ts';
import type { MemKillRecord } from '../shared/memory-scope.ts';

const DIR = '/vcg/scope';
type Proc = { start: number; comm: string; cmdline: string; rssPages: number; adj: number };

class World {
  procs = new Map<number, Proc>();
  events = { high: 0, max: 0, oom: 0, oom_kill: 0, oom_group_kill: 0 };
  maxBytes = 300 * 1024 * 1024;
  current = 100 * 1024 * 1024;
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
