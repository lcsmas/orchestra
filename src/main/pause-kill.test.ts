// #252 D1b — the pause trap's process killer. Two layers:
//  (1) a FAKE OS model drives killToolTrees through the races D4 names (pid recycled between
//      plan and signal, SIGTERM ignored then pid recycled before SIGKILL, a tool spawned
//      mid-kill, an unreadable identity, an unsupported platform);
//  (2) REAL processes: a stand-in CLI with real tool shells, a backgrounded orphan that
//      outlived its shell (sid keeps it ours), an MCP-like sidecar that must be spared, and a
//      bystander that must survive.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { killToolTrees, realKillDeps, startWallMs, type KillDeps } from './pause-kill.ts';
import type { FreshRead, ProcIdent } from '../shared/pause-procs.ts';

// ── (1) fake OS ─────────────────────────────────────────────────────────────

class FakeOs {
  procs = new Map<number, ProcIdent>();
  ignoresTerm = new Set<number>();
  signals: Array<{ pid: number; sig: string; target: ProcIdent | undefined }> = [];
  clock = 0;
  /** run once, right after the first readTable() returns (the plan→signal window). */
  afterTable: (() => void) | null = null;
  /** run on every sleep (time passing: a tool may spawn, a pid may be recycled). */
  onSleep: (() => void) | null = null;
  unreadable = new Set<number>();
  /** CLAUDE_PID per pid (what /proc/<pid>/environ would say). */
  env = new Map<number, number>();
  /** cwd per pid (what /proc/<pid>/cwd would say). */
  cwds = new Map<number, string>();
  /** run after every delivered signal (a tool respawning as it is killed). */
  onSignal: ((pid: number, sig: string) => void) | null = null;
  supported = true;

  add(p: ProcIdent): void {
    this.procs.set(p.pid, p);
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
      readTable: () => {
        const snap = [...this.procs.values()].map((x) => ({ ...x }));
        const hook = this.afterTable;
        this.afterTable = null;
        hook?.();
        return snap;
      },
      read: (pid): FreshRead => {
        if (this.unreadable.has(pid)) return 'unreadable';
        const x = this.procs.get(pid);
        return x ? { ...x } : 'gone';
      },
      readClaudePid: (pid) => (this.unreadable.has(pid) ? 'unreadable' : (this.env.get(pid) ?? null)),
      readCwd: (pid) => this.cwds.get(pid) ?? null,
      startMs: (t) => t,
      signal: (pid, sig) => {
        const target = this.procs.get(pid);
        this.signals.push({ pid, sig, target });
        if (!target) return false;
        if (sig === 'SIGTERM' && this.ignoresTerm.has(pid)) return true;
        this.die(pid);
        this.onSignal?.(pid, sig);
        return true;
      },
    };
  }
  die(pid: number): void {
    this.procs.delete(pid);
    for (const [k, v] of this.procs) if (v.ppid === pid) this.procs.set(k, { ...v, ppid: 1 });
  }
}

const mk = (pid: number, ppid: number, o: Partial<ProcIdent> = {}): ProcIdent => ({
  pid, ppid, sid: pid, startTicks: 2000 + pid, comm: 'x', state: 'S', argv: ['x'], ...o,
});
const shellC = (pid: number, ppid: number, cmd: string): ProcIdent =>
  mk(pid, ppid, { comm: 'zsh', argv: ['/usr/bin/zsh', '-c', cmd] });
const CLI = { pid: 100, startTicks: 1000 };

function world(): FakeOs {
  const os = new FakeOs();
  os.add(mk(1, 0));
  os.add(mk(90, 1, { comm: 'node', argv: ['node', 'keeper.js', 'ws'] }));
  os.add(mk(100, 90, { startTicks: 1000, comm: 'claude', argv: ['claude'] }));
  os.add(shellC(200, 100, 'sleep 600'));
  os.add(mk(201, 200, { sid: 200, comm: 'sleep', argv: ['sleep', '600'] }));
  os.add(mk(300, 100, { sid: 90, comm: 'node', argv: ['node', 'lazy-mcp.mjs'] })); // sidecar
  os.add(mk(999, 1, { comm: 'sleep', argv: ['sleep', '999'] })); // bystander
  return os;
}

test('fake OS: kills the tool tree leaf-first, spares the MCP sidecar, never touches CLI/keeper/bystander', async () => {
  const os = world();
  const r = await killToolTrees(CLI, 90, os.deps());
  assert.deepEqual(os.signals.map((s) => `${s.pid}:${s.sig}`), ['201:SIGTERM', '200:SIGTERM'], 'leaf before root, TERM only');
  assert.deepEqual([...os.procs.keys()].sort((a, b) => a - b), [1, 90, 100, 300, 999]);
  assert.deepEqual(r.killed.map((k) => [k.pid, k.signal, k.outcome]), [[201, 'SIGTERM', 'exited'], [200, 'SIGTERM', 'exited']]);
  assert.deepEqual(r.spared.map((s) => s.pid), [300]);
  assert.deepEqual(r.survivors, []);
  assert.deepEqual(r.refused, []);
  assert.equal(r.killed.find((k) => k.pid === 201)?.cmd, 'sleep 600');
});

test('every killed process is listed with its cmdline, cwd and the evidence the signal-time re-read proved; an env orphan names the CLI identity (pid + start-time)', async () => {
  const os = world();
  os.add(mk(700, 1, { sid: 700, startTicks: 5000, comm: 'sleep', argv: ['sleep', '7715'] })); // daemonized orphan of this CLI
  os.env.set(700, 100);
  os.cwds.set(700, '/work/tree-w1');
  os.cwds.set(201, '/work/tree-w1');
  const r = await killToolTrees(CLI, 90, os.deps());
  const orphan = r.killed.find((k) => k.pid === 700)!;
  assert.equal(orphan.via, 'env');
  assert.equal(orphan.cmd, 'sleep 7715');
  assert.equal(orphan.cwd, '/work/tree-w1');
  assert.match(orphan.evidence, /CLAUDE_PID=100 names this member's CLI \(pid 100, start-time 1000\)/);
  assert.match(orphan.evidence, /re-read now: environ CLAUDE_PID=100 == CLI 100 whose start-time 1000 was just re-verified/);
  assert.deepEqual(r.cli, CLI, 'the CLI identity the proofs were made against is part of the report');
  assert.equal(r.killed.find((k) => k.pid === 201)!.cwd, '/work/tree-w1');
});

test('F8: a lift landing mid-kill stops the signals at once (re-checked before every round AND every signal); nothing after the lift is touched', async () => {
  const os = world();
  os.add(shellC(400, 100, 'make'));
  os.add(mk(401, 400, { sid: 400, comm: 'make', argv: ['make'] }));
  let paused = true;
  os.onSignal = () => {
    paused = false; // the lift lands right after the FIRST signal
  };
  const r = await killToolTrees(CLI, 90, os.deps(), { stillPaused: () => paused });
  assert.equal(os.signals.length, 1, `exactly one signal before the lift was seen, got ${JSON.stringify(os.signals.map((x) => x.pid))}`);
  assert.equal(r.aborted, 'lifted');
  const os2 = world();
  const r2 = await killToolTrees(CLI, 90, os2.deps(), { stillPaused: () => false });
  assert.deepEqual(os2.signals, [], 'lifted before the first round: nothing signalled');
  assert.equal(r2.aborted, 'lifted');
  assert.equal(r2.rounds, 0, 'and the round itself never started (the round-level check is its own layer)');
});

test('F8: the SIGKILL escalation re-checks the pause too', async () => {
  const os = world();
  os.ignoresTerm.add(201);
  let calls = 0;
  const r = await killToolTrees(CLI, 90, os.deps(), { termGraceMs: 100, stillPaused: () => ++calls <= 3 });
  assert.ok(!os.signals.some((x) => x.sig === 'SIGKILL'), `no SIGKILL after the lift: ${JSON.stringify(os.signals.map((x) => `${x.pid}:${x.sig}`))}`);
  assert.equal(r.aborted, 'lifted');
});

test('F2: startedBeforeMs spares what started after a HUMAN turn began (its tools are allowed to run); older processes are still killed', async () => {
  const os = world();
  os.add(shellC(400, 100, 'pre-pause tool')); // start 2400
  os.add(shellC(500, 100, 'human turn tool')); // start 2500
  const r = await killToolTrees(CLI, 90, os.deps(), { startedBeforeMs: 2450 });
  assert.ok(!os.procs.has(400) && !os.procs.has(200), 'older trees killed');
  assert.ok(os.procs.has(500), 'the tool the human turn started is left running');
  assert.ok(r.spared.some((x) => x.pid === 500 && /HUMAN turn/.test(x.reason)));
});

test('F1b: startWallMs = now − (uptime − ticks/CLK_TCK) — exact, no btime flooring', () => {
  assert.equal(startWallMs(1_000_000, 100, 9000, 100), 990_000);
  assert.equal(Math.round(startWallMs(1_000_000, 100.37, 9000, 100)), 989_630, 'sub-second uptime carries through (a floored btime loses up to 1 s here)');
});

test('M5: startedBeforeMs as a GETTER is re-read at EVERY signal — a human turn that begins mid-kill protects the tools it starts (not only at plan time)', async () => {
  const os = world();
  os.add(shellC(400, 100, 'pre-pause tool')); // start 2400
  os.add(shellC(500, 100, 'human turn tool')); // start 2500 — the human turn starts AFTER the first signal
  await killToolTrees(CLI, 90, os.deps(), { startedBeforeMs: () => (os.signals.length === 0 ? undefined : 2450) });
  assert.ok(os.signals.length > 0 && !os.procs.has(400), 'the older tree is killed');
  assert.ok(os.procs.has(500), 'the tool of the human turn that began mid-kill is NOT signalled');
});

test('F5: spareRoots spares the WHOLE tree that contains the run-pause call and kills the member\'s other trees', async () => {
  const os = world();
  os.add(shellC(400, 100, 'other tree'));
  const r = await killToolTrees(CLI, 90, os.deps(), { spareRoots: [200] });
  assert.ok(os.procs.has(200) && os.procs.has(201), 'the pauser\'s own tool tree survives');
  assert.ok(!os.procs.has(400), 'its other tool tree is killed');
  assert.ok(r.spared.filter((x) => x.pid === 200 || x.pid === 201).every((x) => /pauser exemption/.test(x.reason)));
});

test('fake OS: SIGTERM ignored → escalates to SIGKILL (after a fresh identity re-read)', async () => {
  const os = world();
  os.ignoresTerm.add(201);
  const r = await killToolTrees(CLI, 90, os.deps(), { termGraceMs: 200 });
  const sigs = os.signals.filter((s) => s.pid === 201).map((s) => s.sig);
  assert.deepEqual(sigs, ['SIGTERM', 'SIGKILL']);
  assert.equal(r.killed.find((k) => k.pid === 201)?.signal, 'SIGKILL');
  assert.deepEqual(r.survivors, []);
});

test('RECYCLED PID between plan and signal: the innocent that inherited the pid is NOT signalled (identity re-read)', async () => {
  const os = world();
  os.afterTable = () => {
    os.procs.set(201, mk(201, 1, { startTicks: 99999, comm: 'innocent-db', argv: ['postgres'], sid: 201 })); // new process, same pid
  };
  const r = await killToolTrees(CLI, 90, os.deps());
  const hits = os.signals.filter((s) => s.pid === 201);
  assert.equal(hits.length, 0, `the recycled pid must never be signalled, got ${JSON.stringify(hits)}`);
  assert.equal(os.procs.get(201)?.comm, 'innocent-db', 'innocent still alive');
  assert.ok(r.refused.some((x) => x.pid === 201 && /reused/.test(x.reason)), 'refusal is reported with its reason');
  // the real tool root (200) was still killed
  assert.ok(!os.procs.has(200));
});

test('RECYCLED PID between SIGTERM and SIGKILL: no SIGKILL to the innocent', async () => {
  const os = world();
  os.ignoresTerm.add(201);
  let swapped = false;
  os.onSleep = () => {
    if (!swapped) {
      swapped = true;
      os.procs.set(201, mk(201, 1, { startTicks: 424242, comm: 'innocent', argv: ['innocent'], sid: 201 }));
    }
  };
  await killToolTrees(CLI, 90, os.deps(), { termGraceMs: 200 });
  assert.deepEqual(os.signals.filter((s) => s.pid === 201).map((s) => s.sig), ['SIGTERM'], 'the SIGKILL pass re-read identity and refused');
  assert.equal(os.procs.get(201)?.comm, 'innocent');
});

test('UNREADABLE identity fails closed: not signalled, reported as a survivor with the reason', async () => {
  const os = world();
  os.unreadable.add(201);
  const r = await killToolTrees(CLI, 90, os.deps(), { termGraceMs: 100 });
  assert.equal(os.signals.filter((s) => s.pid === 201).length, 0);
  assert.ok(os.procs.has(201));
  assert.ok(r.refused.some((x) => x.pid === 201 && x.reason === 'unreadable'));
  assert.ok(r.survivors.some((x) => x.pid === 201 && x.reason === 'unreadable'));
});

test('a tool spawned WHILE killing is caught by the next round', async () => {
  const os = world();
  let spawned = false;
  os.onSignal = () => {
    if (!spawned) {
      spawned = true;
      os.add(shellC(400, 100, 'make test'));
      os.add(mk(401, 400, { sid: 400, comm: 'make', argv: ['make', 'test'] }));
    }
  };
  const r = await killToolTrees(CLI, 90, os.deps(), { termGraceMs: 100 });
  assert.ok(!os.procs.has(400) && !os.procs.has(401), 'late tool tree killed');
  assert.ok(r.rounds >= 2);
  assert.deepEqual(r.survivors, []);
});

test('a tool that keeps respawning is bounded by maxRounds and reported as a SURVIVOR (no infinite loop)', async () => {
  const os = world();
  let n = 500;
  os.onSignal = () => {
    n += 2;
    os.add(shellC(n, 100, 'respawn'));
  };
  const r = await killToolTrees(CLI, 90, os.deps(), { termGraceMs: 100, maxRounds: 2 });
  assert.equal(r.rounds, 2);
  assert.ok(r.survivors.length > 0);
  assert.ok(r.survivors.every((s) => s.reason === 'still-alive-after-kill'));
});

test('CLI gone or recycled: plans nothing, signals nothing', async () => {
  const os = world();
  os.procs.delete(100);
  const r = await killToolTrees(CLI, 90, os.deps());
  assert.deepEqual(os.signals, []);
  assert.deepEqual(r.killed, []);
});

test('unsupported platform (no /proc start-time): fail closed, nothing killed, error says why', async () => {
  const os = world();
  os.supported = false;
  const r = await killToolTrees(CLI, 90, os.deps());
  assert.deepEqual(os.signals, []);
  assert.match(r.error ?? '', /unavailable on this platform/);
});

// ── (2) real processes ──────────────────────────────────────────────────────

const real = realKillDeps();

function alive(pid: number): boolean {
  const f = real.read(pid);
  return f !== 'gone' && f !== 'unreadable' && f.state !== 'Z';
}

/** Processes whose LAST argv element is `tag` (node stand-ins) or that are `sleep <n>` — never a substring
 *  match on the stand-in's script text, which mentions every tag. */
function findByArgv(needle: string): number[] {
  const sleepN = /^sleep (\d+)$/.exec(needle)?.[1];
  return real
    .readTable()
    .filter((p) => (sleepN ? p.comm === 'sleep' && p.argv?.[1] === sleepN : p.argv?.at(-1) === needle))
    .map((p) => p.pid);
}

async function waitFor(fn: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor timed out');
}

const CLI_STANDIN = `
const { spawn } = require('child_process');
// What the real CLI does: every tool shell gets its own session and CLAUDE_PID=<cli pid> in its env.
const o = { detached: true, stdio: 'ignore', env: { ...process.env, CLAUDE_PID: String(process.pid) } };
// tool A: a foreground sleeper with a backgrounded grandchild (kept in the shell's tree)
spawn('/bin/bash', ['-c', 'sleep 7701 & sleep 7702; wait'], o).unref();
// tool B: backgrounds a job and EXITS — the job is reparented away but keeps the shell's sid + CLAUDE_PID
spawn('/bin/bash', ['-c', 'sleep 7703 >/dev/null 2>&1 & exit 0'], o).unref();
// tool C: a scrubbed-env orphan (env -i): NO provenance survives once its shell is gone → must be LEFT ALONE
spawn('/bin/bash', ['-c', 'env -i /bin/sleep 7707 >/dev/null 2>&1 & exit 0'], o).unref();
// sidecar (MCP-like): not a shell → must be SPARED
spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', 'fake-mcp-sidecar-7704'], { stdio: 'ignore' }).unref();
setInterval(() => {}, 1000);
console.log('ready');
`;

test('REAL processes: tool shells + a shell-outliving background job are killed; CLI, sidecar and bystander survive; report names the commands', async () => {
  if (process.platform !== 'linux') return; // /proc identity is Linux-only (the kill path fails closed elsewhere — covered above)
  const spawned: ChildProcess[] = [];
  let bystander: ChildProcess | null = null;
  try {
    const cli = spawn(process.execPath, ['-e', CLI_STANDIN, 'fake-cli-standin'], { stdio: ['ignore', 'pipe', 'ignore'] });
    spawned.push(cli);
    await new Promise<void>((res) => cli.stdout!.once('data', () => res()));
    bystander = spawn('/bin/sleep', ['7705'], { stdio: 'ignore' });
    await waitFor(() => ['7701', '7702', '7703', '7707'].every((n) => findByArgv(`sleep ${n}`).length === 1));
    const cliId = real.read(cli.pid!);
    assert.ok(cliId !== 'gone' && cliId !== 'unreadable');
    const before = { a: findByArgv('sleep 7701')[0], b: findByArgv('sleep 7702')[0], orphan: findByArgv('sleep 7703')[0] };
    // positive control: the orphan really IS reparented away from the CLI's tree (else the arm proves nothing)
    const orphanNow = real.read(before.orphan);
    assert.ok(orphanNow !== 'gone' && orphanNow !== 'unreadable');
    assert.ok((orphanNow as ProcIdent).ppid !== cli.pid && (orphanNow as ProcIdent).ppid !== 0, 'orphan is not a direct child of the CLI');
    const sidecar = findByArgv('fake-mcp-sidecar-7704')[0];
    assert.ok(sidecar);

    const report = await killToolTrees({ pid: cli.pid!, startTicks: (cliId as ProcIdent).startTicks }, process.pid, real, { termGraceMs: 1500 });

    assert.ok(!alive(before.a) && !alive(before.b) && !alive(before.orphan), `tool procs dead: ${JSON.stringify(before)}`);
    assert.ok(alive(cli.pid!), 'CLI stand-in alive');
    assert.ok(alive(sidecar), 'MCP-like sidecar alive');
    assert.ok(alive(bystander.pid!), 'bystander alive');
    assert.ok(alive(findByArgv('sleep 7707')[0]), 'an orphan with NO provenance (scrubbed env, dead shell) is left alone — fail closed');
    assert.deepEqual(report.survivors, []);
    const cmds = report.killed.map((k) => k.cmd).join('\n');
    assert.match(cmds, /sleep 7701/);
    assert.match(cmds, /sleep 7703/);
    assert.ok(report.spared.some((s) => s.cmd.includes('fake-mcp-sidecar-7704')), 'sidecar listed as spared');
    assert.ok(report.killed.some((k) => k.via === 'env'), 'the shell-outliving orphan was reached through CLAUDE_PID provenance');
  } finally {
    for (const n of ['sleep 7701', 'sleep 7702', 'sleep 7703', 'sleep 7707', 'fake-mcp-sidecar-7704', 'fake-cli-standin']) {
      for (const pid of findByArgv(n)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
    for (const c of spawned) c.kill('SIGKILL');
    bystander?.kill('SIGKILL');
  }
});

test('REAL processes: a non-shell child of the "CLI" (sidecar-like) is spared, never killed', async () => {
  if (process.platform !== 'linux') return;
  const victim = spawn('/bin/sleep', ['7706'], { stdio: 'ignore' });
  try {
    await waitFor(() => findByArgv('sleep 7706').length === 1);
    const v = real.read(victim.pid!) as ProcIdent;
    // a stand-in "CLI" that is NOT the victim's parent: planToolTrees finds no members
    const fakeCli = { pid: process.pid, startTicks: (real.read(process.pid) as ProcIdent).startTicks };
    const r = await killToolTrees(fakeCli, null, { ...real, selfPid: -1 }, { termGraceMs: 100 });
    assert.ok(!r.killed.some((k) => k.pid === victim.pid), 'victim not killed');
    assert.ok(alive(victim.pid!));
    void v;
  } finally {
    victim.kill('SIGKILL');
  }
});

test('read() really parses /proc for this process (positive control for the real arms)', () => {
  if (process.platform !== 'linux') return;
  const me = real.read(process.pid) as ProcIdent;
  assert.equal(me.pid, process.pid);
  assert.ok(me.startTicks > 0);
  assert.ok(fs.existsSync(`/proc/${process.pid}/stat`));
  assert.equal(real.read(2 ** 22 + 12345), 'gone');
});

test('round-2 F1b REAL: realKillDeps.startMs places a real process within one tick of the wall clock it was spawned at (the old floored-btime read ran ~0.4 s early)', async () => {
  if (process.platform !== 'linux') return;
  const t0 = Date.now();
  const p = spawn('/bin/sleep', ['7792'], { stdio: 'ignore' });
  try {
    await waitFor(() => findByArgv('sleep 7792').length === 1);
    const t1 = Date.now();
    const id = real.read(p.pid!) as ProcIdent;
    const at = real.startMs(id.startTicks);
    assert.ok(at >= t0 - 40 && at <= t1 + 40, `startMs ${at - t0} ms from spawn (window 0..${t1 - t0} ms, ±40 ms for the 10 ms tick)`);
  } finally {
    p.kill('SIGKILL');
  }
});

const GATED_STANDIN = `
const { spawn } = require('child_process');
const o = { detached: true, stdio: 'ignore', env: { ...process.env, CLAUDE_PID: String(process.pid) } };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { for (const c of d) {
  if (c === 'a') spawn('/bin/bash', ['-c', 'sleep 7793; true'], o).unref();
  if (c === 'b') spawn('/bin/bash', ['-c', 'sleep 7794; true'], o).unref();
} });
setInterval(() => {}, 1000);
console.log('ready');
`;

test('round-2 F1b REAL: a tool that starts 100 ms AFTER a human turn began is SPARED by the cutoff; the older tool is killed (a biased start-time reads the newer one as older and kills it)', async () => {
  if (process.platform !== 'linux') return;
  const spawned: ChildProcess[] = [];
  try {
    const cli = spawn(process.execPath, ['-e', GATED_STANDIN, 'fake-cli-gated'], { stdio: ['pipe', 'pipe', 'ignore'] });
    spawned.push(cli);
    await new Promise<void>((res) => cli.stdout!.once('data', () => res()));
    cli.stdin!.write('a');
    await waitFor(() => findByArgv('sleep 7793').length === 1);
    await new Promise((r) => setTimeout(r, 500));
    const humanStart = Date.now(); // the human turn begins here
    await new Promise((r) => setTimeout(r, 100));
    cli.stdin!.write('b');
    await waitFor(() => findByArgv('sleep 7794').length === 1);
    const cliId = real.read(cli.pid!) as ProcIdent;
    const rep = await killToolTrees({ pid: cli.pid!, startTicks: cliId.startTicks }, null, { ...real, selfPid: -1 }, { termGraceMs: 300, startedBeforeMs: humanStart });
    assert.ok(findByArgv('sleep 7793').length === 0, `the pre-human tool is killed: ${JSON.stringify(rep.killed.map((k) => k.cmd))}`);
    assert.ok(findByArgv('sleep 7794').length === 1, 'the tool that started AFTER the human turn is left running');
    assert.ok(rep.spared.some((x) => /HUMAN turn/.test(x.reason) && /7794/.test(x.cmd)), 'listed as spared with the D9 reason');
  } finally {
    for (const n of ['sleep 7793', 'sleep 7794', 'fake-cli-gated']) for (const pid of findByArgv(n)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    for (const c of spawned) c.kill('SIGKILL');
  }
});
