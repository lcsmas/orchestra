// #325 — the PURE half of the Reliquat kill (ledger #329, FI-1 v1): `judgeReliquat` (the ONE decision, plan time and signal time), the ancestor walk,
// the order, the retry merge and the Consigne lines. Each arm names the clause it protects (in-place mutants: scripts/pause-trap/mutants-reliquats.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type FreshRead, type ProcIdent } from './pause-procs.ts';
import {
  combineReliquats,
  depthsOf,
  emptyReliquatReport,
  isOwnKeeperProc,
  judgeReliquat,
  mergeReliquats,
  reliquatConsigneLines,
  reliquatKillOrder,
  sessionAncestorOf,
  MAX_RELIQUATS_RECORDED,
  type ReliquatKilled,
  type ReliquatProtect,
  type ScopeListing,
  type ScopeMember,
  type ScopeRef,
} from './pause-reliquats.ts';

const SCOPE: ScopeRef = { unit: 'orchestra-rig-wh-m1-abc123.scope', cgroupDir: '/sys/fs/cgroup/x/orchestra-rig-wh-m1-abc123.scope' };
const KEEPER = 90;
const CLI = 100;
const SELF = 7;
const PROTECT: ReliquatProtect = { keeperPid: KEEPER, cliPid: CLI, selfPid: SELF };

const proc = (pid: number, ppid: number, argv: string[], extra: Partial<ProcIdent> = {}): ProcIdent => ({ pid, ppid, sid: pid, startTicks: 1000 + pid, comm: argv[0].split('/').pop()!.slice(0, 15), state: 'S', argv, ...extra });
const member = (pid: number, ppid: number, role: ScopeMember['role'], comm = 'chrome'): ScopeMember => ({ pid, startTicks: 1000 + pid, ppid, comm, role });

/** A `read` over a fixed table (a missing pid is 'gone'; `unreadable` names pids that read as unreadable). */
const readOver = (procs: ProcIdent[], unreadable: number[] = []) => (pid: number): FreshRead => (unreadable.includes(pid) ? 'unreadable' : (procs.find((p) => p.pid === pid) ?? 'gone'));

const chrome = proc(500, 1, ['/usr/bin/chrome', '--headless', '--remote-debugging-port=0']);
const listingOf = (...m: ScopeMember[]): ScopeListing => m;

test('a detached Reliquat of the scope (role reliquat, ppid=init, plain argv) IS signal-able — and the evidence names what was re-read', () => {
  const v = judgeReliquat(500, null, SCOPE, listingOf(member(500, 1, 'reliquat')), PROTECT, readOver([chrome]));
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.match(v.evidence, /orchestra-rig-wh-m1-abc123\.scope/);
    assert.match(v.evidence, /start-time 1500 unchanged/);
    assert.equal(v.proc.pid, 500);
  }
});

test('the session is NEVER a target: keeper, CLI, MCP server (roles keeper/cli/session) are refused by ROLE', () => {
  for (const role of ['keeper', 'cli', 'session'] as const) {
    const v = judgeReliquat(500, null, SCOPE, listingOf(member(500, 1, role)), PROTECT, readOver([chrome]));
    assert.equal(v.ok, false, role);
    if (!v.ok) assert.match(v.reason, new RegExp(`role-is-${role}`), role);
  }
});

test('DEFENCE IN DEPTH — a wrong classification (stale pid file ⇒ the live keeper/CLI listed as `reliquat`) still cannot reach the trap\'s proven keeper, CLI, the app or init', () => {
  const procs = [proc(KEEPER, 1, ['node', '/x/keeper.js', 'm1']), proc(CLI, KEEPER, ['claude', '--print']), chrome];
  for (const pid of [KEEPER, CLI, SELF, 1, 0]) {
    const v = judgeReliquat(pid, null, SCOPE, listingOf(member(pid, 1, 'reliquat')), PROTECT, readOver(procs));
    assert.equal(v.ok, false, String(pid));
    if (!v.ok) assert.equal(v.kind, 'refused');
  }
  // the pausing call's process chain is protected too (the pauser)
  const v = judgeReliquat(500, null, SCOPE, listingOf(member(500, 1, 'reliquat')), { ...PROTECT, extraPids: [500] }, readOver([chrome]));
  assert.equal(v.ok, false);
});

test('DEFENCE IN DEPTH — a keeper.js / claude CLI / Orchestra app listed as `reliquat` (pid file unreadable) is SPARED by what it is, and so is anything UNDER one (an MCP server of a mis-classified session)', () => {
  const keeperLike = proc(600, 1, ['node', '/x/keeper.js', 'm1']);
  const claudeLike = proc(601, 1, ['claude', '--print']);
  const appLike = proc(602, 1, ['/opt/Orchestra.AppImage']);
  const mcp = proc(603, 601, ['node', 'mcp-server.js']); // child of a claude CLI
  const grandchild = proc(604, 603, ['sleep', '600']);
  const procs = [keeperLike, claudeLike, appLike, mcp, grandchild];
  for (const p of procs) {
    const v = judgeReliquat(p.pid, null, SCOPE, listingOf(member(p.pid, p.ppid, 'reliquat', p.comm)), PROTECT, readOver(procs));
    assert.equal(v.ok, false, p.argv.join(' '));
    if (!v.ok) assert.equal(v.kind, 'spared', p.argv.join(' '));
  }
});

test('a process under the trap\'s PROVEN CLI / keeper (even when the scope says reliquat) is spared; one reparented to init (ppid chain ends at 1) is not', () => {
  const tool = proc(510, CLI, ['sleep', '600']);
  const cli = proc(CLI, KEEPER, ['node', 'not-named-claude.js']); // the proven CLI pid itself is in `sessionPids`, whatever its argv
  const under = judgeReliquat(510, null, SCOPE, listingOf(member(510, CLI, 'reliquat')), PROTECT, readOver([tool, cli]));
  assert.equal(under.ok, false);
  if (!under.ok) assert.equal(under.kind, 'spared');
  const deep = proc(511, 510, ['sleep', '601']);
  const underDeep = judgeReliquat(511, null, SCOPE, listingOf(member(511, 510, 'reliquat')), PROTECT, readOver([deep, tool, cli]));
  assert.equal(underDeep.ok, false);
  const orphan = proc(512, 1, ['sleep', '602']);
  assert.equal(judgeReliquat(512, null, SCOPE, listingOf(member(512, 1, 'reliquat')), PROTECT, readOver([orphan])).ok, true);
});

test('the PAUSING CALL\'s chain is protected from the signal but is NOT a session ancestor: an orphan reparented to the user manager (a subreaper that sits in that chain) is still a Reliquat', () => {
  const manager = proc(2000, 1, ['/usr/lib/systemd/systemd', '--user']); // the subreaper: ancestor of the keeper, hence in the recorded pause-call chain
  const orphan = proc(500, 2000, ['/usr/bin/chrome', '--headless']);
  const withChain: ReliquatProtect = { ...PROTECT, extraPids: [301, 300, 2000] };
  const v = judgeReliquat(500, null, SCOPE, listingOf(member(500, 2000, 'reliquat')), withChain, readOver([orphan, manager]));
  assert.equal(v.ok, true, 'reparented to the manager: killed, not spared as "under the session"');
  // ...while the pause call itself (and the manager, were it listed) are never signalled
  assert.equal(judgeReliquat(301, null, SCOPE, listingOf(member(301, 300, 'reliquat')), withChain, readOver([proc(301, 300, ['node', 'cli.js', 'run', 'pause'])])).ok, false);
  assert.equal(judgeReliquat(2000, null, SCOPE, listingOf(member(2000, 1, 'reliquat')), withChain, readOver([manager])).ok, false);
  // the keeper / CLI / app ARE session ancestors
  const underCli = proc(510, CLI, ['sleep', '9']);
  assert.equal(judgeReliquat(510, null, SCOPE, listingOf(member(510, CLI, 'reliquat')), PROTECT, readOver([underCli, proc(CLI, KEEPER, ['node', 'x'])])).ok, false);
});

test('fail closed on an unreadable ancestor: UNKNOWN is not NONE — refused, never signalled', () => {
  const child = proc(520, 521, ['sleep', '600']);
  const parent = proc(521, 1, ['sh', '-c', 'x']);
  const v = judgeReliquat(520, null, SCOPE, listingOf(member(520, 521, 'reliquat')), PROTECT, readOver([child, parent], [521]));
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, 'ancestry-unreadable');
});

test('a dead hop in the chain (reparented past it) ends the walk with `no` — the orphan of a dead parent IS a Reliquat', () => {
  const child = proc(530, 531, ['sleep', '600']); // parent 531 is gone
  assert.equal(judgeReliquat(530, null, SCOPE, listingOf(member(530, 531, 'reliquat')), PROTECT, readOver([child])).ok, true);
});

test('the SCOPE decides membership at signal time: a pid the fresh listing no longer holds is `gone` (left the scope / died), never signalled; an unreadable listing is refused; a vanished scope is gone', () => {
  const v1 = judgeReliquat(500, 1500, SCOPE, listingOf(member(999, 1, 'reliquat')), PROTECT, readOver([chrome]));
  assert.equal(v1.ok, false);
  if (!v1.ok) assert.deepEqual([v1.kind, v1.reason], ['gone', 'not-in-the-scope-any-more']);
  const v2 = judgeReliquat(500, 1500, SCOPE, 'unreadable', PROTECT, readOver([chrome]));
  assert.equal(v2.ok, false);
  if (!v2.ok) assert.deepEqual([v2.kind, v2.reason], ['refused', 'scope-unreadable']);
  const v3 = judgeReliquat(500, 1500, SCOPE, 'gone', PROTECT, readOver([chrome]));
  assert.equal(v3.ok, false);
  if (!v3.ok) assert.equal(v3.kind, 'gone');
});

test('IDENTITY (pid + start-time) at signal time: a recycled pid (planned start-time differs, in the listing OR in /proc) is refused, a zombie/gone/unreadable process too', () => {
  // a GENUINE recycle: the scope's listing AND /proc both show the NEW owner of the pid — only the planned identity (1500) can tell it from the planned process
  const recycledEverywhere = judgeReliquat(500, 1500, SCOPE, listingOf({ ...member(500, 1, 'reliquat'), startTicks: 9999 }), PROTECT, readOver([{ ...chrome, startTicks: 9999 }]));
  assert.equal(recycledEverywhere.ok, false, 'listing and /proc agree on 9999, the plan said 1500');
  if (!recycledEverywhere.ok) assert.equal(recycledEverywhere.reason, 'reused (start-time changed)');
  // planned identity 1500, the listing now holds the pid with ANOTHER start-time (recycled)
  const recycledInListing = judgeReliquat(500, 1500, SCOPE, listingOf({ ...member(500, 1, 'reliquat'), startTicks: 9999 }), PROTECT, readOver([chrome]));
  assert.equal(recycledInListing.ok, false);
  if (!recycledInListing.ok) assert.equal(recycledInListing.reason, 'reused (start-time changed)');
  // the listing and the planned identity agree but an independent /proc read says another process owns the pid
  const recycledInProc = judgeReliquat(500, 1500, SCOPE, listingOf(member(500, 1, 'reliquat')), PROTECT, readOver([{ ...chrome, startTicks: 4242 }]));
  assert.equal(recycledInProc.ok, false);
  if (!recycledInProc.ok) assert.equal(recycledInProc.reason, 'reused (start-time changed)');
  const zombie = judgeReliquat(500, 1500, SCOPE, listingOf(member(500, 1, 'reliquat')), PROTECT, readOver([{ ...chrome, state: 'Z' }]));
  assert.equal(zombie.ok, false);
  if (!zombie.ok) assert.equal(zombie.kind, 'gone');
  const gone = judgeReliquat(500, 1500, SCOPE, listingOf(member(500, 1, 'reliquat')), PROTECT, readOver([]));
  assert.equal(gone.ok, false);
  if (!gone.ok) assert.equal(gone.kind, 'gone');
  const unreadable = judgeReliquat(500, 1500, SCOPE, listingOf(member(500, 1, 'reliquat')), PROTECT, readOver([chrome], [500]));
  assert.equal(unreadable.ok, false);
  if (!unreadable.ok) assert.deepEqual([unreadable.kind, unreadable.reason], ['refused', 'unreadable']);
  // the control: the SAME process with the matching identity IS ok
  assert.equal(judgeReliquat(500, 1500, SCOPE, listingOf(member(500, 1, 'reliquat')), PROTECT, readOver([chrome])).ok, true);
});

test('sessionAncestorOf: hits a supervisor or a session pid, stops at init / a dead hop, unknown on an unreadable hop, bounded on a cycle', () => {
  const a = proc(10, 11, ['sleep']); const b = proc(11, 12, ['sh']); const c = proc(12, 1, ['claude']);
  assert.equal(sessionAncestorOf(a.ppid, readOver([a, b, c]), new Set()), 'yes');
  assert.equal(sessionAncestorOf(a.ppid, readOver([a, b, proc(12, 1, ['bash'])]), new Set()), 'no');
  assert.equal(sessionAncestorOf(a.ppid, readOver([a, b, proc(12, 1, ['bash'])]), new Set([12])), 'yes');
  assert.equal(sessionAncestorOf(11, readOver([b, c], [11]), new Set()), 'unknown');
  const x = proc(20, 21, ['sh']); const y = proc(21, 20, ['sh']); // a malformed cycle
  assert.equal(sessionAncestorOf(21, readOver([x, y]), new Set()), 'unknown');
});

test('kill order: children before parents inside the scope, then newest first; depthsOf counts hops inside the listing', () => {
  const ms = [member(1, 0, 'reliquat'), member(2, 1, 'reliquat'), member(3, 2, 'reliquat'), member(4, 1, 'reliquat')].map((m, i) => ({ ...m, ppid: [0, 1, 2, 1][i] }));
  const d = depthsOf(ms);
  assert.deepEqual([1, 2, 3, 4].map((p) => d.get(p)), [0, 1, 2, 1]);
  const order = reliquatKillOrder(ms.map((m) => ({ pid: m.pid, startTicks: m.startTicks, depth: d.get(m.pid)! }))).map((t) => t.pid);
  assert.deepEqual(order, [3, 4, 2, 1]);
});

const killed = (pid: number, extra: Partial<ReliquatKilled> = {}): ReliquatKilled => ({ pid, startTicks: 1000 + pid, comm: 'chrome', cmd: `chrome --n=${pid}`, cwd: '/w', startedAt: 1_700_000_000_000, scope: SCOPE.unit, evidence: 'e', signal: 'SIGTERM', outcome: 'exited', ...extra });

test('a RETRY merges BY IDENTITY: what an earlier attempt killed stays listed, a re-listed identity is replaced not duplicated, the latest attempt\'s facts win; truncation keeps the count', () => {
  const first = { ...emptyReliquatReport([SCOPE.unit]), killed: [killed(1), killed(2)], survivors: [{ pid: 3, comm: 'x', cmd: 'x', reason: 'old' }], rounds: 2 };
  const second = { ...emptyReliquatReport([SCOPE.unit, 'other.scope']), killed: [killed(2, { signal: 'SIGKILL' }), killed(3)], rounds: 1 };
  const m = mergeReliquats(first, second);
  assert.deepEqual(m.killed.map((k) => k.pid).sort(), [1, 2, 3]);
  assert.equal(m.killed.find((k) => k.pid === 2)!.signal, 'SIGKILL');
  assert.deepEqual(m.survivors, [], 'the survivors list is the LATEST census, not a union');
  assert.deepEqual(m.scopes.sort(), ['orchestra-rig-wh-m1-abc123.scope', 'other.scope']);
  assert.equal(m.rounds, 2);
  const many = { ...emptyReliquatReport(), killed: Array.from({ length: MAX_RELIQUATS_RECORDED + 30 }, (_, i) => killed(10_000 + i)) };
  const t = mergeReliquats(undefined, many);
  assert.equal(t.killed.length, MAX_RELIQUATS_RECORDED);
  assert.equal(t.killedTotal, MAX_RELIQUATS_RECORDED + 30);
  assert.equal(mergeReliquats(t, emptyReliquatReport()).killedTotal, MAX_RELIQUATS_RECORDED + 30, 'a later merge still counts what an earlier truncation dropped');
});

const strip = (s: unknown): string => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ');

test('a retry does not keep a STALE `survived`: an earlier attempt\'s entry that the latest census no longer finds alive reads `exited`; still alive stays `survived`; an UNKNOWN census changes nothing', () => {
  const first = { ...emptyReliquatReport([SCOPE.unit]), killed: [killed(1, { outcome: 'survived' }), killed(2, { outcome: 'survived' })] };
  const latest = { ...emptyReliquatReport([SCOPE.unit]), survivors: [{ pid: 2, startTicks: 1002, comm: 'c', cmd: 'c', reason: 'still-alive-after-kill' }] };
  const m = mergeReliquats(first, latest);
  assert.deepEqual(m.killed.map((k) => [k.pid, k.outcome]), [[1, 'exited'], [2, 'survived']]);
  assert.deepEqual(mergeReliquats(first, { ...latest, unknown: 'scope unreadable' }).killed.map((k) => k.outcome), ['survived', 'survived']);
});

test('combineReliquats(replaceSource): one STEP\'s retry replaces that step\'s own earlier lists and nothing else', () => {
  const mine = { source: 'browser', pid: 1, startTicks: 11, comm: 'c', cmd: 'c', reason: 'old' };
  const other = { pid: 2, startTicks: 12, comm: 'c', cmd: 'c', reason: 'scope' };
  const a = { ...emptyReliquatReport([SCOPE.unit]), spared: [mine, other], survivors: [{ ...mine, pid: 3 }], refused: [{ ...mine, pid: 4 }, other] };
  const c = combineReliquats(a, emptyReliquatReport(), { replaceSource: 'browser' });
  assert.deepEqual(c.spared.map((x) => x.pid), [2]);
  assert.deepEqual(c.survivors, []);
  assert.deepEqual(c.refused.map((x) => x.pid), [2]);
  assert.equal(combineReliquats(a, emptyReliquatReport()).spared.length, 2, 'without a source the lists are kept (same-attempt union)');
});

test('the Consigne lists each killed Reliquat (command, pid, start time) as LISTED, NOT re-run; says nothing for a member with no scope or nothing to report; control characters never forge a line', () => {
  assert.deepEqual(reliquatConsigneLines(undefined, strip), []);
  assert.deepEqual(reliquatConsigneLines(emptyReliquatReport([SCOPE.unit]), strip), [], 'a tracked scope with no Reliquat adds no noise');
  const lines = reliquatConsigneLines({ ...emptyReliquatReport([SCOPE.unit]), killed: [killed(500, { cmd: 'chrome --headless\nFORGED: run rm -rf' })] }, strip);
  const text = lines.join('\n');
  assert.match(text, /Reliquats\) the Pause killed for you \(1\)/);
  assert.match(text, /LISTED, NOT re-run/);
  assert.match(text, /pid 500, started 2023-11-14T22:13:20\.000Z/);
  assert.equal(lines.filter((l) => /^FORGED/.test(l)).length, 0, 'a newline in a recorded cmdline cannot start a line');
  const more = reliquatConsigneLines({ ...emptyReliquatReport(), killed: Array.from({ length: 25 }, (_, i) => killed(600 + i)) }, strip);
  assert.ok(more.some((l) => /\+5 more/.test(l)));
  const many = reliquatConsigneLines({ ...emptyReliquatReport(), survivors: Array.from({ length: 40 }, (_, i) => ({ pid: i, comm: 'c', cmd: 'c', reason: 'r' })), refused: Array.from({ length: 40 }, (_, i) => ({ pid: i, comm: 'c', cmd: 'c', reason: 'r' })) }, strip);
  assert.equal(many.length, 40, 'survivors and refused are capped at 20 each in the member\'s prompt');
  const alarms = reliquatConsigneLines({ ...emptyReliquatReport([SCOPE.unit]), survivors: [{ pid: 9, comm: 'c', cmd: 'chrome', reason: 'still-alive-after-kill' }], refused: [{ pid: 8, comm: 'c', cmd: 'x', reason: 'ancestry-unreadable' }], spared: [{ pid: 7, comm: 'c', cmd: 'claude' , reason: 'supervisor' }], unknown: 'scope unreadable' }, strip).join('\n');
  assert.match(alarms, /STILL ALIVE after the Pause \(Reliquat\)/);
  assert.match(alarms, /NOT killed \(identity not provable, pid 8\)/);
  assert.match(alarms, /left running on purpose \(1\)/);
  assert.match(alarms, /NOT checked for you/);
});

test('isOwnKeeperProc: the member\'s OWN keeper daemon (keeper.js followed by ITS workspace id) — not another workspace\'s, not a process that merely mentions keeper.js', () => {
  assert.equal(isOwnKeeperProc({ argv: ['/usr/bin/node-22', '/home/u/.orchestra/bin/keeper.js', 'ws-1', '/s.sock', '/s.pid', '/s.log'] }, 'ws-1'), true);
  assert.equal(isOwnKeeperProc({ argv: ['node', 'keeper.js', 'ws-2', '/s.sock'] }, 'ws-1'), false, 'a nested rig app\'s keeper belongs to another workspace');
  assert.equal(isOwnKeeperProc({ argv: ['tail', '-f', 'keeper.js.log', 'ws-1'] }, 'ws-1'), false);
  assert.equal(isOwnKeeperProc({ argv: ['node', 'ws-1', 'keeper.js'] }, 'ws-1'), false, 'the id must FOLLOW keeper.js');
  assert.equal(isOwnKeeperProc({ argv: null }, 'ws-1'), false);
});

test('review F1/F3 wording: a live PARENT that left the scope reads « STILL ALIVE and OUTSIDE your scope (NOT killed) » with its reason; a `planned` entry is never claimed as killed', () => {
  const parent = { pid: 700, comm: 'chrome', cmd: '/opt/chromium/chrome --headless=new', reason: 'parent of 2 killed Reliquats (pid 701, 702); it LEFT the scope (now in cgroup app-org.chromium.Chromium-700.scope) and is still alive — NOT killed', kind: 'left-scope-parent' as const };
  const text = reliquatConsigneLines({ ...emptyReliquatReport([SCOPE.unit]), killed: [killed(701), killed(702)], survivors: [parent, { pid: 9, comm: 'c', cmd: 'daemon', reason: 'still-alive-after-kill' }] }, strip).join('\n');
  assert.match(text, /STILL ALIVE and OUTSIDE your scope \(NOT killed — not in your scope\): \/opt\/chromium\/chrome --headless=new \(pid 700\) — parent of 2 killed Reliquats/);
  assert.match(text, /STILL ALIVE after the Pause \(Reliquat\): daemon \(pid 9/, 'an ordinary survivor keeps its own wording');
  assert.doesNotMatch(text.split('\n').filter((l) => /^STILL ALIVE after the Pause/.test(l)).join('\n'), /pid 700/, 'the parent is not listed as a Reliquat survivor');
  const planned = reliquatConsigneLines({ ...emptyReliquatReport([SCOPE.unit]), killed: [killed(710), killed(711, { outcome: 'planned' }), killed(712, { outcome: 'planned' })] }, strip).join('\n');
  assert.match(planned, /the Pause killed for you \(1\)/, 'only the completed entry is « killed »');
  assert.match(planned, /about to kill when it was interrupted \(2\) — their outcome was not recorded.*pid 711.*pid 712/);
});

test('combineReliquats: the scope\'s report and the browsers\' of the SAME attempt become one — killed unioned by identity, every list concatenated (nothing of either side dropped), unknown/error joined', () => {
  const scope = { ...emptyReliquatReport([SCOPE.unit]), killed: [killed(1), killed(2)], survivors: [{ pid: 9, startTicks: 1009, comm: 'x', cmd: 'x', reason: 's' }], rounds: 2, unknown: 'scope y unreadable' };
  const browsers = { ...emptyReliquatReport(), killed: [killed(2, { scope: 'browser:pipe' }), killed(3, { scope: 'browser:port' })], spared: [{ pid: 7, startTicks: 1007, comm: 'chrome', cmd: 'chrome', reason: 'client' }], survivors: [{ pid: 8, startTicks: 1008, comm: 'c', cmd: 'c', reason: 'b' }], rounds: 1, error: 'proc table gone' };
  const c = combineReliquats(scope, browsers);
  assert.deepEqual(c.killed.map((k) => k.pid), [1, 2, 3]);
  assert.equal(c.killed.find((k) => k.pid === 2)!.scope, 'browser:pipe', 'the later side wins for one identity');
  assert.deepEqual(c.survivors.map((s) => s.pid).sort(), [8, 9], 'survivors of BOTH sides stay');
  assert.deepEqual(c.spared.map((s) => s.pid), [7]);
  assert.deepEqual([c.scopes, c.rounds, c.unknown, c.error], [[SCOPE.unit], 2, 'scope y unreadable', 'proc table gone']);
  assert.equal(combineReliquats(undefined, browsers), browsers, 'nothing to combine with: the browsers\' report as it is');
  assert.equal(combineReliquats(null, browsers), browsers);
});
