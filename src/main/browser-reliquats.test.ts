// #331 — the browser-Reliquat pass (ledger #329 track H10). Two layers, like pause-reliquats.test.ts:
//  (1) a FAKE OS drives `browserPass` through the races a destructive act must survive (a pid recycled between the table and the signal, argv changed, a launcher that came back,
//      a client that appeared, SIGTERM ignored, a lift mid-kill) and through every "never touch";
//  (2) REAL processes: look-alike browsers (a python3 symlinked as `chrome`, real listening sockets, a real client connection) orphaned for real, real /proc and /proc/net/tcp reads.
//      The proof with real headless Chromium is the rig (scripts/browser-reliquats/rig.mjs).
// Each arm names the clause it protects (in-place mutants: scripts/pause-trap/mutants-browser-reliquats.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { BrowserTracker, browserPass, browserStatusText, realClientState, type BrowserPassDeps } from './browser-reliquats.ts';
import { BROWSER_IDLE_WINDOW_MS } from '../shared/browser-reliquats.ts';
import { realKillDeps } from './pause-kill.ts';
import { hostPageSize } from './host-page-size.ts';
import { parseProcStatLine, type ProcSample } from '../shared/resources.ts';
import type { ClientState } from '../shared/browser-reliquats.ts';

const ROOT = '/home/u/.orchestra/agent-tmp';
const W = BROWSER_IDLE_WINDOW_MS;

// ── (1) fake OS ─────────────────────────────────────────────────────────────

interface FProc { pid: number; ppid: number; comm: string; startTicks: number; argv: string[] }

class World {
  procs = new Map<number, FProc>();
  clock = 1_000_000;
  signals: Array<{ pid: number; sig: string; occupant: string }> = [];
  warns: string[] = [];
  ignoresTerm = new Set<number>();
  clients = new Map<number, { ports: number[]; client: ClientState } | 'unknown'>();
  known = new Set<string>(['ws-1', 'ws-2']);
  unreadableCmd = new Set<number>();
  onSleep: (() => void) | null = null;
  /** Runs ONCE, at the first kill-time re-read — i.e. after the pass classified its table, before it signals. */
  beforeKill: (() => void) | null = null;
  idleWindowMs = W;

  /** A headless browser main process, orphaned (ppid 1) unless `ppid` says otherwise. */
  browser(pid: number, o: { mode?: 'pipe' | 'port' | 'headless'; profile?: string; ppid?: number; comm?: string; extra?: string[]; start?: number } = {}): FProc {
    const mode = o.mode ?? 'port';
    const argv = ['/opt/chrome-linux/chrome', '--headless=new', ...(mode === 'pipe' ? ['--remote-debugging-pipe'] : mode === 'port' ? ['--remote-debugging-port=9222'] : []), ...(o.profile === null ? [] : [`--user-data-dir=${o.profile ?? `${ROOT}/ws-1/tmp/p${pid}`}`]), ...(o.extra ?? [])];
    const p: FProc = { pid, ppid: o.ppid ?? 1, comm: o.comm ?? 'chrome', startTicks: o.start ?? 1000 + pid, argv };
    this.procs.set(pid, p);
    return p;
  }
  child(pid: number, ppid: number, type = 'renderer', start?: number): FProc {
    const p: FProc = { pid, ppid, comm: 'chrome', startTicks: start ?? 1000 + pid, argv: ['/opt/chrome-linux/chrome', `--type=${type}`, '--headless'] };
    this.procs.set(pid, p);
    return p;
  }
  add(pid: number, ppid: number, comm: string, argv: string[] = [comm]): FProc {
    const p: FProc = { pid, ppid, comm, startTicks: 1000 + pid, argv };
    this.procs.set(pid, p);
    return p;
  }
  table(): ProcSample[] {
    return [...this.procs.values()].map((p) => ({ pid: p.pid, ppid: p.ppid, comm: p.comm, cpuTicks: 0, memBytes: 0, cpuPct: null, startTicks: p.startTicks }));
  }
  deps(): BrowserPassDeps {
    return {
      now: () => this.clock,
      agentTmpRoot: () => ROOT,
      workspaceKnown: (id) => this.known.has(id),
      readProcStat: (pid) => { const h = this.beforeKill; this.beforeKill = null; h?.(); const p = this.procs.get(pid); return p ? { pid: p.pid, ppid: p.ppid, comm: p.comm, cpuTicks: 0, memBytes: 0, cpuPct: null, startTicks: p.startTicks } : null; },
      readCmdline: (pid) => (this.unreadableCmd.has(pid) ? null : (this.procs.get(pid)?.argv ?? null)),
      clientState: (pid) => this.clients.get(pid) ?? { ports: [9222], client: 'no' },
      startMs: (t) => t * 10,
      signal: (pid, sig) => {
        const p = this.procs.get(pid);
        this.signals.push({ pid, sig, occupant: p ? `${p.comm}:${p.startTicks}` : 'none' });
        if (!p) return false;
        if (sig === 'SIGTERM' && this.ignoresTerm.has(pid)) return true;
        this.procs.delete(pid);
        return true;
      },
      sleep: async (ms) => { this.clock += ms; this.onSleep?.(); },
      warn: (m) => { this.warns.push(m); },
      info: () => {},
      idleWindowMs: this.idleWindowMs,
      graceMs: 100,
    };
  }
  pass(tracker: BrowserTracker, opts: Parameters<typeof browserPass>[3] = {}) {
    return browserPass(this.deps(), tracker, this.table(), opts);
  }
}

test('PIPE mode: an orphan headless browser attributable to a known workspace is stopped AT ONCE — the whole group, children first, the main process last; its profile is not part of any signal', async () => {
  const w = new World();
  w.browser(500, { mode: 'pipe' });
  w.child(501, 500, 'zygote');
  w.child(502, 501, 'renderer');
  w.child(503, 500, 'gpu-process');
  const r = await w.pass(new BrowserTracker());
  assert.deepEqual(r.stopped.map((s) => [s.wsId, s.pid, s.mode, s.groupSize]), [['ws-1', 500, 'pipe', 4]]);
  const order = w.signals.map((s) => s.pid);
  assert.equal(order.at(-1), 500, 'the main process last');
  assert.ok(order.indexOf(502) < order.indexOf(501) && order.indexOf(501) < order.indexOf(500) && order.indexOf(503) < order.indexOf(500), `every child before its parent: ${order}`);
  assert.equal(order.length, 4);
  assert.equal(w.procs.size, 0);
  assert.deepEqual(r.report!.killed.map((k) => [k.pid, k.scope, k.cwd, k.startedAt]), [[500, 'browser:pipe', `${ROOT}/ws-1/tmp/p500`, (1000 + 500) * 10]]);
  assert.match(r.report!.killed[0].evidence, /pipe mode: the pipe died with its launcher/);
  assert.match(r.report!.killed[0].evidence, /identity re-read at signal time/);
});

test('PORT mode: kept until N minutes of ORPHAN-WITH-NO-CLIENT have passed (the clock starts when the monitor first sees the orphan), then stopped', async () => {
  const w = new World();
  const t = new BrowserTracker();
  w.browser(500, { mode: 'port' });
  assert.deepEqual((await w.pass(t)).stopped, [], 'first sight');
  w.clock += W - 1;
  assert.deepEqual((await w.pass(t)).stopped, [], 'one ms short of N');
  assert.deepEqual(w.signals, []);
  w.clock += 1;
  const r = await w.pass(t);
  assert.deepEqual(r.stopped.map((s) => s.pid), [500]);
  assert.match(r.report!.killed[0].evidence, /no client connected for 10 min \(window 10 min\)/);
});

test('PORT mode: a CLIENT seen restarts the idle clock; a client connected NOW protects it for as long as it stays (spared and named, never stopped)', async () => {
  const w = new World();
  const t = new BrowserTracker();
  w.browser(500, { mode: 'port' });
  await w.pass(t); // t0: first sight
  w.clock += 8 * 60_000;
  w.clients.set(500, { ports: [9222], client: 'yes' });
  const mid = await w.pass(t); // a client at +8 min
  assert.deepEqual(mid.stopped, []);
  assert.match(mid.spared[0].reason, /a client is connected to its debugging port/);
  w.clients.set(500, { ports: [9222], client: 'no' });
  w.clock += 5 * 60_000; // +13 min since first sight, but only 5 since the client
  assert.deepEqual((await w.pass(t)).stopped, [], 'the window restarted at the client');
  w.clock += 5 * 60_000; // 10 min since the client
  assert.deepEqual((await w.pass(t)).stopped.map((s) => s.pid), [500]);
  // and one that keeps its client for an hour is never touched
  const w2 = new World();
  const t2 = new BrowserTracker();
  w2.browser(600, { mode: 'port' });
  w2.clients.set(600, { ports: [9222], client: 'yes' });
  for (let i = 0; i < 7; i++) { await w2.pass(t2); w2.clock += 10 * 60_000; }
  assert.deepEqual(w2.signals, []);
});

test('an UNREADABLE client state keeps the browser (UNKNOWN is not NONE) however old it is — and says so', async () => {
  const w = new World();
  const t = new BrowserTracker();
  w.browser(500, { mode: 'port' });
  w.clients.set(500, 'unknown');
  await w.pass(t);
  w.clock += 5 * W;
  const r = await w.pass(t);
  assert.deepEqual(r.stopped, []);
  assert.deepEqual(w.signals, []);
  assert.match(r.spared[0].reason, /could not be read/);
});

test('NEVER touched: a browser whose launcher is alive (any live parent), the human\'s browser (no headless / remote-debugging flag, default profile), a profile OUTSIDE agent-tmp, an unknown workspace id, a child process alone, a non-browser', async () => {
  const w = new World();
  const t = new BrowserTracker();
  w.add(40, 1, 'node', ['node', 'launcher.js']);
  w.browser(500, { mode: 'pipe', ppid: 40 }); // launcher alive
  w.add(41, 1, 'gnome-shell');
  w.procs.set(510, { pid: 510, ppid: 41, comm: 'chromium-browse', startTicks: 1510, argv: ['/usr/bin/chromium-browser', '--user-data-dir=/home/u/.config/chromium'] }); // the human's window
  w.browser(520, { mode: 'pipe', profile: '/home/u/.config/chromium-rig' }); // outside agent-tmp
  w.browser(521, { mode: 'pipe', profile: null }); // no profile at all
  w.browser(522, { mode: 'pipe', profile: `${ROOT}/ws-unknown/tmp/p` }); // a workspace this store does not know
  w.child(530, 1, 'renderer'); // a stray child process: never a browser main
  w.add(540, 1, 'python3', ['python3', '--headless', '--remote-debugging-pipe', `--user-data-dir=${ROOT}/ws-1/x`]);
  w.clock += 10 * W;
  const r = await w.pass(t);
  assert.deepEqual(r.stopped, []);
  assert.deepEqual(w.signals, [], 'not one signal');
});

test('the USER MANAGER (systemd --user) that adopts orphans is not a live launcher; any other parent is', async () => {
  const w = new World();
  w.add(2000, 1, 'systemd', ['systemd', '--user']);
  w.browser(500, { mode: 'pipe', ppid: 2000 });
  w.add(2001, 1, 'bash', ['bash']);
  w.browser(501, { mode: 'pipe', ppid: 2001 });
  const r = await w.pass(new BrowserTracker());
  assert.deepEqual(r.stopped.map((s) => s.pid), [500]);
});

test('IDENTITY re-read at signal time: a pid RECYCLED between the table and the signal (same pid, new start-time) is never signalled — nor is a browser whose argv changed, one that got a live launcher, or a port browser that gained a client in between', async () => {
  const mk = async (mutate: (w: World) => void, mode: 'pipe' | 'port' = 'pipe') => {
    const w = new World();
    w.browser(500, { mode });
    w.beforeKill = () => mutate(w); // the pass classifies the world as it is, then the world moves before the first signal
    const r = await browserPass(w.deps(), new BrowserTracker(), w.table(), { ignoreWindow: true });
    return { w, r };
  };
  const recycled = await mk((w) => { w.procs.set(500, { pid: 500, ppid: 1, comm: 'chrome', startTicks: 7777, argv: ['/opt/chrome-linux/chrome', '--headless', '--remote-debugging-pipe', `--user-data-dir=${ROOT}/ws-1/tmp/p500`] }); });
  assert.deepEqual([recycled.w.signals, recycled.r.stopped], [[], []], 'the new occupant of pid 500 is untouched');
  assert.ok(recycled.w.warns.some((m) => /identity changed or gone/.test(m)));
  const argv = await mk((w) => { w.procs.get(500)!.argv = ['/opt/chrome-linux/chrome', '--headless', '--remote-debugging-pipe', `--user-data-dir=${ROOT}/ws-1/tmp/OTHER`]; });
  assert.deepEqual(argv.w.signals, []);
  assert.ok(argv.w.warns.some((m) => /argv changed/.test(m)));
  const relaunched = await mk((w) => { w.add(40, 1, 'node'); w.procs.get(500)!.ppid = 40; });
  assert.deepEqual(relaunched.w.signals, []);
  assert.ok(relaunched.w.warns.some((m) => /live launcher now/.test(m)));
  const client = await mk((w) => { w.clients.set(500, { ports: [9222], client: 'yes' }); }, 'port');
  assert.deepEqual(client.w.signals, []);
  assert.ok(client.w.warns.some((m) => /client appeared/.test(m)));
  const gone = await mk((w) => { w.procs.delete(500); });
  assert.deepEqual(gone.w.signals, []);
});

test('only members PROVABLY still the browser\'s children are signalled: a child whose start-time changed, or whose parent is no longer in the verified group, is left alone', async () => {
  const w = new World();
  w.browser(500, { mode: 'pipe' });
  w.child(501, 500);
  w.child(502, 500);
  w.child(503, 502);
  const table = w.table();
  w.procs.set(501, { ...w.procs.get(501)!, startTicks: 9999 }); // recycled pid: another process now
  w.procs.get(503)!.ppid = 1; // reparented away from the group
  await browserPass(w.deps(), new BrowserTracker(), table, {});
  assert.deepEqual(w.signals.filter((s) => s.sig === 'SIGTERM').map((s) => s.pid).sort(), [500, 502]);
  assert.ok(w.procs.has(501) && w.procs.has(503), 'the recycled pid and the reparented process survive');
});

test('SIGTERM ignored ⇒ SIGKILL for the same-identity survivor; a pid recycled DURING the grace is left alone; the outcome says survived / exited', async () => {
  const w = new World();
  w.browser(500, { mode: 'pipe' });
  w.child(501, 500);
  w.ignoresTerm.add(500);
  w.ignoresTerm.add(501);
  w.onSleep = () => { w.procs.set(501, { pid: 501, ppid: 1, comm: 'sleep', startTicks: 31337, argv: ['sleep', '9'] }); w.ignoresTerm.delete(501); }; // pid 501 is recycled during the grace
  const r = await w.pass(new BrowserTracker());
  const kills = w.signals.filter((s) => s.sig === 'SIGKILL');
  assert.deepEqual(kills.map((s) => [s.pid, s.occupant]), [[500, 'chrome:1500']], 'SIGKILL goes to the browser only; the recycled 501 gets none');
  assert.ok(w.procs.has(501));
  assert.equal(r.report!.killed[0].signal, 'SIGKILL');
  assert.equal(r.report!.killed[0].outcome, 'exited');
  // a browser that survives even SIGKILL is reported
  const w2 = new World();
  w2.browser(600, { mode: 'pipe' });
  const d2 = { ...w2.deps(), signal: (pid: number, sig: 'SIGTERM' | 'SIGKILL') => { w2.signals.push({ pid, sig, occupant: 'x' }); return true; } };
  const r2 = await browserPass(d2, new BrowserTracker(), w2.table());
  assert.equal(r2.report!.killed[0].outcome, 'survived');
});

test('a Pause dure pass is for ONE member: only its browsers, no idle window, a live client still protects; the other member\'s browsers and tracks are untouched', async () => {
  const w = new World();
  const t = new BrowserTracker();
  w.browser(500, { mode: 'port', profile: `${ROOT}/ws-1/tmp/a` });
  w.browser(600, { mode: 'port', profile: `${ROOT}/ws-2/tmp/a` });
  w.browser(700, { mode: 'port', profile: `${ROOT}/ws-1/tmp/b` });
  w.clients.set(700, { ports: [9222], client: 'yes' });
  await w.pass(t); // the monitor saw all three once
  const keysBefore = [...t.tracks.keys()].sort();
  const r = await w.pass(t, { onlyWs: 'ws-1', ignoreWindow: true });
  assert.deepEqual(r.stopped.map((s) => s.pid), [500], 'no waiting for N minutes under a Pause dure');
  assert.ok(w.procs.has(600) && w.procs.has(700));
  assert.deepEqual(r.spared.map((s) => s.pid), [700], 'the one with a live client is spared AND listed');
  assert.deepEqual([...t.tracks.keys()].sort().filter((k) => k !== '500:1500'), keysBefore.filter((k) => k !== '500:1500'), 'ws-2\'s track survived the single-member pass');
});

test('a LIFT during the kill sends nothing more (`aborted: lifted`); nothing is signalled when it is already lifted', async () => {
  const w = new World();
  w.browser(500, { mode: 'pipe' });
  w.browser(501, { mode: 'pipe' });
  let calls = 0;
  const r = await w.pass(new BrowserTracker(), { stillWanted: () => ++calls <= 1 });
  assert.equal(r.aborted, 'lifted');
  assert.deepEqual(w.signals.map((s) => s.pid), [500], 'only the browser handled before the lift');
  const w2 = new World();
  w2.browser(500, { mode: 'pipe' });
  const r2 = await w2.pass(new BrowserTracker(), { stillWanted: () => false });
  assert.deepEqual(w2.signals, []);
  assert.equal(r2.aborted, 'lifted');
});

test('write-ahead: onProgress carries the stopped browsers BEFORE the grace wait ends', async () => {
  const w = new World();
  w.browser(500, { mode: 'pipe' });
  w.ignoresTerm.add(500);
  const seen: Array<{ n: number; clock: number }> = [];
  const clock0 = w.clock;
  await w.pass(new BrowserTracker(), { onProgress: (rep) => seen.push({ n: rep.killed.length, clock: w.clock - clock0 }) });
  assert.deepEqual(seen, [{ n: 1, clock: 0 }]);
});

test('the per-workspace COUNTER counts every stop (monitor pass and Pause dure alike) and reads back as the Resources view; a kept browser counts nothing', async () => {
  const w = new World();
  const t = new BrowserTracker();
  w.browser(500, { mode: 'pipe', profile: `${ROOT}/ws-1/tmp/a` });
  w.browser(501, { mode: 'pipe', profile: `${ROOT}/ws-1/tmp/b` });
  w.browser(600, { mode: 'pipe', profile: `${ROOT}/ws-2/tmp/a` });
  w.browser(700, { mode: 'port', profile: `${ROOT}/ws-2/tmp/c` });
  w.clients.set(700, { ports: [9222], client: 'yes' });
  await w.pass(t);
  const v = t.view();
  assert.equal(v.total, 3);
  assert.deepEqual(Object.fromEntries(Object.entries(v.byWorkspace).map(([k, c]) => [k, c.stopped])), { 'ws-1': 2, 'ws-2': 1 });
  assert.equal(v.byWorkspace['ws-1'].lastPrefix, `${ROOT}/ws-1/`);
  w.browser(800, { mode: 'pipe', profile: `${ROOT}/ws-1/tmp/z` });
  await w.pass(t, { onlyWs: 'ws-1', ignoreWindow: true }); // a Pause dure's stop counts too
  assert.equal(t.view().byWorkspace['ws-1'].stopped, 3);
});

test('a browser WITHOUT a start-time anywhere (the non-Linux `ps` table AND the fresh read) is never signalled: no identity, no signal — whatever the kill-time re-read can still compare', async () => {
  const w = new World();
  w.browser(500, { mode: 'pipe' });
  const blind = (p: ProcSample): ProcSample => ({ ...p, startTicks: undefined });
  const d = { ...w.deps(), readProcStat: (pid: number) => { const p = w.deps().readProcStat(pid); return p ? blind(p) : null; } };
  const r = await browserPass(d, new BrowserTracker(), w.table().map(blind));
  assert.deepEqual([r.stopped, w.signals], [[], []]);
});

test('the idle clock starts when the browser is first seen ORPHANED, not when it was first seen: a browser with a live launcher for hours that loses its launcher is NOT stopped at once', async () => {
  const w = new World();
  const t = new BrowserTracker();
  w.add(40, 1, 'node', ['node', 'launcher.js']);
  w.browser(500, { mode: 'port', ppid: 40 });
  await w.pass(t); // t0: launcher alive
  w.clock += 3 * W; // three windows with a live launcher and no client
  assert.deepEqual((await w.pass(t)).stopped, []);
  assert.equal(t.tracks.size, 0, 'a launcher-alive browser is not even tracked');
  w.procs.get(500)!.ppid = 1; // the launcher dies NOW
  assert.deepEqual((await w.pass(t)).stopped, [], 'the clock starts at the orphaning');
  w.clock += W - 1;
  assert.deepEqual((await w.pass(t)).stopped, []);
  w.clock += 1;
  assert.deepEqual((await w.pass(t)).stopped.map((s) => s.pid), [500]);
});

test('realClientState over a fake /proc: LISTEN ports by socket inode, a client = ESTABLISHED to one of them; tcp6 absent is fine, but an UNREADABLE tcp6 / fd directory is `unknown` (never "no client")', () => {
  const root = fs.mkdtempSync(path.join(SCRATCH, 'procroot-'));
  const row = (sl: number, local: string, rem: string, st: string, inode: number): string => `  ${sl}: ${local} ${rem} ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
  fs.mkdirSync(path.join(root, '4242', 'fd'), { recursive: true });
  fs.mkdirSync(path.join(root, 'net'), { recursive: true });
  fs.symlinkSync('socket:[111]', path.join(root, '4242', 'fd', '5'));
  fs.symlinkSync('/dev/null', path.join(root, '4242', 'fd', '6'));
  fs.writeFileSync(path.join(root, 'net', 'tcp'), [header, row(0, '0100007F:2382', '00000000:0000', '0A', 111), row(1, '0100007F:2382', '0100007F:B1F4', '01', 222)].join('\n') + '\n');
  assert.deepEqual(realClientState(4242, root), { ports: [0x2382], client: 'yes' }, 'tcp6 absent (IPv6 off) is an empty table, not an error');
  fs.writeFileSync(path.join(root, 'net', 'tcp'), [header, row(0, '0100007F:2382', '00000000:0000', '0A', 111)].join('\n') + '\n');
  assert.deepEqual(realClientState(4242, root), { ports: [0x2382], client: 'no' });
  fs.rmSync(path.join(root, '4242', 'fd', '5'));
  assert.deepEqual(realClientState(4242, root), { ports: [], client: 'no' }, 'no listening socket: nobody can connect');
  fs.symlinkSync('socket:[111]', path.join(root, '4242', 'fd', '5'));
  fs.writeFileSync(path.join(root, 'net', 'tcp6'), header + '\n');
  assert.equal((realClientState(4242, root) as { client: string }).client, 'no', 'an empty tcp6 is fine');
  if (process.getuid?.() !== 0) {
    fs.chmodSync(path.join(root, 'net', 'tcp6'), 0o000);
    assert.equal(realClientState(4242, root), 'unknown', 'tcp6 exists but cannot be read: UNKNOWN');
    fs.chmodSync(path.join(root, 'net', 'tcp6'), 0o644);
  }
  assert.equal(realClientState(9999, root), 'unknown', 'no fd directory (gone / not ours): UNKNOWN');
});

test('a browser with no start-time (the non-Linux `ps` table) or whose cmdline cannot be read is never signalled', async () => {
  const w = new World();
  w.browser(500, { mode: 'pipe' });
  w.browser(501, { mode: 'pipe' });
  w.unreadableCmd.add(501);
  const table = w.table().map((p) => (p.pid === 500 ? { ...p, startTicks: undefined } : p));
  const r = await browserPass(w.deps(), new BrowserTracker(), table);
  assert.deepEqual([r.stopped, w.signals], [[], []]);
});

test('the bus status names HOW MANY and the profile prefix, once per member (the caller groups); it says the profiles were left in place', () => {
  const text = browserStatusText([
    { wsId: 'ws-1', pid: 1, startTicks: 1, mode: 'pipe', prefix: `${ROOT}/ws-1/`, profile: `${ROOT}/ws-1/tmp/a`, groupSize: 3 },
    { wsId: 'ws-1', pid: 2, startTicks: 2, mode: 'port', prefix: `${ROOT}/ws-1/`, profile: `${ROOT}/ws-1/tmp/b`, groupSize: 3 },
  ]);
  assert.match(text, /stopped 2 orphaned headless browser\(s\)/);
  assert.match(text, /1 in pipe mode/);
  assert.ok(text.includes(`${ROOT}/ws-1/tmp/`));
  assert.match(text, /profiles were left in place/);
});

// ── (2) REAL processes ──────────────────────────────────────────────────────

const real = realKillDeps();
const SCRATCH = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'browser-reliq-test-'));
const REAL_ROOT = path.join(SCRATCH, 'agent-tmp');
const CHROME = path.join(SCRATCH, 'chrome');
fs.symlinkSync('/usr/bin/python3', CHROME); // comm `chrome`, argv[0] ending in /chrome: a look-alike main browser
const spawned: Array<{ pid: number; startTicks: number }> = [];
const idOf = (pid: number): { pid: number; startTicks: number } => {
  const f = real.read(pid);
  assert.ok(f !== 'gone' && f !== 'unreadable', `process ${pid} exists`);
  const r = { pid, startTicks: (f as { startTicks: number }).startTicks };
  spawned.push(r);
  return r;
};
const aliveId = (r: { pid: number; startTicks: number }): boolean => { const f = real.read(r.pid); return f !== 'gone' && f !== 'unreadable' && f.startTicks === r.startTicks && f.state !== 'Z'; };
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const q = (a: string): string => `'${a.replace(/'/g, `'\\''`)}'`;

/** A look-alike headless browser: `chrome -c <code> --headless … --user-data-dir=…`, optionally LISTENING on a real TCP port (written to `<profile>/port`), orphaned for real (`setsid … &` from a shell that exits). */
function launchFake(profile: string, flags: string[], opts: { listen?: boolean; ppidAlive?: boolean } = {}): { pid: number; startTicks: number; port: number | null } {
  fs.mkdirSync(profile, { recursive: true });
  const code = opts.listen
    ? `import socket,sys,time\ns=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(("127.0.0.1",0));s.listen(5)\nopen(sys.argv[-1].split("=",1)[1]+"/port","w").write(str(s.getsockname()[1]))\nconns=[]\nwhile True:\n  s.settimeout(0.2)\n  try: conns.append(s.accept()[0])\n  except Exception: pass`
    : 'import time\ntime.sleep(600)';
  const argv = [CHROME, '-c', code, ...flags, `--user-data-dir=${profile}`];
  if (opts.ppidAlive) {
    const c = spawnChild(argv);
    return { ...idOf(c), port: waitPort(profile) };
  }
  const out = execFileSync('sh', ['-c', `setsid ${argv.map(q).join(' ')} </dev/null >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' });
  const id = idOf(Number(out.trim()));
  return { ...id, port: opts.listen ? waitPort(profile) : null };
}
function spawnChild(argv: string[]): number {
  const c = spawn(argv[0], argv.slice(1), { stdio: 'ignore', detached: false });
  c.unref();
  return c.pid as number;
}
function waitPort(profile: string): number | null {
  const f = path.join(profile, 'port');
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (fs.existsSync(f) && fs.readFileSync(f, 'utf8')) return Number(fs.readFileSync(f, 'utf8')); const t = Date.now() + 25; while (Date.now() < t); }
  return null;
}
test.after(() => {
  let left = 0;
  for (const r of spawned) if (aliveId(r)) { try { process.kill(r.pid, 'SIGKILL'); } catch { /* gone */ } }
  const until = Date.now() + 1000;
  while (Date.now() < until && spawned.some(aliveId)) { const t = Date.now() + 20; while (Date.now() < t); }
  for (const r of spawned) if (aliveId(r)) left++;
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  console.log(`# browser-reliquats.test: ${spawned.length} real processes launched, ${left} left after teardown`);
});

function realTable(): ProcSample[] {
  const out: ProcSample[] = [];
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue;
    try { const p = parseProcStatLine(fs.readFileSync(`/proc/${n}/stat`, 'utf8'), hostPageSize()); if (p) out.push(p); } catch { /* exited */ }
  }
  return out;
}
const realDeps = (idleWindowMs: number): BrowserPassDeps => ({
  now: () => Date.now(),
  agentTmpRoot: () => REAL_ROOT,
  workspaceKnown: (id) => id === 'ws-real',
  readProcStat: (pid) => { try { return parseProcStatLine(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), hostPageSize()); } catch { return null; } },
  readCmdline: (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((s) => s.length > 0); } catch { return null; } },
  clientState: (pid) => realClientState(pid),
  startMs: real.startMs,
  signal: (pid, sig) => { try { process.kill(pid, sig); return true; } catch { return false; } },
  sleep: settle,
  warn: () => {},
  info: () => {},
  idleWindowMs,
  graceMs: 500,
});
const profileOf = (tag: string): string => path.join(REAL_ROOT, 'ws-real', 'tmp', `${tag}-${process.pid}`);

test('REAL processes: a pipe-mode orphan is stopped at once; a launcher-alive browser, one outside agent-tmp and the human-style window survive — the profile directory is left in place', async () => {
  const pipe = launchFake(profileOf('pipe'), ['--headless=new', '--remote-debugging-pipe']);
  const alive = launchFake(profileOf('alive'), ['--headless=new', '--remote-debugging-pipe'], { ppidAlive: true }); // child of THIS test: a live launcher
  const outside = launchFake(path.join(SCRATCH, 'elsewhere'), ['--headless=new', '--remote-debugging-pipe']);
  const human = launchFake(profileOf('human'), ['--user-data-dir-is-ignored-here']); // no headless / remote flag: the human's window
  await settle(300);
  for (const [n, p] of [['pipe', pipe], ['alive', alive], ['outside', outside], ['human', human]] as const) assert.equal(aliveId(p), true, `premise: ${n} is alive BEFORE the pass`);
  assert.notEqual((real.read(pipe.pid) as { ppid: number }).ppid, process.pid, 'premise: the pipe browser is a real orphan');
  const tracker = new BrowserTracker();
  const r = await browserPass(realDeps(60_000), tracker, realTable());
  assert.deepEqual(r.stopped.map((s) => s.pid), [pipe.pid]);
  assert.equal(aliveId(pipe), false, 'the orphan is dead');
  assert.equal(aliveId(alive), true, 'a live launcher: untouched');
  assert.equal(aliveId(outside), true, 'a profile outside agent-tmp: untouched');
  assert.equal(aliveId(human), true, 'a non-headless, non-remote window: untouched');
  assert.equal(fs.existsSync(profileOf('pipe')), true, 'the profile directory is left in place');
});

test('REAL sockets: a port-mode orphan with a REAL client connected to its REAL debugging port survives past the idle window; once the client leaves it is stopped after the window', async () => {
  const prof = profileOf('port');
  const b = launchFake(prof, ['--headless=new', '--remote-debugging-port=0'], { listen: true });
  assert.ok(b.port && b.port > 0, 'premise: the fake browser is listening');
  const client = net.connect(b.port as number, '127.0.0.1');
  await new Promise<void>((res, rej) => { client.once('connect', () => res()); client.once('error', rej); });
  await settle(300);
  const cs = realClientState(b.pid);
  assert.notEqual(cs, 'unknown');
  assert.deepEqual([(cs as { ports: number[] }).ports, (cs as { client: string }).client], [[b.port], 'yes'], 'premise: /proc/net/tcp shows the client');
  const tracker = new BrowserTracker();
  const deps = realDeps(1200);
  await browserPass(deps, tracker, realTable());
  await settle(1500); // past the window, client still there
  const kept = await browserPass(deps, tracker, realTable());
  assert.deepEqual(kept.stopped, [], 'a live client protects it');
  assert.equal(aliveId(b), true);
  assert.match(kept.spared[0].reason, /client is connected/);
  client.destroy();
  await settle(300);
  assert.deepEqual((realClientState(b.pid) as { client: string }).client, 'no', 'premise: the client is gone');
  const soon = await browserPass(deps, tracker, realTable()); // the window restarted at the last client sighting
  assert.deepEqual(soon.stopped, []);
  await settle(1400);
  const done = await browserPass(deps, tracker, realTable());
  assert.deepEqual(done.stopped.map((s) => s.pid), [b.pid]);
  assert.equal(aliveId(b), false);
  assert.equal(fs.existsSync(prof), true, 'the profile directory is left in place');
});
