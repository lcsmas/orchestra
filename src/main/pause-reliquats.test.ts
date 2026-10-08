// #325 — the Reliquat killer (ledger #329, FI-1 v1). Two layers, like pause-kill.test.ts:
//  (1) a FAKE OS drives `killReliquats` through the races the destructive-act rules name (pid recycled between plan and signal, a process that leaves the scope,
//      SIGTERM ignored, a Reliquat born mid-kill, an unreadable scope, a lift mid-kill, a human turn's window);
//  (2) REAL processes: detached Reliquats of a fake scope (the scope MEMBERSHIP is a registry, every /proc read and every signal is real), a stand-in keeper/CLI/MCP that must
//      survive, and a bystander OUTSIDE the scope that must survive. The real-keeper-in-a-real-scope proof is the rig (scripts/pause-trap/reliquat-arm.mjs).
// Each arm names the clause it protects (in-place mutants: scripts/pause-trap/mutants-reliquats.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { killReliquats, type ReliquatScopeDeps } from './pause-reliquats.ts';
import { realKillDeps, type KillDeps } from './pause-kill.ts';
import type { FreshRead, ProcIdent } from '../shared/pause-procs.ts';
import type { ScopeListing, ScopeMember, ScopeRef, ScopeRole } from '../shared/pause-reliquats.ts';

const SCOPE: ScopeRef = { unit: 'orchestra-rig-wh-m1-abc123.scope', cgroupDir: '/sys/fs/cgroup/x/orchestra-rig-wh-m1-abc123.scope' };

// ── (1) fake OS ─────────────────────────────────────────────────────────────

class FakeOs {
  procs = new Map<number, ProcIdent>();
  roles = new Map<number, ScopeRole>();
  ignoresTerm = new Set<number>();
  signals: Array<{ pid: number; sig: string }> = [];
  clock = 0;
  listCalls = 0;
  scopeNames: ScopeRef[] = [SCOPE];
  scopesThrow = false;
  listing: 'ok' | 'unreadable' | 'gone' = 'ok';
  /** run on every list() call (the plan→signal window) / sleep (time passing). */
  onList: ((n: number) => void) | null = null;
  onSleep: (() => void) | null = null;
  /** run after every DELIVERED signal (a process respawning as it is killed). */
  onSignal: ((pid: number, sig: string) => void) | null = null;
  unreadable = new Set<number>();
  supported = true;
  starts = new Map<number, number>();

  add(pid: number, ppid: number, argv: string[], role: ScopeRole = 'reliquat', startTicks = 1000 + pid): ProcIdent {
    const p: ProcIdent = { pid, ppid, sid: pid, startTicks, comm: argv[0].split('/').pop()!.slice(0, 15), state: 'S', argv };
    this.procs.set(pid, p);
    this.roles.set(pid, role);
    return p;
  }
  die(pid: number): void {
    this.procs.delete(pid);
    this.roles.delete(pid);
  }
  scopeDeps(): ReliquatScopeDeps {
    return {
      scopes: () => {
        if (this.scopesThrow) throw new Error('boom');
        return this.scopeNames;
      },
      list: (): ScopeListing => {
        this.listCalls++;
        this.onList?.(this.listCalls);
        if (this.listing !== 'ok') return this.listing;
        return [...this.procs.values()].map((p): ScopeMember => ({ pid: p.pid, startTicks: p.startTicks, ppid: p.ppid, comm: p.comm, role: this.roles.get(p.pid) ?? 'reliquat' }));
      },
    };
  }
  deps(): KillDeps {
    return {
      supported: this.supported,
      selfPid: 10,
      now: () => this.clock,
      sleep: async (ms) => {
        this.clock += ms;
        this.onSleep?.();
      },
      readTable: () => [...this.procs.values()],
      read: (pid): FreshRead => {
        if (this.unreadable.has(pid)) return 'unreadable';
        const x = this.procs.get(pid);
        return x ? { ...x } : 'gone';
      },
      readClaudePid: () => null,
      readCwd: (pid) => (this.procs.has(pid) ? `/w/${pid}` : null),
      startMs: (t) => this.starts.get(t) ?? t,
      signal: (pid, sig) => {
        this.signals.push({ pid, sig });
        if (!this.procs.has(pid)) return false;
        if (sig === 'SIGTERM' && this.ignoresTerm.has(pid)) return true;
        this.die(pid);
        this.onSignal?.(pid, sig);
        return true;
      },
    };
  }
}

const OPTS = { keeperPid: 90, cliPid: 100, termGraceMs: 100 };

test('a member with NO tracked scope: nothing is looked at, null (the Pause keeps today\'s behaviour, the Bilan stays byte-identical)', async () => {
  const os = new FakeOs();
  os.scopeNames = [];
  os.add(500, 1, ['chrome']);
  assert.equal(await killReliquats('m1', os.scopeDeps(), os.deps(), OPTS), null);
  assert.deepEqual(os.signals, []);
  assert.equal(os.listCalls, 0, 'no scope ⇒ not even listed');
});

test('kills a detached Reliquat — SIGTERM, then the Bilan facts (command, pid, start time, evidence) — and leaves keeper / CLI / MCP server / a bystander OUTSIDE the scope alone', async () => {
  const os = new FakeOs();
  os.add(90, 1, ['node', '/x/keeper.js', 'm1'], 'keeper');
  os.add(100, 90, ['claude', '--print'], 'cli');
  os.add(101, 100, ['node', 'mcp-server.js'], 'session');
  os.add(500, 1, ['/usr/bin/chrome', '--headless']); // env -i, double-forked: ppid=1
  os.add(501, 500, ['/usr/bin/chrome', '--type=renderer']);
  const rep = await killReliquats('m1', os.scopeDeps(), os.deps(), OPTS);
  assert.ok(rep);
  assert.deepEqual(rep.scopes, [SCOPE.unit]);
  assert.deepEqual(rep.killed.map((k) => k.pid).sort(), [500, 501]);
  assert.deepEqual([...os.procs.keys()].sort((a, b) => a - b), [90, 100, 101], 'the session survives');
  const k = rep.killed.find((x) => x.pid === 500)!;
  assert.deepEqual([k.signal, k.outcome, k.startTicks, k.cwd, k.scope, k.cmd], ['SIGTERM', 'exited', 1500, '/w/500', SCOPE.unit, '/usr/bin/chrome --headless']);
  assert.match(k.evidence, /role reliquat/);
  assert.equal(typeof k.startedAt, 'number');
  assert.deepEqual([rep.survivors, rep.refused, rep.spared, rep.unknown], [[], [], [], undefined]);
});

test('CHILDREN FIRST: a Reliquat\'s children are signalled before it (the parent cannot respawn them)', async () => {
  const os = new FakeOs();
  os.add(500, 1, ['chrome']);
  os.add(501, 500, ['chrome', '--type=zygote']);
  os.add(502, 501, ['chrome', '--type=renderer']);
  await killReliquats('m1', os.scopeDeps(), os.deps(), OPTS);
  assert.deepEqual(os.signals.map((s) => s.pid), [502, 501, 500]);
});

test('the keeper / CLI the trap PROVED are untouched even when the scope\'s classification calls them Reliquats (stale pid file), and so is a keeper.js / claude by name and anything under it', async () => {
  const os = new FakeOs();
  os.add(90, 1, ['node', '/x/keeper.js', 'mX'], 'reliquat'); // wrongly classified (and a keeper id that is not m1's: the own-keeper window is the next arm)
  os.add(100, 90, ['claude'], 'reliquat');
  os.add(101, 100, ['node', 'mcp-server.js'], 'reliquat');
  os.add(600, 1, ['node', '/other/keeper.js', 'm9'], 'reliquat'); // a supervisor that is not the proven one
  os.add(500, 1, ['/usr/bin/chrome']);
  const rep = await killReliquats('m1', os.scopeDeps(), os.deps(), OPTS);
  assert.ok(rep);
  assert.deepEqual(rep.killed.map((k) => k.pid), [500]);
  assert.deepEqual([...os.procs.keys()].sort((a, b) => a - b), [90, 100, 101, 600]);
  assert.ok(rep.spared.some((s) => s.pid === 600), 'a supervisor outside the proven session is spared AND listed');
  assert.ok(rep.refused.some((s) => s.pid === 90) && rep.refused.some((s) => s.pid === 100), 'the proven keeper/CLI are refused as protected pids');
  assert.deepEqual(os.signals.filter((s) => [90, 100, 101, 600].includes(s.pid)), []);
});

test('SIGTERM ignored ⇒ escalates to SIGKILL after a SECOND fresh listing + identity re-read; the report says SIGKILL', async () => {
  const os = new FakeOs();
  os.add(500, 1, ['chrome']);
  os.ignoresTerm.add(500);
  const rep = await killReliquats('m1', os.scopeDeps(), os.deps(), OPTS);
  assert.deepEqual(os.signals, [{ pid: 500, sig: 'SIGTERM' }, { pid: 500, sig: 'SIGKILL' }]);
  assert.equal(rep!.killed[0].signal, 'SIGKILL');
  assert.equal(rep!.killed[0].outcome, 'exited');
});

test('RECYCLED PID between the SIGTERM and the SIGKILL: the SIGKILL goes to nobody (the new owner of the pid has another start-time)', async () => {
  const os = new FakeOs();
  os.add(500, 1, ['chrome'], 'reliquat', 1500);
  os.ignoresTerm.add(500);
  let recycled = false;
  os.onSleep = () => {
    if (recycled) return;
    recycled = true;
    os.add(500, 1, ['an-innocent-tool'], 'session', 7777); // the pid is now an unrelated process of the live session
    os.ignoresTerm.delete(500);
  };
  const rep = await killReliquats('m1', os.scopeDeps(), os.deps(), OPTS);
  assert.deepEqual(os.signals.filter((s) => s.sig === 'SIGKILL'), [], 'no SIGKILL to the recycled pid');
  assert.ok(os.procs.has(500), 'the innocent survives');
  assert.ok(!os.signals.some((s) => s.sig === 'SIGKILL'), 'no SIGKILL at all');
  assert.equal(rep!.killed.length, 1, 'the planned (old) process stays listed as signalled with SIGTERM');
  assert.equal(rep!.killed[0].signal, 'SIGTERM');
});

test('a process that LEFT the scope between the plan and the signal is never signalled (membership is re-read at signal time)', async () => {
  const os = new FakeOs();
  os.add(500, 1, ['chrome']);
  os.add(501, 1, ['chrome']);
  os.onList = (n) => {
    // plan = the first listing; the very next one (the first signal's re-read) no longer holds pid 501's cgroup membership: it moved out
    if (n === 2) os.roles.delete(501), os.procs.delete(501);
  };
  const rep = await killReliquats('m1', os.scopeDeps(), os.deps(), { ...OPTS, maxRounds: 1 });
  assert.ok(!os.signals.some((s) => s.pid === 501), 'pid 501 left the scope: untouched');
  assert.deepEqual(rep!.killed.map((k) => k.pid), [500]);
});

test('a Reliquat BORN while killing is caught by the next round (re-plan from a fresh listing)', async () => {
  const os = new FakeOs();
  os.add(500, 1, ['chrome']);
  let born = false;
  os.onSignal = () => {
    if (born) return;
    born = true;
    os.add(502, 1, ['chrome', '--late']);
  };
  const rep = await killReliquats('m1', os.scopeDeps(), os.deps(), OPTS);
  assert.deepEqual(rep!.killed.map((k) => k.pid).sort(), [500, 502]);
  assert.equal(rep!.rounds, 2);
  assert.equal(os.procs.has(502), false);
});

test('a Reliquat that never dies is reported as a SURVIVOR after the bounded rounds (never hidden)', async () => {
  const os = new FakeOs();
  os.add(500, 1, ['chrome']);
  const d = os.deps();
  const rep = await killReliquats('m1', os.scopeDeps(), { ...d, signal: (pid, sig) => { os.signals.push({ pid, sig }); return true; } }, OPTS); // delivered, but the process survives even SIGKILL
  assert.deepEqual(rep!.survivors.map((s) => [s.pid, s.reason]), [[500, 'still-alive-after-kill']]);
  assert.equal(rep!.killed[0].outcome, 'survived');
  assert.equal(rep!.rounds, 3, 'bounded');
});

test('UNKNOWN is not NONE: an unreadable scope listing kills nothing and sets `unknown` (the trap retries); a failing scope lookup too; a vanished scope is clean', async () => {
  const os = new FakeOs();
  os.add(500, 1, ['chrome']);
  os.listing = 'unreadable';
  const a = await killReliquats('m1', os.scopeDeps(), os.deps(), OPTS);
  assert.match(a!.unknown ?? '', /cgroup\.procs unreadable/);
  assert.deepEqual(os.signals, []);
  os.listing = 'ok';
  os.scopesThrow = true;
  const b = await killReliquats('m1', os.scopeDeps(), os.deps(), OPTS);
  assert.match(b!.unknown ?? '', /scope lookup failed: boom/);
  assert.deepEqual(os.signals, []);
  os.scopesThrow = false;
  os.listing = 'gone';
  const c = await killReliquats('m1', os.scopeDeps(), os.deps(), OPTS);
  assert.equal(c!.unknown, undefined);
  assert.deepEqual(c!.killed, []);
});

test('an unsupported platform kills nothing (fail closed) and says so', async () => {
  const os = new FakeOs();
  os.supported = false;
  os.add(500, 1, ['chrome']);
  const rep = await killReliquats('m1', os.scopeDeps(), os.deps(), OPTS);
  assert.match(rep!.error ?? '', /nothing killed \(fail closed\)/);
  assert.deepEqual(os.signals, []);
});

test('the pause LIFTED mid-kill: no further signal is sent, `aborted: lifted`, what was already killed stays listed', async () => {
  const os = new FakeOs();
  os.add(500, 1, ['chrome']);
  os.add(501, 1, ['chrome']);
  let calls = 0;
  const rep = await killReliquats('m1', os.scopeDeps(), os.deps(), { ...OPTS, stillPaused: () => ++calls <= 2 }); // round check, first signal check, then lifted
  assert.equal(rep!.aborted, 'lifted');
  assert.equal(os.signals.length, 1, 'only the signal sent before the lift');
  assert.equal(rep!.killed.length, 1);
});

test('a lift BEFORE the first round sends nothing at all', async () => {
  const os = new FakeOs();
  os.add(500, 1, ['chrome']);
  const rep = await killReliquats('m1', os.scopeDeps(), os.deps(), { ...OPTS, stillPaused: () => false });
  assert.deepEqual(os.signals, []);
  assert.equal(rep!.aborted, 'lifted');
});

test('D9 — a Reliquat that started inside a HUMAN turn\'s window (or after `startedBeforeMs`) is spared and listed; an older one is killed', async () => {
  const os = new FakeOs();
  os.add(500, 1, ['chrome', '--old'], 'reliquat', 1500);
  os.add(501, 1, ['chrome', '--human-turn'], 'reliquat', 5501);
  os.starts.set(1500, 1_000); // epoch ms of the starts
  os.starts.set(5501, 5_500);
  const rep = await killReliquats('m1', os.scopeDeps(), os.deps(), { ...OPTS, humanWindows: () => [{ from: 5_000, to: 6_000 }] });
  assert.deepEqual(rep!.killed.map((k) => k.pid), [500]);
  assert.ok(os.procs.has(501));
  assert.ok(rep!.spared.some((s) => s.pid === 501 && /HUMAN turn/.test(s.reason)));
  // a fixed cutoff does the same
  const os2 = new FakeOs();
  os2.add(500, 1, ['chrome'], 'reliquat', 1500);
  os2.add(501, 1, ['chrome'], 'reliquat', 5501);
  os2.starts.set(1500, 1_000);
  os2.starts.set(5501, 5_500);
  const rep2 = await killReliquats('m1', os2.scopeDeps(), os2.deps(), { ...OPTS, startedBeforeMs: () => 5_000 });
  assert.deepEqual(rep2!.killed.map((k) => k.pid), [500]);
});

test('the pausing call\'s own process chain (the pauser) is never signalled', async () => {
  const os = new FakeOs();
  os.add(500, 1, ['chrome']);
  os.add(510, 1, ['setsid-ed', 'orchestra', 'run', 'pause']);
  const rep = await killReliquats('m1', os.scopeDeps(), os.deps(), { ...OPTS, protectPids: [510] });
  assert.deepEqual(rep!.killed.map((k) => k.pid), [500]);
  assert.ok(os.procs.has(510));
});

test('write-ahead: `onProgress` fires after the SIGTERM batch with the killed list, BEFORE the grace wait ends', async () => {
  const os = new FakeOs();
  os.add(500, 1, ['chrome']);
  os.ignoresTerm.add(500);
  const seen: Array<{ killed: number; clock: number }> = [];
  await killReliquats('m1', os.scopeDeps(), os.deps(), { ...OPTS, termGraceMs: 400, onProgress: (r) => seen.push({ killed: r.killed.length, clock: os.clock }) });
  assert.equal(seen[0].killed, 1);
  assert.equal(seen[0].clock, 0, 'persisted before any waiting');
});

test('a second scope generation (a restart while Reliquats kept the old scope alive) is walked too, each member judged against ITS scope\'s listing', async () => {
  const os = new FakeOs();
  const OLD: ScopeRef = { unit: 'orchestra-rig-wh-m1-abc000.scope', cgroupDir: '/x/old' };
  os.scopeNames = [OLD, SCOPE];
  os.add(500, 1, ['chrome']);
  const rep = await killReliquats('m1', os.scopeDeps(), os.deps(), OPTS);
  assert.deepEqual(rep!.scopes.sort(), [OLD.unit, SCOPE.unit].sort());
  assert.ok(rep!.killed.length >= 1);
});

test('the keeper\'s pid file is NOT published yet (FI-1 reads keeperPid null): this member\'s own keeper, CLI and MCP server all read `reliquat` — NOTHING in the scope is signalled, the scope is UNKNOWN (the trap retries); another workspace\'s keeper.js does not block it', async () => {
  const os = new FakeOs();
  os.add(90, 1, ['node', '/x/keeper.js', 'm1', '/s.sock', '/s.pid', '/s.log'], 'reliquat'); // wrongly classified: the window between listen and the pid file
  os.add(100, 90, ['claude'], 'reliquat');
  os.add(101, 100, ['node', 'mcp-server.js'], 'reliquat');
  os.add(500, 1, ['/usr/bin/chrome', '--headless']); // a genuine Reliquat of the same scope
  const rep = await killReliquats('m1', os.scopeDeps(), os.deps(), { keeperPid: null, cliPid: null, termGraceMs: 100 });
  assert.deepEqual(os.signals, [], 'not even the genuine Reliquat: the roles of this scope cannot be trusted this round');
  assert.match(rep!.unknown ?? '', /own keeper \(pid 90\) is listed as a Reliquat — its pid file is not published yet/);
  assert.deepEqual(rep!.killed, []);
  // the keeper is published: the very same scope is now killable
  os.roles.set(90, 'keeper'); os.roles.set(100, 'cli'); os.roles.set(101, 'session');
  const ok = await killReliquats('m1', os.scopeDeps(), os.deps(), { keeperPid: null, cliPid: null, termGraceMs: 100 });
  assert.deepEqual(ok!.killed.map((k) => k.pid), [500]);
  assert.equal(ok!.unknown, undefined);
  // a keeper.js of ANOTHER workspace listed as a Reliquat (a nested rig app) is spared on its own but does not block the scope
  const o2 = new FakeOs();
  o2.add(600, 1, ['node', '/other/keeper.js', 'm9'], 'reliquat');
  o2.add(500, 1, ['/usr/bin/chrome']);
  const r2 = await killReliquats('m1', o2.scopeDeps(), o2.deps(), OPTS);
  assert.deepEqual(r2!.killed.map((k) => k.pid), [500]);
  assert.ok(o2.procs.has(600));
});

// ── (2) REAL processes ──────────────────────────────────────────────────────

const real = realKillDeps();
const spawned: Array<{ pid: number; startTicks: number }> = [];
const idOf = (pid: number): { pid: number; startTicks: number } => {
  const id = real.read(pid);
  assert.ok(id !== 'gone' && id !== 'unreadable', `process ${pid} exists`);
  const r = { pid, startTicks: (id as ProcIdent).startTicks };
  spawned.push(r);
  return r;
};
/** A plain child of this test (the stand-in keeper / CLI / MCP server). */
function launch(argv: string[]): { pid: number; startTicks: number } {
  const c = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' });
  c.unref();
  return idOf(c.pid as number);
}
const q = (a: string): string => `'${a.replace(/'/g, `'\\''`)}'`;
/** A REAL orphan, as the incident's rig browsers were: started by a shell that exits at once (`cmd &`), new session, no env marker — reparented away from this test's process tree.
 *  (`spawn('setsid', …)` would NOT do: setsid(1) forks when its parent leads a group and the pid we hold exits.) */
function launchOrphan(argv: string[]): { pid: number; startTicks: number } {
  const out = execFileSync('sh', ['-c', `setsid ${argv.map(q).join(' ')} </dev/null >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' });
  return idOf(Number(out.trim()));
}
const alive = (r: { pid: number; startTicks: number }): boolean => {
  const f = real.read(r.pid);
  return f !== 'gone' && f !== 'unreadable' && f.startTicks === r.startTicks && f.state !== 'Z';
};
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
test.after(() => {
  // teardown BY IDENTITY: only what this file launched, only while it is still the same process
  let left = 0;
  for (const r of spawned) if (alive(r)) { try { process.kill(r.pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const r of spawned) if (alive(r)) left++;
  console.log(`# pause-reliquats.test: ${spawned.length} real processes launched, ${left} left after teardown`);
});

/** A scope whose MEMBERSHIP is a registry (the scope manager's cgroup.procs), every other read is the real /proc. */
function realScope(registry: Map<number, ScopeRole>): ReliquatScopeDeps {
  return {
    scopes: () => [SCOPE],
    list: () => {
      const out: ScopeMember[] = [];
      for (const [pid, role] of registry) {
        const f = real.read(pid);
        if (f === 'gone' || f === 'unreadable' || f.state === 'Z') continue;
        out.push({ pid, startTicks: f.startTicks, ppid: f.ppid, comm: f.comm, role });
      }
      return out;
    },
  };
}
const childrenOf = (ppid: number): number[] => fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number).filter((p) => { const f = real.read(p); return f !== 'gone' && f !== 'unreadable' && f.ppid === ppid; });

const TAG = 7800 + (process.pid % 90);

test('REAL processes: detached orphans of the scope are killed; the stand-in keeper/CLI/MCP and a bystander OUTSIDE the scope survive — and the premise holds (the orphans really ARE orphans, alive BEFORE the kill)', async () => {
  const keeper = launch(['node', '-e', 'setInterval(()=>{},1e6)', 'keeper.js', `ws-${TAG}`]);
  const cli = launch(['bash', '-c', `exec -a claude sleep ${TAG + 1}`]);
  const mcp = launch(['sleep', String(TAG + 2)]);
  const reliquat1 = launchOrphan(['sleep', String(TAG + 3)]);
  const reliquat2 = launchOrphan(['sh', '-c', `sleep ${TAG + 4} & wait`]);
  const bystander = launchOrphan(['sleep', String(TAG + 5)]); // another workspace's / the human's process: NOT in the scope registry
  await settle(300);
  for (const [name, r] of [['keeper', keeper], ['cli', cli], ['mcp', mcp], ['reliquat1', reliquat1], ['reliquat2', reliquat2], ['bystander', bystander]] as const) assert.equal(alive(r), true, `${name} is alive BEFORE the kill (a premise, not a result)`);
  const orphanParent = real.read(reliquat1.pid) as ProcIdent;
  assert.notEqual(orphanParent.ppid, process.pid, 'reparented away from this test');
  const kids = childrenOf(reliquat2.pid);
  assert.ok(kids.length >= 1, 'the shell Reliquat has a live child');
  const registry = new Map<number, ScopeRole>([[keeper.pid, 'keeper'], [cli.pid, 'cli'], [mcp.pid, 'session'], [reliquat1.pid, 'reliquat'], [reliquat2.pid, 'reliquat']]);
  for (const k of kids) registry.set(k, 'reliquat'); // the cgroup holds every descendant
  const rep = await killReliquats('m1', realScope(registry), real, { keeperPid: keeper.pid, cliPid: cli.pid, termGraceMs: 1500 });
  assert.ok(rep);
  assert.equal(alive(reliquat1), false, 'the detached Reliquat is dead');
  assert.equal(alive(reliquat2), false, 'the detached shell is dead');
  for (const k of kids) assert.equal(real.read(k) === 'gone' || (real.read(k) as ProcIdent).state === 'Z', true, 'its child too');
  assert.equal(alive(keeper), true, 'the keeper survives');
  assert.equal(alive(cli), true, 'the CLI survives');
  assert.equal(alive(mcp), true, 'the MCP server survives');
  assert.equal(alive(bystander), true, 'a process OUTSIDE the scope is never touched');
  // the shell Reliquat exits BY ITSELF the moment its child (killed first) is gone: it is then not signalled, and not listed as killed — either outcome is correct
  const killedPids = rep.killed.map((k) => k.pid);
  assert.ok(killedPids.includes(reliquat1.pid) && kids.every((k) => killedPids.includes(k)), `killed: ${killedPids.join(',')}`);
  assert.ok(killedPids.every((p) => [reliquat1.pid, reliquat2.pid, ...kids].includes(p)), 'nothing but the scope\'s Reliquats was signalled');
  assert.deepEqual(rep.survivors, []);
  for (const k of rep.killed) assert.equal(k.outcome, 'exited');
});

test('REAL: a SIGTERM-ignoring orphan is escalated to SIGKILL and dies; a start-time that changed since the plan is NOT the planned process (refused, survives)', async () => {
  const stubborn = launchOrphan(['node', '-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1e6)"]);
  const innocent = launchOrphan(['sleep', String(TAG + 6)]);
  await settle(500);
  assert.equal(alive(stubborn), true, 'premise: alive before');
  assert.equal(alive(innocent), true, 'premise: alive before');
  const rep = await killReliquats('m1', realScope(new Map<number, ScopeRole>([[stubborn.pid, 'reliquat']])), real, { keeperPid: null, cliPid: null, termGraceMs: 300 });
  assert.equal(alive(stubborn), false);
  assert.equal(rep!.killed[0].signal, 'SIGKILL');
  // identity: the planned process is replaced in the scope listing by another start-time for the same pid ⇒ nothing is signalled
  let n = 0;
  const flip: ReliquatScopeDeps = { scopes: () => [SCOPE], list: () => [{ pid: innocent.pid, startTicks: innocent.startTicks + (++n > 1 ? 1 : 0), ppid: 1, comm: 'sleep', role: 'reliquat' }] };
  const rep2 = await killReliquats('m1', flip, real, { keeperPid: null, cliPid: null, termGraceMs: 100, maxRounds: 1 });
  assert.equal(alive(innocent), true, 'a start-time that changed since the plan is not the planned process');
  assert.ok(rep2!.refused.some((r) => /reused/.test(r.reason)));
});

test('REAL: an orphan that still has a `claude`-named ANCESTOR (a mis-classified session) is spared, a process named keeper.js is spared — by what they are, whatever the scope says', async () => {
  const claudeLike = launch(['bash', '-c', `exec -a claude bash -c "sleep ${TAG + 7} & wait"`]);
  await settle(300);
  const sleepKid = childrenOf(claudeLike.pid).flatMap((p) => childrenOf(p).concat(p)).find((p) => (real.read(p) as ProcIdent).argv?.[0] === 'sleep');
  assert.ok(sleepKid, 'premise: a sleep under a claude-named process');
  const keeperLike = launch(['node', '-e', 'setInterval(()=>{},1e6)', 'keeper.js', 'other-ws']);
  const registry = new Map<number, ScopeRole>([[claudeLike.pid, 'reliquat'], [sleepKid as number, 'reliquat'], [keeperLike.pid, 'reliquat']]);
  const rep = await killReliquats('m1', realScope(registry), real, { keeperPid: null, cliPid: null, termGraceMs: 100 });
  assert.equal(alive(claudeLike), true);
  assert.equal(alive(keeperLike), true);
  assert.equal(real.read(sleepKid as number) !== 'gone', true, 'the child of the claude-named process survives');
  assert.deepEqual(rep!.killed, []);
  assert.ok(rep!.spared.length >= 3, `spared and listed: ${JSON.stringify(rep!.spared.map((x) => x.pid))}`);
});
