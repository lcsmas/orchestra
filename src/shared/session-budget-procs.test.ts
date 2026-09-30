// #210 — the process / memory / zero-survivors-after-delete half of the session budget (src/shared/session-budget.ts).
// Pure judge tests over synthetic reports + the checker of the must-FAIL arms + the mutant anchors against the
// shipped source. The rig (scripts/session-budget, `pnpm run test:session-budget`) drives the REAL session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  SESSION_BUDGETS,
  SUBJECT_MARKERS,
  formatProcessTree,
  judgeSessionBudget,
  type DeleteReport,
  type ProcEntry,
  type ProcessCensus,
  type RequestCounts,
  type SessionBudgetReport,
} from './session-budget.ts';
import { judgeProcsArm, passArmProblems, PROCS_ARMS } from '../../scripts/session-budget/procs-arms.mjs';
import { MUTANTS } from '../../scripts/session-budget/mutants.mjs';
import { identity } from '../../scripts/session-budget/delete-teardown.mjs';

const KB = 1024;
const proc = (pid: number, ppid: number, kind: ProcEntry['kind'], mb: number, cmd: string, swapMB = 0): ProcEntry => ({
  pid, ppid, kind, rssKB: mb * KB, swapKB: swapMB * KB, cmd,
});
/** The measured healthy 4-server tree (2026-09-30): keeper 52, CLI 275, 4 × MCP 51 MB. */
const healthyProcs = (): ProcEntry[] => [
  proc(22, 1, 'keeper', 52, '/usr/bin/node-22 /o/bin/keeper.js ws-sb /o/keepers/ws-sb.sock'),
  proc(29, 22, 'cli', 275, '/home/u/.local/bin/claude --output-format stream-json'),
  ...[1, 2, 3, 4].map((i) => proc(70 + i, 29, 'mcp', 51, `/usr/bin/node-22 /r/fake-mcp-server.mjs --name fixsrv${i} --tools 15${i === 4 ? ' --stubborn' : ''}`)),
];
const censusOf = (procs: ProcEntry[]): ProcessCensus => {
  const byKind = { cli: 0, keeper: 0, mcp: 0, hook: 0, other: 0 };
  for (const p of procs) byKind[p.kind]++;
  return {
    total: procs.length, zombies: 0, byKind, procs,
    rssKB: procs.reduce((a, p) => a + (p.rssKB ?? 0), 0), swapKB: procs.reduce((a, p) => a + (p.swapKB ?? 0), 0),
  };
};
// The healthy PRODUCTION-config session's request windows, as C1's tests build them (session-budget.test.ts `good()`):
// one main model call + one tool-less Haiku side call + the CLI's startup egress, no count_tokens before the first reply.
const HAIKU = 'claude-haiku-4-5-20251001';
const HOST = 'api.anthropic.com:443';
const win = (main: number, count_tokens: number, side: Record<string, number>, egress: Record<string, number>): RequestCounts => {
  const sideN = Object.values(side).reduce((a, b) => a + b, 0);
  return { model: main + sideN, main, side, count_tokens, other: 0, otherPaths: {}, egress, total: main + sideN + count_tokens };
};
function report(over: { first?: ProcEntry[]; end?: ProcEntry[]; mcpServers?: number; del?: DeleteReport } = {}): SessionBudgetReport {
  const first = over.first ?? healthyProcs();
  const n = over.mcpServers ?? 4;
  return {
    schema: 1, arm: 't', cli: { version: '2.1.284', path: '/x' },
    fixture: { skills: 60, memoryFiles: 50, mcpServers: n, toolsPerServer: 15, claudeMdKB: 48 },
    containment: 'netns+pidns',
    timing: { timeToFirstReplyMs: 1400, fakeModelLatencyMs: 500, setupMs: 380, firstReplyAbsMs: 1780, turnEndAbsMs: 1900, mainRequestStartAbsMs: 1200, startupEgressSpanMs: 700 },
    startupEgress: { [HOST]: 3 },
    envParity: { source: '/proc/4242/environ at the first reply', trafficKnobsSet: [] },
    requests: {
      beforeFirstReply: win(1, 0, { [HAIKU]: 1 }, { [HOST]: 5 }),
      afterFirstReply: win(0, 57, {}, { [HOST]: 3 }),
      total: win(1, 57, { [HAIKU]: 1 }, { [HOST]: 8 }),
    },
    processes: { atFirstReply: censusOf(first), atEnd: censusOf(over.end ?? first), survivorsAfterTeardown: over.del ? over.del.survivors.length : 0 },
    ...(over.del ? { delete: over.del } : {}),
    egress: [],
    subject: { firstModelRequestTools: n * 15, firstModelRequestBytes: 400000, markersSeen: [...SUBJECT_MARKERS], mcpServersConnected: n, toolsAtInit: n * 15 },
  };
}
const brokenIds = (r: SessionBudgetReport) => judgeSessionBudget(r).verdicts.filter((v) => !v.ok).map((v) => v.id).sort();
const del = (over: Partial<DeleteReport> = {}): DeleteReport => ({
  via: 'cli', boundMs: 10_000, returnedMs: 120, elapsedMs: 130, dwellMs: 2000, treeBefore: healthyProcs(), survivors: [], storeRecordGone: true, ...over,
});

test('the #210 budget numbers are these literals (one place, next to #208\'s)', () => {
  assert.deepEqual({ ...SESSION_BUDGETS.processes, memoryMB: { ...SESSION_BUDGETS.processes.memoryMB } }, {
    keeper: 1, cli: 1, mcpPerConfiguredServer: 1, hook: 0, other: 0, memoryMB: { base: 400, perMcpServer: 65 },
  });
  assert.deepEqual({ ...SESSION_BUDGETS.afterDelete }, { survivors: 0, zeroWithinMs: 5000, stableForMs: 2000 });
});

test('the measured healthy tree passes every budget, at both windows (control: the arms below must differ)', () => {
  const j = judgeSessionBudget(report());
  assert.equal(j.ok, true, JSON.stringify(j.verdicts.filter((v) => !v.ok)));
  assert.equal(j.void, false);
  const ids = j.verdicts.map((v) => v.id);
  for (const w of ['atFirstReply', 'atEnd']) {
    for (const k of ['keeper', 'cli', 'mcp', 'hook', 'other', 'total', 'memoryMB']) assert.ok(ids.includes(`session.processes.${w}.${k}`), `${w}.${k} is judged`);
  }
});

test('a second keeper breaks keeper + total (and only those), naming BOTH keepers in the tree', () => {
  const procs = [...healthyProcs(), proc(23, 1, 'keeper', 52, '/usr/bin/node-22 /o/bin/keeper.js ws-sb /o/keepers/ws-sb.sock')];
  const r = report({ first: procs });
  assert.deepEqual(brokenIds(r), ['session.processes.atEnd.keeper', 'session.processes.atEnd.total', 'session.processes.atFirstReply.keeper', 'session.processes.atFirstReply.total'].sort());
  const v = judgeSessionBudget(r).verdicts.find((x) => x.id === 'session.processes.atFirstReply.keeper')!;
  assert.equal(v.actual, 2);
  assert.match(v.message, /allowed at most 1, saw 2/);
  const tree = (v.tree ?? []).join('\n');
  assert.match(tree, /\[22\] keeper/);
  assert.match(tree, /\[23\] keeper/);
  assert.match(tree, /\[29\] cli/);
});

test('a hook shell or a stray helper breaks hook/other + total; a 5th MCP process breaks mcp + total', () => {
  const withHook = [...healthyProcs(), proc(90, 29, 'hook', 3, '/bin/sh /w/.orchestra/hooks/pretool.sh')];
  assert.deepEqual(brokenIds(report({ first: withHook })), ['session.processes.atEnd.hook', 'session.processes.atEnd.total', 'session.processes.atFirstReply.hook', 'session.processes.atFirstReply.total']);
  const withStray = [...healthyProcs(), proc(91, 22, 'other', 0, 'sleep 600')];
  assert.deepEqual(brokenIds(report({ first: withStray })), ['session.processes.atEnd.other', 'session.processes.atEnd.total', 'session.processes.atFirstReply.other', 'session.processes.atFirstReply.total']);
  const fiveMcp = [...healthyProcs(), proc(92, 29, 'mcp', 51, '/usr/bin/node-22 /r/fake-mcp-server.mjs --name fixsrv5')];
  assert.deepEqual(brokenIds(report({ first: fiveMcp })), ['session.processes.atEnd.mcp', 'session.processes.atEnd.total', 'session.processes.atFirstReply.mcp', 'session.processes.atFirstReply.total']);
});

test('the MCP allowance follows the fixture: 2 configured servers allow 2, so the 4-server tree breaks mcp', () => {
  const ids = brokenIds(report({ mcpServers: 2 }));
  assert.ok(ids.includes('session.processes.atFirstReply.mcp'));
  assert.ok(ids.includes('session.processes.atFirstReply.total'));
});

test('memory: 660 MB is the heavy-fixture limit (boundary), swapped-out memory counts, the limit scales per server', () => {
  const at = (mb: number, swapMB = 0): SessionBudgetReport => {
    const procs = healthyProcs();
    procs[1] = proc(29, 22, 'cli', mb - (52 + 4 * 51) - swapMB, '/x/claude', swapMB);
    return report({ first: procs });
  };
  const mem = (r: SessionBudgetReport) => judgeSessionBudget(r).verdicts.find((v) => v.id === 'session.processes.atFirstReply.memoryMB')!;
  assert.equal(mem(at(660)).ok, true);
  assert.equal(mem(at(660)).actual, 660);
  assert.equal(mem(at(661)).ok, false);
  assert.equal(mem(at(661)).limit, 'at most 660');
  // 300 MB resident + 400 MB paged out = 700 MB owned: a leak the kernel swapped away is still a leak.
  const swapped = mem(at(700, 400));
  assert.equal(swapped.ok, false);
  assert.equal(swapped.actual, 700);
  // two configured servers → 400 + 2×65 = 530
  const two = judgeSessionBudget(report({ mcpServers: 2, first: [healthyProcs()[0], healthyProcs()[1], healthyProcs()[2], healthyProcs()[3]] })).verdicts.find((v) => v.id === 'session.processes.atFirstReply.memoryMB')!;
  assert.equal(two.limit, 'at most 530');
});

test('a census that never saw the tree is VOID, not a pass (a max-budget over nothing passes vacuously)', () => {
  const r = report({ first: [] });
  const j = judgeSessionBudget(r);
  assert.equal(j.void, true);
  assert.equal(j.ok, false);
  const inst = j.verdicts.find((v) => v.id === 'instrument.processCensus.atFirstReply')!;
  assert.equal(inst.ok, false);
  // the control that makes the instrument check necessary: every process budget WAS satisfied by the empty tree
  assert.deepEqual(j.verdicts.filter((v) => v.kind === 'budget' && !v.ok && v.id.startsWith('session.processes.')), []);
});

test('a report without a census does not throw and is VOID', () => {
  const r = report();
  // @ts-expect-error — the malformed report is the point
  delete r.processes.atEnd;
  const j = judgeSessionBudget(r);
  assert.equal(j.void, true);
  assert.equal(j.verdicts.find((v) => v.id === 'instrument.processCensus.atEnd')?.ok, false);
});

test('delete: zero survivors within the bound passes; one survivor names it, with whether it was in the pre-delete tree', () => {
  const ok = judgeSessionBudget(report({ del: del() }));
  assert.equal(ok.ok, true, JSON.stringify(ok.verdicts.filter((v) => !v.ok)));
  const stubborn = healthyProcs()[5];
  const r = report({ del: del({ survivors: [stubborn], elapsedMs: null }) });
  const j = judgeSessionBudget(r);
  assert.deepEqual(j.verdicts.filter((v) => !v.ok).map((v) => v.id).sort(), ['session.delete.survivors', 'session.delete.zeroWithinMs']);
  const s = j.verdicts.find((v) => v.id === 'session.delete.survivors')!;
  assert.equal(s.actual, 1);
  assert.match(s.message, /via cli 1 process\(es\) \(mcp\)/);
  assert.match((s.tree ?? []).join('\n'), /\[74\] mcp .*fixsrv4.*from the pre-delete tree/);
  assert.equal(j.void, false);
  // a process that was NOT in the tree before is a relaunch (the #205 resurrection class)
  const relaunched = judgeSessionBudget(report({ del: del({ survivors: [proc(200, 1, 'keeper', 52, '/o/bin/keeper.js ws-sb')], elapsedMs: null }) }));
  assert.match((relaunched.verdicts.find((v) => v.id === 'session.delete.survivors')!.tree ?? []).join('\n'), /\[200\] keeper .*NEW since the delete/);
});

test('delete timing: 5000 ms is the limit (boundary); never reaching zero is a broken budget', () => {
  const t = (elapsedMs: number | null) => judgeSessionBudget(report({ del: del({ elapsedMs }) })).verdicts.find((v) => v.id === 'session.delete.zeroWithinMs')!;
  assert.equal(t(5000).ok, true);
  assert.equal(t(5001).ok, false);
  assert.equal(t(5001).actual, 5001);
  assert.equal(t(null).ok, false);
  assert.equal(t(null).actual, null);
  assert.match(t(null).message, /no such zero within 10000 ms/);
});

test('delete instruments: a delete that did not run, threw, or had no tree to remove is VOID — never a green zero', () => {
  const void_ = (d: DeleteReport) => judgeSessionBudget(report({ del: d })).void;
  assert.equal(void_(del({ treeBefore: [] })), true, 'no tree before the delete');
  assert.equal(void_(del({ treeBefore: healthyProcs().slice(0, 5) })), true, 'fewer than keeper+CLI+MCP servers');
  assert.equal(void_(del({ storeRecordGone: false })), true, 'the workspace record is still there');
  assert.equal(void_(del({ error: 'Error: boom\n  at x' })), true, 'the delete threw');
  assert.equal(void_(del()), false);
});

test('formatProcessTree nests children under their parent and tolerates orphans and self-parents', () => {
  const lines = formatProcessTree(healthyProcs());
  assert.equal(lines.length, 6);
  assert.match(lines[0], /^\[22\] keeper\s+52 MB/);
  assert.match(lines[1], /^ {2}\[29\] cli\s+275 MB/);
  assert.match(lines[2], /^ {4}\[71\] mcp\s+51 MB\s+node-22 fake-mcp-server\.mjs --name fixsrv1/);
  // an orphan whose parent is outside the set is a root; a self-parent must not loop
  const odd = formatProcessTree([proc(5, 999, 'other', 1, 'sleep 1'), proc(6, 6, 'other', 1, 'sleep 2')]);
  assert.equal(odd.length, 2);
  assert.deepEqual(formatProcessTree(undefined), []);
});

test('judgeProcsArm: a must-FAIL arm passes only on the exact shape, and every deviation says which', () => {
  const spec = PROCS_ARMS['delete-cli-skips-tree-sweep'];
  const stubborn = healthyProcs()[5];
  const good = judgeSessionBudget(report({ del: del({ survivors: [stubborn], elapsedMs: null }) }));
  assert.deepEqual(judgeProcsArm(spec, good).ok, true);
  // held: nothing survived → the must-break verdicts held
  const held = judgeSessionBudget(report({ del: del() }));
  const r1 = judgeProcsArm(spec, held);
  assert.equal(r1.ok, false);
  assert.match(r1.why, /session\.delete\.survivors held \(must break\)/);
  // wrong survivor count (the CLI + keeper died too) → not the aimed-at shape
  const many = judgeSessionBudget(report({ del: del({ survivors: healthyProcs(), elapsedMs: null }) }));
  assert.match(judgeProcsArm(spec, many).why, /session\.delete\.survivors: actual 6 != 1/);
  // the right count but the named tree lacks the stubborn server → the arm is not naming what it must
  const wrongOne = judgeSessionBudget(report({ del: del({ survivors: [healthyProcs()[0]], elapsedMs: null }) }));
  assert.match(judgeProcsArm(spec, wrongOne).why, /named tree lacks 'fixsrv4'/);
  // not specific: the arm also broke a process budget it must leave alone
  const leaky = report({ first: [...healthyProcs(), proc(91, 22, 'other', 0, 'sleep 600')], del: del({ survivors: [stubborn], elapsedMs: null }) });
  const r3 = judgeProcsArm(spec, judgeSessionBudget(leaky));
  assert.equal(r3.ok, false);
  assert.match(r3.why, /session\.processes\.atFirstReply\.other broke but must hold/);
});

test('the source-mutant anchors of the delete path each match the shipped source EXACTLY once (rot shows here, in `pnpm test`)', () => {
  for (const name of ['delete-skips-stop', 'delete-skips-tree-sweep', 'ui-skips-sdkstop']) {
    const m = (MUTANTS as Record<string, { file: string; find: RegExp }>)[name];
    const src = fs.readFileSync(new URL(`../..${m.file}`, import.meta.url), 'utf8');
    assert.equal([...src.matchAll(m.find)].length, 1, `${name}: anchor in ${m.file}`);
  }
});

test('identity(): a live pid has one, a killed-not-yet-reaped ZOMBIE has none (a dead process is not a survivor), a gone pid has none', async () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const pid = child.pid!;
  const id = identity(pid);
  assert.match(String(id), /^\d+$/, 'live process has a start-time identity');
  assert.equal(identity(pid), id, 'stable across reads');
  process.kill(pid, 'SIGKILL');
  // node reaps in its event loop; spinning synchronously keeps the child a zombie so the state is observable
  const t0 = Date.now();
  let state = '';
  while (Date.now() - t0 < 2000) {
    const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    state = st.slice(st.lastIndexOf(')') + 2, st.lastIndexOf(')') + 3);
    if (state === 'Z') break;
  }
  assert.equal(state, 'Z', 'control: the child really is a zombie at this instant');
  assert.equal(identity(pid), null, 'zombie ⇒ not a survivor');
  await new Promise((r) => child.once('exit', r));
  assert.equal(identity(pid), null, 'reaped ⇒ gone');
});

test('a HUNG delete is a budget failure naming the tree it left (returnsWithinMs), not a broken instrument', () => {
  const hung = judgeSessionBudget(report({ del: del({ returnedMs: null, hung: true, storeRecordGone: false, elapsedMs: null, dwellMs: 0, survivors: healthyProcs() }) }));
  assert.equal(hung.void, false, 'a hang is not VOID: the record staying in the store is what a hang looks like');
  assert.deepEqual(hung.verdicts.filter((v) => !v.ok).map((v) => v.id).sort(), ['session.delete.returnsWithinMs', 'session.delete.survivors', 'session.delete.zeroWithinMs']);
  const r = hung.verdicts.find((v) => v.id === 'session.delete.returnsWithinMs')!;
  assert.equal(r.actual, null);
  assert.match(r.message, /still pending after 10000 ms \(a HUNG delete, via cli\)/);
  assert.match((r.tree ?? []).join('\n'), /\[22\] keeper .*from the pre-delete tree/);
  // the delete hung but the tree is gone: returnsWithinMs alone breaks (the survivors budget cannot see a hang)
  const hungClean = judgeSessionBudget(report({ del: del({ returnedMs: null, hung: true, storeRecordGone: false }) }));
  assert.deepEqual(hungClean.verdicts.filter((v) => !v.ok).map((v) => v.id), ['session.delete.returnsWithinMs']);
  // boundary: 5000 ms to return is the limit
  const ret = (ms: number) => judgeSessionBudget(report({ del: del({ returnedMs: ms }) })).verdicts.find((v) => v.id === 'session.delete.returnsWithinMs')!;
  assert.equal(ret(5000).ok, true);
  assert.equal(ret(5001).ok, false);
  assert.equal(ret(5001).actual, 5001);
});

test('a zero must have been WATCHED for 2000 ms to count: a shorter dwell is VOID (a late relaunch would pass unseen); with survivors present it is not asked', () => {
  const dw = (dwellMs: number, survivors: ProcEntry[] = []) => judgeSessionBudget(report({ del: del({ dwellMs, survivors, elapsedMs: survivors.length ? null : 130 }) }));
  assert.equal(dw(2000).void, false);
  assert.equal(dw(1999).void, true);
  assert.equal(dw(0).void, true);
  assert.equal(dw(1999).verdicts.find((v) => v.id === 'instrument.delete.dwelled')!.ok, false);
  assert.equal(dw(0, [healthyProcs()[5]]).void, false, 'survivors present: the dwell instrument does not apply');
  assert.equal(dw(0, [healthyProcs()[5]]).verdicts.some((v) => v.id === 'instrument.delete.dwelled'), false);
});

test('a racing wake must have been fired while the session was stopping, else the wake arm races nothing (VOID)', () => {
  const wk = (sessionStoppingBeforeWake: boolean) => judgeSessionBudget(report({ del: del({ wake: { firedAtMs: 4, sessionStoppingBeforeWake, result: 'accepted', refusals: [] } }) }));
  assert.equal(wk(true).void, false);
  assert.equal(wk(false).void, true);
  assert.equal(wk(false).verdicts.find((v) => v.id === 'instrument.delete.wakeFired')!.ok, false);
  assert.equal(judgeSessionBudget(report({ del: del() })).verdicts.some((v) => v.id === 'instrument.delete.wakeFired'), false, 'no wake, no instrument');
});

// ── every PROCS_ARMS entry, pinned as literals (review F2: J20/J21 were undetectable while only one entry was exercised) ──
const S = { stubbornMcp: 1 };
const HOLD = ['session.processes.', 'session.beforeFirstReply.'];
const FIRST = 'session.processes.atFirstReply.';
const SURV6 = { id: 'session.delete.survivors', exact: 6, treeIncludes: ['keeper.js', 'claude', 'fixsrv1', 'fixsrv4'] };
const ZERO_NEVER = { id: 'session.delete.zeroWithinMs', never: true };
const EXPECTED_ARMS = {
  'delete-cli': { kind: 'session', mutant: null, expect: 'pass', teardown: 'cli', profile: S },
  'delete-ui': { kind: 'session', mutant: null, expect: 'pass', teardown: 'ui', profile: S },
  'procs-extra-child': {
    kind: 'session', mutant: 'keeper-extra-child', expect: 'fail',
    checks: [
      { id: `${FIRST}other`, exact: 1, treeIncludes: ['sleep 600', 'keeper.js'] },
      { id: `${FIRST}total`, exact: 7 },
      { id: 'session.processes.atEnd.other', exact: 1, treeIncludes: ['sleep 600'] },
      { id: 'session.processes.atEnd.total', exact: 7 },
    ],
    mustHold: [`${FIRST}keeper`, `${FIRST}cli`, `${FIRST}mcp`, `${FIRST}memoryMB`, 'session.beforeFirstReply.'],
  },
  'mem-keeper-ballast': {
    kind: 'session', mutant: 'keeper-ballast', expect: 'fail',
    checks: [
      { id: `${FIRST}memoryMB`, min: 750, treeIncludes: ['keeper.js', 'claude'] },
      { id: 'session.processes.atEnd.memoryMB', min: 750, treeIncludes: ['keeper.js'] },
    ],
    mustHold: [`${FIRST}keeper`, `${FIRST}cli`, `${FIRST}mcp`, `${FIRST}hook`, `${FIRST}other`, `${FIRST}total`, 'session.beforeFirstReply.'],
  },
  'delete-cli-skips-stop': { kind: 'session', mutant: 'delete-skips-stop', expect: 'fail', teardown: 'cli', profile: S, checks: [SURV6, ZERO_NEVER], mustHold: HOLD },
  'delete-cli-skips-tree-sweep': {
    kind: 'session', mutant: 'delete-skips-tree-sweep', expect: 'fail', teardown: 'cli', profile: S,
    checks: [{ id: 'session.delete.survivors', exact: 1, treeIncludes: ['fixsrv4', '--stubborn', 'from the pre-delete tree'] }, ZERO_NEVER], mustHold: HOLD,
  },
  'delete-cli-wake-race': { kind: 'session', mutant: null, expect: 'pass', teardown: 'cli', profile: S, deleteOpts: { wakeDuringDelete: true }, mustSeeRefusal: true },
  'delete-cli-wake-race-no-tombstone': {
    kind: 'session', mutant: 'delete-drops-launch-tombstone', expect: 'fail', teardown: 'cli', profile: S, deleteOpts: { wakeDuringDelete: true },
    checks: [{ id: 'session.delete.survivors', exact: 6, treeIncludes: ['keeper.js', 'claude', 'fixsrv4', 'NEW since the delete'] }, ZERO_NEVER], mustHold: HOLD,
  },
  'delete-cli-late-relaunch': {
    kind: 'session', mutant: 'delete-late-relaunch', expect: 'fail', teardown: 'cli', profile: S,
    checks: [{ id: 'session.delete.survivors', exact: 1, treeIncludes: ['sleep 600', 'NEW since the delete'] }, ZERO_NEVER], mustHold: HOLD,
  },
  'delete-cli-hangs': {
    kind: 'session', mutant: 'delete-hangs', expect: 'fail', teardown: 'cli', profile: S,
    checks: [{ id: 'session.delete.returnsWithinMs', never: true }, SURV6, ZERO_NEVER], mustHold: HOLD,
  },
  'delete-ui-skips-stop': { kind: 'session', mutant: 'delete-skips-stop+ui-skips-sdkstop', expect: 'fail', teardown: 'ui', profile: S, checks: [SURV6, ZERO_NEVER], mustHold: HOLD },
};

test('PROCS_ARMS is exactly this table (every constant of every arm is a pinned literal)', () => {
  assert.deepEqual(PROCS_ARMS, EXPECTED_ARMS);
});

/** The report an ideal run of each must-FAIL arm produces (what the arm is FOR): golden inputs for judgeProcsArm. */
const sleepProc = (pid: number, ppid: number) => proc(pid, ppid, 'other', 0, 'sleep 600');
const withMemory = (mb: number): ProcEntry[] => { const p = healthyProcs(); p[0] = proc(22, 1, 'keeper', mb - (275 + 4 * 51), '/usr/bin/node-22 /o/bin/keeper.js ws-sb'); return p; };
const newTree = (): ProcEntry[] => [
  proc(150, 1, 'keeper', 52, '/usr/bin/node-22 /o/bin/keeper.js ws-sb'), proc(157, 150, 'cli', 262, 'claude --output-format stream-json'),
  ...[1, 2, 3, 4].map((i) => proc(170 + i, 157, 'mcp', 50, `/usr/bin/node-22 /r/fake-mcp-server.mjs --name fixsrv${i} --tools 15${i === 4 ? ' --stubborn' : ''}`)),
];
const IDEAL: Record<string, () => SessionBudgetReport> = {
  'procs-extra-child': () => report({ first: [...healthyProcs(), sleepProc(29, 22)] }),
  'mem-keeper-ballast': () => report({ first: withMemory(820) }),
  'delete-cli-skips-stop': () => report({ del: del({ survivors: healthyProcs(), elapsedMs: null, dwellMs: 0 }) }),
  'delete-cli-skips-tree-sweep': () => report({ del: del({ survivors: [healthyProcs()[5]], elapsedMs: null, dwellMs: 0 }) }),
  'delete-cli-wake-race-no-tombstone': () => report({ del: del({ survivors: newTree(), elapsedMs: null, dwellMs: 0, wake: { firedAtMs: 4, sessionStoppingBeforeWake: true, result: 'accepted', refusals: [] } }) }),
  'delete-cli-late-relaunch': () => report({ del: del({ survivors: [sleepProc(149, 1)], elapsedMs: null, dwellMs: 2000 }) }),
  'delete-cli-hangs': () => report({ del: del({ returnedMs: null, hung: true, storeRecordGone: false, survivors: healthyProcs(), elapsedMs: null, dwellMs: 0 }) }),
  'delete-ui-skips-stop': () => report({ del: del({ via: 'ui', survivors: healthyProcs(), elapsedMs: null, dwellMs: 0 }) }),
};

test('every must-FAIL arm accepts the run it is FOR (golden), and there is a golden for every one of them', () => {
  const failing = Object.entries(PROCS_ARMS).filter(([, a]) => a.expect === 'fail').map(([n]) => n).sort();
  assert.deepEqual(Object.keys(IDEAL).sort(), failing);
  for (const n of failing) {
    const j = judgeSessionBudget(IDEAL[n]());
    assert.equal(j.void, false, `${n}: the ideal run is not VOID: ${j.verdicts.filter((v) => !v.ok && v.kind === 'instrument').map((v) => v.message).join(' | ')}`);
    const r = judgeProcsArm(PROCS_ARMS[n], j);
    assert.equal(r.ok, true, `${n}: ${r.why}`);
  }
});

test('judgeProcsArm clauses: min (boundary), never, exact, extra-broken-budget and mustHold each reject their own deviation', () => {
  const ballast = PROCS_ARMS['mem-keeper-ballast'];
  assert.equal(judgeProcsArm(ballast, judgeSessionBudget(report({ first: withMemory(750) }))).ok, true, 'min 750 holds at exactly 750');
  const under = judgeProcsArm(ballast, judgeSessionBudget(report({ first: withMemory(749) })));
  assert.equal(under.ok, false);
  assert.match(under.why, /memoryMB: actual 749 < 750/);
  // never: the delete-cli-skips-stop arm must see 'never reached zero' (null), not a slow zero
  const slow = judgeProcsArm(PROCS_ARMS['delete-cli-skips-stop'], judgeSessionBudget(report({ del: del({ survivors: healthyProcs(), elapsedMs: 6000 }) })));
  assert.equal(slow.ok, false);
  assert.match(slow.why, /session\.delete\.zeroWithinMs: expected 'never reached zero', got 6000/);
  // exact: 7 processes, not 8
  const eight = judgeProcsArm(PROCS_ARMS['procs-extra-child'], judgeSessionBudget(report({ first: [...healthyProcs(), sleepProc(29, 22), sleepProc(30, 22)] })));
  assert.equal(eight.ok, false);
  assert.match(eight.why, /atFirstReply\.total: actual 8 != 7/);
  // extra: an arm that also breaks a budget it did not aim at (the delete call took 6 s)
  const extra = judgeProcsArm(PROCS_ARMS['delete-cli-skips-tree-sweep'], judgeSessionBudget(report({ del: del({ returnedMs: 6000, survivors: [healthyProcs()[5]], elapsedMs: null, dwellMs: 0 }) })));
  assert.equal(extra.ok, false);
  assert.match(extra.why, /unexpected extra broken budgets: session\.delete\.returnsWithinMs/);
  // mustHold: the same arm also broke a process budget
  const leak = judgeProcsArm(PROCS_ARMS['delete-cli-skips-tree-sweep'], judgeSessionBudget(report({ first: [...healthyProcs(), sleepProc(91, 22)], del: del({ survivors: [healthyProcs()[5]], elapsedMs: null, dwellMs: 0 }) })));
  assert.equal(leak.ok, false);
  assert.match(leak.why, /session\.processes\.atFirstReply\.other broke but must hold/);
});

test('passArmProblems: the wake-race PASS arm proves nothing unless the launch tombstone REALLY refused the wake', () => {
  const arm = PROCS_ARMS['delete-cli-wake-race'];
  const wake = (refusals: string[]) => report({ del: del({ wake: { firedAtMs: 4, sessionStoppingBeforeWake: true, result: 'accepted', refusals } }) });
  assert.equal(passArmProblems(arm, wake(['Failed to spawn Claude Code process: workspace ws-sb was deleted — keeper start refused'])), null);
  assert.match(String(passArmProblems(arm, wake([]))), /never refused the racing wake/);
  assert.equal(passArmProblems(PROCS_ARMS['delete-cli'], report({ del: del() })), null, 'an arm without the control is not asked');
});
