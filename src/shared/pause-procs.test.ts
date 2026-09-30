// #252 D1b — pure decisions of the pause trap's process killer (LEAD ruling D4).
// Every refusal reason is pinned by its own arm; each is what a missing identity re-read,
// a missing protected-pid guard or a missing lineage check would get wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isToolShell,
  killOrder,
  parseProcIdent,
  planToolTrees,
  verifyAtSignal,
  type FreshRead,
  type ProcIdent,
  type ToolPlan,
} from './pause-procs.ts';

const CLI = { pid: 100, startTicks: 1000 };
const KEEPER = 90;
const SELF = 10;

function p(pid: number, ppid: number, o: Partial<ProcIdent> = {}): ProcIdent {
  return { pid, ppid, sid: pid, startTicks: 2000 + pid, comm: 'x', state: 'S', argv: ['x'], ...o };
}
const shellC = (pid: number, ppid: number, cmd: string, o: Partial<ProcIdent> = {}): ProcIdent =>
  p(pid, ppid, { comm: 'zsh', argv: ['/usr/bin/zsh', '-c', cmd], ...o });

/** keeper 90 → CLI 100 → { tool shell 200 → sleep 201 → child 202 ; MCP sidecar 300 ; tool shell 210 }  + orphan 250 (sid 210, ppid 1) + bystander 999 */
function table(): ProcIdent[] {
  return [
    p(1, 0, { sid: 1 }),
    p(KEEPER, 1, { comm: 'node', argv: ['node', '/x/keeper.js', 'ws'] }),
    p(100, KEEPER, { startTicks: 1000, comm: 'claude', argv: ['/bin/claude'] }),
    shellC(200, 100, 'sleep 600'),
    p(201, 200, { sid: 200, comm: 'sleep', argv: ['sleep', '600'] }),
    p(202, 201, { sid: 200, comm: 'sub', argv: ['sub'] }),
    p(300, 100, { sid: 90, comm: 'node', argv: ['node', 'lazy-mcp.mjs'] }),
    shellC(210, 100, 'nohup sleep 601 &'),
    p(250, 1, { sid: 210, comm: 'sleep', argv: ['sleep', '601'] }), // orphan of the dead-ish shell 210's session
    p(999, 1, { sid: 999, comm: 'sleep', argv: ['sleep', '999'] }),
  ];
}

function reader(t: ProcIdent[], over: Record<number, FreshRead> = {}): (pid: number) => FreshRead {
  const m = new Map(t.map((x) => [x.pid, x]));
  return (pid) => (pid in over ? over[pid] : (m.get(pid) ?? 'gone'));
}

test('isToolShell: shell + -c (incl. -lc) only; interactive shells and non-shells are not tools', () => {
  assert.equal(isToolShell(shellC(1, 2, 'x')), true);
  assert.equal(isToolShell(p(1, 2, { comm: 'bash', argv: ['bash', '-lc', 'x'] })), true);
  assert.equal(isToolShell(p(1, 2, { comm: 'zsh', argv: ['-zsh'] })), false, 'interactive shell');
  assert.equal(isToolShell(p(1, 2, { comm: 'node', argv: ['node', '-c', 'x'] })), false, 'node -c is not a shell');
  assert.equal(isToolShell(p(1, 2, { comm: 'zsh', argv: null })), false, 'unreadable argv → not provably a tool');
});

test('parseProcIdent reads sid/state/start-time from a real stat line (comm with spaces + parens)', () => {
  const stat = '4242 (tmux: server (x)) S 1 4242 4242 0 -1 4194560 10 0 0 0 5 6 0 0 20 0 1 0 987654 1000 100 18446744073709551615';
  const id = parseProcIdent(stat, 'a\0b\0');
  assert.deepEqual(
    { pid: id?.pid, ppid: id?.ppid, sid: id?.sid, st: id?.startTicks, state: id?.state, comm: id?.comm, argv: id?.argv },
    { pid: 4242, ppid: 1, sid: 4242, st: 987654, state: 'S', comm: 'tmux: server (x)', argv: ['a', 'b'] },
  );
  assert.equal(parseProcIdent('garbage', null), null);
});

test('planToolTrees: tool shells + their ppid-descendants + session-orphans are members; MCP sidecar SPARED; CLI/keeper/bystander never', () => {
  const plan = planToolTrees(table(), CLI);
  const pids = plan.members.map((m) => m.pid).sort((a, b) => a - b);
  assert.deepEqual(pids, [200, 201, 202, 210, 250]);
  assert.deepEqual(plan.spared.map((s) => s.pid), [300]);
  assert.match(plan.spared[0].reason, /sidecar/);
  for (const banned of [1, KEEPER, 100, 300, 999]) assert.ok(!pids.includes(banned), `${banned} must not be a member`);
  const orphan = plan.members.find((m) => m.pid === 250);
  assert.equal(orphan?.rootPid, 210);
  assert.equal(orphan?.isRoot, false);
  assert.ok(plan.members.find((m) => m.pid === 200)?.isRoot);
});

test('planToolTrees: a CLI that is gone or was recycled plans NOTHING (no tree to prove lineage against)', () => {
  assert.deepEqual(planToolTrees(table().filter((x) => x.pid !== 100), CLI).members, []);
  assert.deepEqual(planToolTrees(table(), { pid: 100, startTicks: 1 }).members, [], 'recycled CLI pid');
});

test('planToolTrees: zombies are dead — not planned', () => {
  const t = table().map((x) => (x.pid === 201 ? { ...x, state: 'Z' } : x));
  assert.ok(!planToolTrees(t, CLI).members.some((m) => m.pid === 201));
});

test('killOrder: deepest first, tool roots last', () => {
  const order = killOrder(planToolTrees(table(), CLI).members).map((m) => m.pid);
  assert.ok(order.indexOf(202) < order.indexOf(201) && order.indexOf(201) < order.indexOf(200));
  assert.ok(order.indexOf(250) < order.indexOf(210), 'session orphans (depth 99) before their root');
  assert.ok(order.at(-1) === 200 || order.at(-1) === 210);
});

function plan(): ToolPlan {
  return planToolTrees(table(), CLI);
}
const target = (pid: number) => plan().members.find((m) => m.pid === pid)!;

test('verifyAtSignal: the happy paths — root under CLI, chain member, session orphan', () => {
  const t = table();
  const pr = { keeperPid: KEEPER, selfPid: SELF };
  assert.equal(verifyAtSignal(target(200), plan(), pr, reader(t)).ok, true);
  assert.equal((verifyAtSignal(target(200), plan(), pr, reader(t)) as { via: string }).via, 'root-under-cli');
  assert.equal(verifyAtSignal(target(201), plan(), pr, reader(t)).ok, true);
  const orphan = verifyAtSignal(target(250), plan(), pr, reader(t));
  assert.deepEqual({ ok: orphan.ok, via: (orphan as { via?: string }).via }, { ok: true, via: 'session' }, 'an orphan with a live root');
  // dead root: the orphan is still provably ours via the session id
  const noRoot = t.filter((x) => x.pid !== 210);
  assert.equal((verifyAtSignal(target(250), plan(), pr, reader(noRoot)) as { via?: string }).via, 'session');
});

test('verifyAtSignal REFUSES a recycled pid (start-time changed) — the D4 identity re-read', () => {
  const t = table();
  const recycled = { ...t.find((x) => x.pid === 201)!, startTicks: 999999, comm: 'innocent' };
  const v = verifyAtSignal(target(201), plan(), { keeperPid: KEEPER, selfPid: SELF }, reader(t, { 201: recycled }));
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /reused/);
});

test('verifyAtSignal FAILS CLOSED on an unreadable pid, and on a gone/zombie one (nothing to kill)', () => {
  const t = table();
  const pr = { keeperPid: KEEPER, selfPid: SELF };
  assert.deepEqual(verifyAtSignal(target(201), plan(), pr, reader(t, { 201: 'unreadable' })), { ok: false, reason: 'unreadable' });
  assert.deepEqual(verifyAtSignal(target(201), plan(), pr, reader(t, { 201: 'gone' })), { ok: false, reason: 'gone' });
  const z = { ...t.find((x) => x.pid === 201)!, state: 'Z' };
  assert.deepEqual(verifyAtSignal(target(201), plan(), pr, reader(t, { 201: z })), { ok: false, reason: 'zombie' });
});

test('verifyAtSignal NEVER signals the CLI, the keeper, the app itself or init — even from a forged plan', () => {
  const t = table();
  const pr = { keeperPid: KEEPER, selfPid: SELF };
  const base = target(201);
  for (const pid of [CLI.pid, KEEPER, SELF, 1, 0]) {
    const v = verifyAtSignal({ ...base, pid }, plan(), pr, reader(t));
    assert.equal(v.ok, false, `pid ${pid}`);
    assert.match((v as { reason: string }).reason, /protected-pid/);
  }
});

test('verifyAtSignal: no provable CLI ⇒ no ancestry ⇒ refuse (CLI gone / recycled / unreadable)', () => {
  const t = table();
  const pr = { keeperPid: KEEPER, selfPid: SELF };
  for (const cliRead of ['gone', 'unreadable', { ...t.find((x) => x.pid === 100)!, startTicks: 5 }] as FreshRead[]) {
    const v = verifyAtSignal(target(201), plan(), pr, reader(t, { 100: cliRead }));
    assert.deepEqual(v, { ok: false, reason: 'cli-identity-unprovable' });
  }
});

test('verifyAtSignal: a root that is no longer a child of the CLI is refused', () => {
  const t = table().map((x) => (x.pid === 200 ? { ...x, ppid: 1 } : x));
  const v = verifyAtSignal(target(200), plan(), { keeperPid: KEEPER, selfPid: SELF }, reader(t));
  assert.deepEqual(v, { ok: false, reason: 'root-not-under-cli' });
});

test('verifyAtSignal: an orphan that left the session (setsid) or whose root identity changed is refused', () => {
  const t = table();
  const pr = { keeperPid: KEEPER, selfPid: SELF };
  const left = { ...t.find((x) => x.pid === 250)!, sid: 250 };
  assert.equal(verifyAtSignal(target(250), plan(), pr, reader(t, { 250: left })).ok, false);
  const rootReused = { ...t.find((x) => x.pid === 210)!, startTicks: 123 };
  assert.deepEqual(verifyAtSignal(target(250), plan(), pr, reader(t, { 210: rootReused })), { ok: false, reason: 'session-root-mismatch' });
});

test('verifyAtSignal (non-session-leader roots): ppid chain is verified hop by hop; a reparented member is refused', () => {
  // A root that does NOT lead its session → lineage is the ppid chain.
  const t = [
    p(100, KEEPER, { startTicks: 1000, comm: 'claude', argv: ['claude'] }),
    shellC(200, 100, 'cmd', { sid: 100 }),
    p(201, 200, { sid: 100, comm: 'a', argv: ['a'] }),
    p(202, 201, { sid: 100, comm: 'b', argv: ['b'] }),
  ];
  const pl = planToolTrees(t, CLI);
  const tg = pl.members.find((m) => m.pid === 202)!;
  assert.equal(tg.rootIsSessionLeader, false);
  const pr = { keeperPid: KEEPER, selfPid: SELF };
  assert.equal((verifyAtSignal(tg, pl, pr, reader(t)) as { via?: string }).via, 'chain');
  // 201 died and 202 was reparented to init: the chain is broken → refused (fail closed).
  const reparented = { ...t[3], ppid: 1 };
  const v = verifyAtSignal(tg, pl, pr, reader(t, { 202: reparented }));
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /reparented/);
  // the middle hop's identity changed (recycled pid in the chain) → refused
  const hop = { ...t[2], startTicks: 77 };
  assert.match((verifyAtSignal(tg, pl, pr, reader(t, { 201: hop })) as { reason: string }).reason, /parent-identity-changed/);
});

// ── env provenance: an orphan (reparented, own session) that only CLAUDE_PID ties to this CLI ──

function tableWithDaemon(): ProcIdent[] {
  return [
    ...table(),
    // started AFTER the CLI (start-time 5000 > 1000), ppid 1, its own session, exported CLAUDE_PID=100
    p(700, 1, { sid: 700, startTicks: 5000, comm: 'sleep', argv: ['sleep', '7715'] }),
    // same marker but started BEFORE the CLI (a stale process from a previous CLI with a recycled pid value)
    p(701, 1, { sid: 701, startTicks: 500, comm: 'sleep', argv: ['sleep', '7716'] }),
    // marker of ANOTHER CLI
    p(702, 1, { sid: 702, startTicks: 5001, comm: 'sleep', argv: ['sleep', '7717'] }),
    // a descendant of the MCP sidecar that inherited the marker: must NOT be a tool
    p(703, 300, { sid: 90, startTicks: 5002, comm: 'chrome', argv: ['chrome'] }),
  ];
}
const ENV: Record<number, number> = { 700: 100, 701: 100, 702: 555, 703: 100 };
const claudePidOf = (x: ProcIdent): number | null => ENV[x.pid] ?? null;

test('env provenance: a new-session orphan with CLAUDE_PID==this CLI is planned; stale / other-CLI / sidecar-descendant are NOT', () => {
  const plan = planToolTrees(tableWithDaemon(), CLI, { claudePidOf });
  const env = plan.members.filter((m) => m.via === 'env').map((m) => m.pid);
  assert.deepEqual(env, [700]);
  const d = plan.members.find((m) => m.pid === 700)!;
  assert.equal(d.isRoot, false, 'an env orphan is never a root');
  // without the env reader nothing is proven → no env members (fail closed)
  assert.ok(!planToolTrees(tableWithDaemon(), CLI).members.some((m) => m.via === 'env'));
});

test('verifyAtSignal env path: re-reads CLAUDE_PID NOW — matching proves it, a changed/absent/unreadable value refuses', () => {
  const t = tableWithDaemon();
  const pl = planToolTrees(t, CLI, { claudePidOf });
  const tg = pl.members.find((m) => m.pid === 700)!;
  const pr = { keeperPid: KEEPER, selfPid: SELF };
  assert.equal((verifyAtSignal(tg, pl, pr, reader(t), () => 100) as { via?: string }).via, 'env');
  assert.equal(verifyAtSignal(tg, pl, pr, reader(t), () => 555).ok, false, 'another CLI\'s marker');
  assert.equal(verifyAtSignal(tg, pl, pr, reader(t), () => null).ok, false, 'no marker');
  const un = verifyAtSignal(tg, pl, pr, reader(t), () => 'unreadable');
  assert.deepEqual(un, { ok: false, reason: 'environ-unreadable' });
  // and never when the process is not younger than the CLI
  const old = { ...tg, startTicks: 900 };
  assert.equal(verifyAtSignal(old, pl, pr, reader(t, { 700: { ...t.find((x) => x.pid === 700)!, startTicks: 900 } }), () => 100).ok, false);
});

test('planToolTrees never makes the CLI a member, even through the env rule', () => {
  const t = [...table(), p(100, 90, { startTicks: 1000 })].filter((x, i, a) => a.findIndex((y) => y.pid === x.pid) === i);
  const plan = planToolTrees(t, CLI, { claudePidOf: () => 100 });
  assert.ok(!plan.members.some((m) => m.pid === CLI.pid || m.pid === KEEPER));
});

test('D11: planner records cwd + the reason it matched; the verdict carries the evidence the signal-time re-read proved', () => {
  const t = tableWithDaemon();
  const plan = planToolTrees(t, CLI, { claudePidOf, cwdOf: (x) => `/cwd/${x.pid}` });
  const d = plan.members.find((m) => m.pid === 700)!;
  assert.equal(d.cwd, '/cwd/700');
  assert.match(d.matched, /CLAUDE_PID=100 names this member's CLI \(pid 100, start-time 1000\); started after it \(start-time 5000\)/);
  const v = verifyAtSignal(d, plan, { keeperPid: KEEPER, selfPid: SELF }, reader(t), () => 100);
  assert.equal(v.ok, true);
  assert.match((v as { evidence: string }).evidence, /environ CLAUDE_PID=100 == CLI 100 whose start-time 1000 was just re-verified; process started after it \(5000 > 1000\)/);
  const root = plan.members.find((m) => m.pid === 200)!;
  assert.match(root.matched, /direct child of CLI 100, a shell run with -c/);
  assert.match(plan.members.find((m) => m.pid === 201)!.matched, /descendant of tool shell 200/);
});

test('D11 (a)(b)(c) at the verify layer: another member\'s CLAUDE_PID, a recycled CLI pid (start-time differs) and a process older than the CLI are all REFUSED', () => {
  const t = tableWithDaemon();
  const pl = planToolTrees(t, CLI, { claudePidOf });
  const d = pl.members.find((m) => m.pid === 700)!;
  const pr = { keeperPid: KEEPER, selfPid: SELF };
  // (a) another member's orphan: its marker names ANOTHER CLI
  assert.equal(verifyAtSignal(d, pl, pr, reader(t), () => 555).ok, false);
  // (b) the CLI pid was recycled between plan and signal: same pid, different start-time ⇒ the identity the marker is matched against is gone
  const recycledCli = { ...t.find((x) => x.pid === 100)!, startTicks: 6000 };
  assert.deepEqual(verifyAtSignal(d, pl, pr, reader(t, { 100: recycledCli }), () => 100), { ok: false, reason: 'cli-identity-unprovable' });
  // (c) a process that started BEFORE the member CLI never matches, whatever its marker says
  const older = { ...d, startTicks: 900 };
  assert.equal(verifyAtSignal(older, pl, pr, reader(t, { 700: { ...t.find((x) => x.pid === 700)!, startTicks: 900 } }), () => 100).ok, false);
});
