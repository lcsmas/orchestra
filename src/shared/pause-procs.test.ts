// #252 D1b — pure decisions of the pause trap's process killer (LEAD ruling D4).
// Every refusal reason is pinned by its own arm; each is what a missing identity re-read,
// a missing protected-pid guard or a missing lineage check would get wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSupervisorProc,
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
  // the keeper carries a NON-keeper argv here so the supervisor guard (F1) cannot be what spares it: only the structural ppid/pid<=1 exclusions can
  const t = [...table().map((x) => (x.pid === KEEPER ? { ...x, argv: ['node', '/x/not-a-supervisor.js'] } : x)), p(100, 90, { startTicks: 1000 })].filter((x, i, a) => a.findIndex((y) => y.pid === x.pid) === i);
  const plan = planToolTrees(t, CLI, { claudePidOf: () => 100 });
  assert.ok(!plan.members.some((m) => m.pid === CLI.pid || m.pid === KEEPER || m.pid <= 1), 'neither the CLI, its parent nor init is ever a member');
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

// ── review F1: another session's supervisor is never a tool, whatever marker it carries ──

function tableWithSupervisors(): ProcIdent[] {
  return [
    ...table(),
    // a daemonized Orchestra app launched from a tool: app → keeper.js (ws-OTHER) → that ws's claude CLI; all exported this CLI's CLAUDE_PID
    p(800, 1, { sid: 800, startTicks: 6000, comm: 'orchestra', argv: ['/tmp/.mount_OrchesXYZ/orchestra', '--type=gpu'] }),
    p(801, 800, { sid: 800, startTicks: 6001, comm: 'node', argv: ['node', '/x/.orchestra/bin/keeper.js', 'ws-OTHER', 'sock', 'pid', 'log'] }),
    p(802, 801, { sid: 800, startTicks: 6002, comm: 'claude', argv: ['/home/u/.local/bin/claude', '--output-format', 'stream-json'] }),
    // an ordinary daemonized rig: must still be killed (control)
    p(810, 1, { sid: 810, startTicks: 6010, comm: 'sleep', argv: ['sleep', '9'] }),
  ];
}
const ENV2: Record<number, number> = { 800: 100, 801: 100, 802: 100, 810: 100 };

test('F1: an env-proven orphan that IS or HAS a keeper / claude CLI / Orchestra app descendant is SPARED and listed; an ordinary daemon is still planned', () => {
  const plan = planToolTrees(tableWithSupervisors(), CLI, { claudePidOf: (x) => ENV2[x.pid] ?? null });
  const pids = plan.members.map((m) => m.pid);
  for (const banned of [800, 801, 802]) assert.ok(!pids.includes(banned), `${banned} must not be a member`);
  assert.ok(pids.includes(810), 'control: the ordinary daemon is a member');
  const spared = plan.spared.filter((x) => [800, 801, 802].includes(x.pid));
  assert.ok(spared.length >= 1 && spared.every((x) => /supervisor/.test(x.reason)), 'listed as spared with the reason');
});

test('F1: the signal-time re-read refuses a keeper/claude/app even from a forged plan (second layer)', () => {
  const t = tableWithSupervisors();
  const plan = planToolTrees(t, CLI, { claudePidOf: (x) => ENV2[x.pid] ?? null });
  for (const pid of [800, 801, 802]) {
    const forged = { ...plan.members[0], pid, startTicks: t.find((x) => x.pid === pid)!.startTicks, isRoot: false, via: 'env' as const, rootPid: 0, rootIsSessionLeader: false, rootStartTicks: undefined };
    const v = verifyAtSignal(forged, plan, { keeperPid: KEEPER, selfPid: SELF }, reader(t), () => 100);
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /supervisor/);
    // 800 (the app, ppid 1) has NO supervisor ancestor: only the SELF check can refuse it — the ancestor walk (801/802) must not mask that layer
    if (pid === 800) assert.match((v as { reason: string }).reason, /^supervisor \(keeper/);
  }
});

test('F1: a TREE member that is a claude sub-invocation run by the tool itself is still a tool (only orphans are guarded)', () => {
  const t = [...table(), p(203, 200, { sid: 200, comm: 'claude', argv: ['claude', '-p', 'x'] })];
  const plan = planToolTrees(t, CLI, {});
  assert.ok(plan.members.some((m) => m.pid === 203 && m.via === 'tree'));
});

test('round-3 F4 pin (signal-time): a TREE member named claude / keeper.js passes the re-read (the supervisor guard is for ORPHANS only); the same names as ORPHANS are refused', () => {
  const t = [...table(), p(203, 200, { sid: 200, comm: 'claude', argv: ['claude', '-p', 'x'] }), p(204, 200, { sid: 200, comm: 'node', argv: ['node', '-e', 'x', '/x/keeper.js', 'ws'] })];
  const pl = planToolTrees(t, CLI, {});
  for (const pid of [203, 204]) {
    const m = pl.members.find((x) => x.pid === pid)!;
    assert.equal(m.via, 'tree');
    const v = verifyAtSignal(m, pl, { keeperPid: KEEPER, selfPid: SELF }, reader(t), () => null);
    assert.equal(v.ok, true, `${pid} is a tool's own descendant: killable`);
  }
});

// ── pre-review M1/M2 (round 2): supervisor ANCESTORS, and the `orchestra` CLI client is not a supervisor ──

function tableWithSupervisorChildren(): ProcIdent[] {
  return [
    ...tableWithSupervisors(),
    // another session's MCP server UNDER its CLI (802): carries this CLI's CLAUDE_PID by inheritance, is neither a keeper nor a CLI itself
    p(803, 802, { sid: 800, startTicks: 6003, comm: 'node', argv: ['node', '/x/mcp-server.js'] }),
  ];
}
const ENV3: Record<number, number> = { ...ENV2, 803: 100, 820: 100, 821: 100 };

test('M1: an env-proven process UNDER another session\'s app/keeper/CLI (its MCP server) is SPARED — the ancestor walk, not only the descendant walk', () => {
  const plan = planToolTrees(tableWithSupervisorChildren(), CLI, { claudePidOf: (x) => ENV3[x.pid] ?? null });
  const pids = plan.members.map((m) => m.pid);
  assert.ok(!pids.includes(803), '803 (MCP under the foreign CLI) must not be a member');
  assert.ok(pids.includes(810), 'control: the ordinary daemon is still a member');
  assert.ok(plan.spared.some((x) => x.pid === 803 && /ANCESTOR/.test(x.reason)), 'listed as spared with the ancestor reason');
});

test('M1: the signal-time re-read refuses a process under a foreign supervisor (forged plan), fails CLOSED on an unreadable hop, and accepts the ordinary daemon (control)', () => {
  const t = tableWithSupervisorChildren();
  const plan = planToolTrees(t, CLI, { claudePidOf: (x) => ENV3[x.pid] ?? null });
  const forge = (pid: number) => ({ ...plan.members[0], pid, startTicks: t.find((x) => x.pid === pid)!.startTicks, isRoot: false, via: 'env' as const, rootPid: 0, rootIsSessionLeader: false, rootStartTicks: undefined });
  const v = verifyAtSignal(forge(803), plan, { keeperPid: KEEPER, selfPid: SELF }, reader(t), () => 100);
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /under another session/);
  const unreadable = verifyAtSignal(forge(803), plan, { keeperPid: KEEPER, selfPid: SELF }, reader(t, { 802: 'unreadable' }), () => 100); // 802 = 803's FIRST hop
  assert.equal(unreadable.ok, false, 'an unreadable ancestor hop is refused, never read as "no supervisor"');
  const ctl = plan.members.find((m) => m.pid === 810)!;
  assert.equal(verifyAtSignal(ctl, plan, { keeperPid: KEEPER, selfPid: SELF }, reader(t), () => 100).ok, true, 'control: the ordinary env orphan (ppid 1) is still killable');
});

test('M2: `Orchestra.AppImage cli <verb>` (the orchestra CLI client) is NOT a supervisor; the app\'s own main/helper processes are; an orphan shell polling `orchestra check` is still a tool', () => {
  assert.equal(isSupervisorProc({ comm: 'Orchestra.AppImag', argv: ['/tmp/.mount_OrchesAB/Orchestra.AppImage', 'cli', 'check'] }), false);
  assert.equal(isSupervisorProc({ comm: 'Orchestra.AppImag', argv: ['/tmp/.mount_OrchesAB/Orchestra.AppImage', '--no-sandbox', 'cli', 'send'] }), false);
  assert.equal(isSupervisorProc({ comm: 'orchestra', argv: ['/tmp/.mount_OrchesAB/orchestra', '--type=gpu'] }), true);
  assert.equal(isSupervisorProc({ comm: 'Orchestra.AppImag', argv: ['/tmp/.mount_OrchesAB/Orchestra.AppImage'] }), true);
  const t = [
    ...table(),
    p(820, 1, { sid: 820, startTicks: 6020, comm: 'zsh', argv: ['/usr/bin/zsh', '-c', 'while :; do orchestra check; sleep 5; done'] }),
    p(821, 820, { sid: 820, startTicks: 6021, comm: 'Orchestra.AppImag', argv: ['/tmp/.mount_OrchesAB/Orchestra.AppImage', 'cli', 'check'] }),
  ];
  const plan = planToolTrees(t, CLI, { claudePidOf: (x) => ENV3[x.pid] ?? null });
  assert.ok(plan.members.some((m) => m.pid === 820), 'the orphaned poll loop is a member although an `orchestra cli` call runs under it');
});

// ── review F9: a dead prior root's recycled pid cannot vouch for an unrelated session ──

test('F9: the session lineage of a PRIOR (dead) root needs the root\'s planned start-time; an innocent session leader that recycled the pid is refused', () => {
  const t = [
    p(100, KEEPER, { startTicks: 1000, comm: 'claude', argv: ['claude'] }),
    p(500, 1, { sid: 500, startTicks: 9999, comm: 'innocent-daemon', argv: ['innocent'] }), // recycled pid 500, a session leader now
    p(501, 500, { sid: 500, startTicks: 10000, comm: 'sleep', argv: ['sleep', '5'] }),
  ];
  const plan = planToolTrees(t, CLI, { priorRoots: [{ pid: 500, startTicks: 1100 }] }); // the PRIOR root 500 started at 1100 (and is dead)
  const tg = plan.members.find((m) => m.pid === 501);
  assert.ok(tg, 'planned as a session orphan of the prior root');
  assert.equal(tg!.rootStartTicks, 1100);
  const v = verifyAtSignal(tg!, plan, { keeperPid: KEEPER, selfPid: SELF }, reader(t));
  assert.equal(v.ok, false, 'pid 500 is alive with a DIFFERENT start-time: not our root');
  assert.match((v as { reason: string }).reason, /session-root-mismatch|no-lineage-proof|environ/);
  // unknown planned start-time (forged) ⇒ refuse, even when the root is simply gone (fail-closed)
  const noStart = { ...tg!, rootStartTicks: undefined };
  assert.equal(verifyAtSignal(noStart, plan, { keeperPid: KEEPER, selfPid: SELF }, reader(t.filter((x) => x.pid !== 500))).ok, false);
  // control: the root is really gone and its start-time was planned ⇒ accepted via the session
  const v2 = verifyAtSignal(tg!, plan, { keeperPid: KEEPER, selfPid: SELF }, reader(t.filter((x) => x.pid !== 500)));
  assert.equal(v2.ok, true);
});
