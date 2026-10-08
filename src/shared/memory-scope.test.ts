import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  INNER_SHELL_PREFIX_ENV,
  MEMORY_SCOPE_UNIT_PREFIX,
  OOM_ADJ_TOOLS,
  OOM_TOOL_WRAPPER_SCRIPT,
  buildScopeLaunchArgv,
  classifyScopeMembers,
  decideMemoryCap,
  describeCapState,
  describeCommand,
  estimateOomBadness,
  formatMemKillLine,
  formatMemoryCapLine,
  inferKillRecords,
  memoryScopeUnitName,
  newScopeGen,
  parseCgroupLimit,
  parseMemoryEvents,
  parseMemoryScopeUnit,
  parseProcCgroupV2,
  sanitizeScopePrefix,
  scopeGenForWorkspace,
  wrapperPathUsable,
  snapKey,
  type MemoryCapInput,
  type ScopeMember,
  type VictimSnap,
} from './memory-scope.ts';

const GIB = 1024 ** 3;
const MB = 1024 * 1024;

// ── unit naming (FI-1 a) ─────────────────────────────────────────────────────────────────────────────────────────

test('unit name round-trips and keeps the workspace id (it contains dashes) apart from the generation', () => {
  const ws = '198c38e4-5529-4d47-b9cd-738dfb4eb971';
  const gen = newScopeGen(1791465663940);
  const unit = memoryScopeUnitName(MEMORY_SCOPE_UNIT_PREFIX, ws, gen);
  assert.equal(unit, `orchestra-ws-${ws}-${gen}.scope`);
  assert.deepEqual(parseMemoryScopeUnit(MEMORY_SCOPE_UNIT_PREFIX, unit!), { wsId: ws, gen });
});

test('a workspace never matches another workspace\'s scopes ("ab" vs "ab-cd") nor another prefix', () => {
  const gen = newScopeGen(1791465663940);
  const u1 = memoryScopeUnitName('orchestra-ws-', 'ab', gen)!;
  const u2 = memoryScopeUnitName('orchestra-ws-', 'ab-cd', gen)!;
  assert.equal(scopeGenForWorkspace('orchestra-ws-', 'ab', u1), gen);
  assert.equal(scopeGenForWorkspace('orchestra-ws-', 'ab', u2), null, 'ws "ab" must not claim the scope of ws "ab-cd"');
  assert.equal(scopeGenForWorkspace('orchestra-ws-', 'ab-cd', u2), gen);
  assert.equal(scopeGenForWorkspace('orchestra-rig-wh-', 'ab', u1), null, 'a rig prefix never matches a production unit');
});

test('unit names refuse what cannot be one: a ws id with a slash/space, a generation that is not base36', () => {
  assert.equal(memoryScopeUnitName('orchestra-ws-', 'a/b', 'abcdef'), null);
  assert.equal(memoryScopeUnitName('orchestra-ws-', 'a b', 'abcdef'), null);
  assert.equal(memoryScopeUnitName('orchestra-ws-', 'ws', 'AB'), null);
  assert.equal(parseMemoryScopeUnit('orchestra-ws-', 'orchestra-ws-ws-abc.scope'), null, 'generation too short');
  assert.equal(parseMemoryScopeUnit('orchestra-ws-', 'orchestra-ws-ws-abcdef.service'), null);
});

test('sanitizeScopePrefix: only a short dash-terminated token; anything else is the production prefix', () => {
  assert.equal(sanitizeScopePrefix('orchestra-rig-wh-'), 'orchestra-rig-wh-');
  for (const bad of [undefined, null, '', 'noterminator', 'a b-', '../x-', 'x'.repeat(80) + '-']) assert.equal(sanitizeScopePrefix(bad as string | undefined), MEMORY_SCOPE_UNIT_PREFIX);
});

// ── the decision: two separate clauses ───────────────────────────────────────────────────────────────────────────

const base: MemoryCapInput = { switchOn: true, hasCoordinator: true, remote: false, platform: 'linux', supported: true, softGb: 3, hardGb: 6 };

test('decideMemoryCap: a fleet member with the switch ON gets a scope AND limits (hard = MemoryMax, swap 0)', () => {
  const d = decideMemoryCap(base);
  assert.equal(d.createScope, true);
  assert.equal(d.reason, 'ok');
  assert.deepEqual(d.limits, { hardBytes: 6 * GIB, softBytes: 3 * GIB, swapMaxBytes: 0 });
});

test('decideMemoryCap: switch OFF = no scope, no limits (clause 1 and clause 2 both off)', () => {
  const d = decideMemoryCap({ ...base, switchOn: false });
  assert.deepEqual(d, { createScope: false, limits: null, reason: 'switch-off' });
});

test('decideMemoryCap: a human (top-level, no coordinator) is never capped — even with the switch ON', () => {
  assert.deepEqual(decideMemoryCap({ ...base, hasCoordinator: false }), { createScope: false, limits: null, reason: 'human' });
});

test('decideMemoryCap: sandbox, non-Linux and unsupported hosts get nothing ("not tracked")', () => {
  assert.equal(decideMemoryCap({ ...base, remote: true }).reason, 'remote');
  assert.equal(decideMemoryCap({ ...base, platform: 'darwin' }).reason, 'platform');
  assert.equal(decideMemoryCap({ ...base, platform: 'win32' }).createScope, false);
  assert.equal(decideMemoryCap({ ...base, supported: false }).reason, 'unsupported');
  for (const d of [{ ...base, remote: true }, { ...base, platform: 'darwin' }, { ...base, supported: false }]) assert.equal(decideMemoryCap(d).limits, null);
});

test('decideMemoryCap: a soft level that is not below the hard one is dropped, never applied as a bigger limit', () => {
  assert.equal(decideMemoryCap({ ...base, softGb: 8, hardGb: 6 }).limits?.softBytes, null);
  assert.equal(decideMemoryCap({ ...base, softGb: 0, hardGb: 6 }).limits?.softBytes, null);
  assert.equal(decideMemoryCap({ ...base, hardGb: 0 }).reason, 'bad-levels');
  assert.equal(decideMemoryCap({ ...base, hardGb: Number.NaN }).createScope, false);
});

// ── the launch argv (the production flags) ───────────────────────────────────────────────────────────────────────

test('buildScopeLaunchArgv: new scope, OOMPolicy=continue, MemoryMax=hard, MemorySwapMax=0 — and and NEVER a MemoryHigh (ledger D-Q2)', () => {
  const unit = 'orchestra-ws-ws1-abcdef.scope';
  const { cmd, args } = buildScopeLaunchArgv({ unit, limits: { hardBytes: 6 * GIB, softBytes: 3 * GIB, swapMaxBytes: 0 }, cmd: '/usr/bin/node', args: ['keeper.js', 'ws1'] });
  assert.equal(cmd, 'systemd-run');
  const props = args.flatMap((a, i) => (args[i - 1] === '-p' ? [a] : []));
  assert.deepEqual(props, ['OOMPolicy=continue', `MemoryMax=${6 * GIB}`, 'MemorySwapMax=0']);
  assert.ok(!args.some((a) => a.includes('MemoryHigh')), 'the soft level is a warning level: never a kernel MemoryHigh (it would crawl a runaway forever instead of killing it)');
  assert.deepEqual(args.slice(0, 5), ['--user', '--scope', '--collect', '--quiet', `--unit=${unit}`]);
  assert.deepEqual(args.slice(args.indexOf('--')), ['--', '/usr/bin/node', 'keeper.js', 'ws1'], 'the command follows `--`: it is the scope\'s main process, never an existing one');
});

test('buildScopeLaunchArgv: clause 1 without clause 2 = a scope with no limits (only OOMPolicy)', () => {
  const { args } = buildScopeLaunchArgv({ unit: 'u.scope', limits: null, cmd: 'node', args: [] });
  assert.deepEqual(args.flatMap((a, i) => (args[i - 1] === '-p' ? [a] : [])), ['OOMPolicy=continue']);
});

// ── parsing what the kernel gives us ─────────────────────────────────────────────────────────────────────────────

test('parseMemoryEvents / parseCgroupLimit / parseProcCgroupV2', () => {
  assert.deepEqual(parseMemoryEvents('low 0\nhigh 3\nmax 37\noom 1\noom_kill 1\noom_group_kill 0\nsock_throttled 0\n'), { high: 3, max: 37, oom: 1, oomKill: 1, oomGroupKill: 0 });
  assert.equal(parseMemoryEvents(''), null, 'an empty read is not "all zero"');
  assert.equal(parseMemoryEvents('high 1\n'), null, 'no oom_kill counter = unreadable');
  assert.equal(parseCgroupLimit('209715200\n'), 209715200);
  assert.equal(parseCgroupLimit('max\n'), null);
  assert.equal(parseProcCgroupV2('0::/user.slice/user-1000.slice/user@1000.service/app.slice/x.scope\n'), '/user.slice/user-1000.slice/user@1000.service/app.slice/x.scope');
  assert.equal(parseProcCgroupV2('12:memory:/foo\n'), null, 'cgroup v1 only');
});

// ── session vs Reliquats (FI-1 c) ────────────────────────────────────────────────────────────────────────────────

const m = (pid: number, ppid: number, comm = 'x'): ScopeMember => ({ pid, startTicks: pid * 10, ppid, comm, cmdline: comm, rssBytes: 1 });

test('classifyScopeMembers: keeper / cli / session by ancestry; a reparented daemon is a Reliquat', () => {
  const members = [m(100, 1, 'node'), m(101, 100, 'claude'), m(102, 101, 'mcp'), m(103, 101, 'bash'), m(104, 103, 'sleep'), m(200, 1, 'chromium'), m(201, 200, 'chromium-gpu')];
  const roles = Object.fromEntries(classifyScopeMembers(members, 100, 101).map((c) => [c.pid, c.role]));
  assert.deepEqual(roles, { 100: 'keeper', 101: 'cli', 102: 'session', 103: 'session', 104: 'session', 200: 'reliquat', 201: 'reliquat' });
});

test('classifyScopeMembers: the keeper is dead ⇒ EVERY member is a Reliquat (including an orphaned CLI)', () => {
  const members = [m(101, 1, 'claude'), m(103, 101, 'bash')];
  assert.ok(classifyScopeMembers(members, null).every((c) => c.role === 'reliquat'));
  assert.ok(classifyScopeMembers(members, 100, 101).every((c) => c.role === 'reliquat'), 'a keeper pid that is not a member of the scope classifies nothing as session');
});

test('classifyScopeMembers: a pid-reuse look-alike outside the chain does not join the session; a cycle terminates', () => {
  const cyc = [m(100, 1), m(300, 301), m(301, 300)];
  const roles = Object.fromEntries(classifyScopeMembers(cyc, 100).map((c) => [c.pid, c.role]));
  assert.deepEqual(roles, { 100: 'keeper', 300: 'reliquat', 301: 'reliquat' });
});

// ── naming the killed command ────────────────────────────────────────────────────────────────────────────────────

const snap = (pid: number, comm: string, rssMb: number, adj: number, cmdline = comm): VictimSnap => ({ pid, startTicks: pid * 10, comm, cmdline, rssPages: (rssMb * MB) / 4096, adj });
const world = (...s: VictimSnap[]) => new Map(s.map((v) => [snapKey(v.pid, v.startTicks), v]));
const keys = (...s: VictimSnap[]) => new Set(s.map((v) => snapKey(v.pid, v.startTicks)));

test('estimateOomBadness: a small tool at +1000 outranks a big CLI at 0 (the protection), and at 0 the big one is the victim (the control)', () => {
  const total = (300 * MB) / 4096;
  const cli = snap(1, 'claude', 150, 0);
  assert.ok(estimateOomBadness(snap(2, 'tool', 60, OOM_ADJ_TOOLS), total) > estimateOomBadness(cli, total));
  assert.ok(estimateOomBadness(snap(2, 'tool', 60, 0), total) < estimateOomBadness(cli, total));
  assert.equal(estimateOomBadness(snap(3, 'x', 1, -1000), total), Number.NEGATIVE_INFINITY);
});

test('inferKillRecords: names the vanished process the kernel would have chosen (adj +1000 tool, not the bigger CLI that survived)', () => {
  const cli = snap(1, 'claude', 150, 0, 'claude --output-format stream-json');
  const hog = snap(2, 'python3', 400, OOM_ADJ_TOOLS, 'python3 -c big_alloc()');
  const done = snap(3, 'sleep', 0, OOM_ADJ_TOOLS, 'sleep 1');
  const recs = inferKillRecords({ before: world(cli, hog, done), aliveKeys: keys(cli), delta: { oomKill: 1, hardCredit: 1 }, maxBytes: 300 * MB, unit: 'u.scope', seqNext: 7, nowMs: 5 });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].seq, 7);
  assert.equal(recs[0].command, 'python3 -c big_alloc()');
  assert.equal(recs[0].pid, 2);
  assert.equal(recs[0].level, 'hard');
  assert.deepEqual(recs[0].candidates, ['sleep 1'], 'the other process that vanished in the window is shown, not hidden');
  assert.equal(recs[0].hardBytes, 300 * MB);
});

test('inferKillRecords: nothing vanished ⇒ the kill is still recorded, with command null (never a made-up name)', () => {
  const cli = snap(1, 'claude', 150, 0);
  const recs = inferKillRecords({ before: world(cli), aliveKeys: keys(cli), delta: { oomKill: 1, hardCredit: 1 }, maxBytes: 300 * MB, unit: 'u.scope', seqNext: 1, nowMs: 1 });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].command, null);
  assert.equal(recs[0].pid, null);
});

test('inferKillRecords: no counter movement ⇒ no record (a process that merely exited is not a kill); N kills ⇒ N records with consecutive seq', () => {
  const a = snap(2, 'a', 100, OOM_ADJ_TOOLS);
  const b = snap(3, 'b', 90, OOM_ADJ_TOOLS);
  assert.deepEqual(inferKillRecords({ before: world(a), aliveKeys: keys(), delta: { oomKill: 0, hardCredit: 0 }, maxBytes: 1, unit: 'u', seqNext: 1, nowMs: 1 }), []);
  const two = inferKillRecords({ before: world(a, b), aliveKeys: keys(), delta: { oomKill: 2, hardCredit: 1 }, maxBytes: 300 * MB, unit: 'u', seqNext: 4, nowMs: 1 });
  assert.deepEqual(two.map((r) => [r.seq, r.command]), [[4, 'a'], [5, 'b']]);
  assert.deepEqual(two.map((r) => r.level), ['hard', 'external'], 'two kills, one unit of hard credit: the credit is spent per kill, never smeared over all of them');
});

test('inferKillRecords: an OOM kill that did not come from the scope\'s own limit is labelled external, not hard', () => {
  const a = snap(2, 'a', 100, OOM_ADJ_TOOLS);
  assert.equal(inferKillRecords({ before: world(a), aliveKeys: keys(), delta: { oomKill: 1, hardCredit: 0 }, maxBytes: 300 * MB, unit: 'u', seqNext: 1, nowMs: 1 })[0].level, 'external');
});

test('a pid reused after the kill does not hide the victim (identity is pid + start time)', () => {
  const victim = snap(2, 'python3', 400, OOM_ADJ_TOOLS);
  const reused = { ...snap(2, 'bash', 1, 0), startTicks: 99999 };
  const recs = inferKillRecords({ before: world(victim), aliveKeys: keys(reused), delta: { oomKill: 1, hardCredit: 1 }, maxBytes: 300 * MB, unit: 'u', seqNext: 1, nowMs: 1 });
  assert.equal(recs[0].command, 'python3');
});

test('describeCommand truncates and collapses whitespace; falls back to comm', () => {
  assert.equal(describeCommand('a   b\n c', 'x'), 'a b c');
  assert.equal(describeCommand('', 'comm'), 'comm');
  assert.equal(describeCommand('y'.repeat(300), 'x', 50).length, 50);
});

test('formatMemKillLine: workspace, killed command, level', () => {
  const line = formatMemKillLine('ws-1', { seq: 1, at: 1, level: 'hard', command: 'python3 hog.py', pid: 42, rssBytes: 300 * MB, candidates: [], unit: 'orchestra-ws-ws-1-abcdef.scope', hardBytes: 6 * GIB });
  assert.match(line, /^memory-cap\[ws-1\] killed "python3 hog\.py" \(pid 42, ~300 MB\) at the hard level \(6\.00 GB\) — scope orchestra-ws-ws-1-abcdef\.scope — at 1970-01-01T00:00:00\.001Z$/);
  assert.match(formatMemKillLine('w', { seq: 1, at: 1, level: 'external', command: null, pid: null, rssBytes: null, candidates: [], unit: 'u', hardBytes: null }), /unnamed process.*outside the scope limit/);
});

// ── bus-status line ──────────────────────────────────────────────────────────────────────────────────────────────

test('formatMemoryCapLine: ON shows the levels and that it applies at the next session start; OFF and no-run say so', () => {
  const v = { switchOn: true, softBytes: 3 * GIB, hardBytes: 6 * GIB, scopes: 2, supported: true };
  assert.match(formatMemoryCapLine(v), /^memory cap: ON for this run \(frozen\) — hard 6\.0 GB \(kernel kill, no swap\) · soft 3\.0 GB \(warning level, no kernel throttle\); read at each member's next session start.* · 2 member scope\(s\) live$/);
  assert.match(formatMemoryCapLine({ ...v, switchOn: false }), /^memory cap: OFF for this run \(frozen\) — no member scope/);
  assert.match(formatMemoryCapLine({ ...v, switchOn: null }), /^memory cap: no run — nothing frozen/);
  assert.match(formatMemoryCapLine({ ...v, supported: false, unsupportedReason: 'no systemd-run' }), /NOT TRACKED on this host \(no systemd-run\)/);
});

// ── the wrapper script (victim protection), executed for real ────────────────────────────────────────────────────

test('the tool wrapper: raises ONLY its own tree to +1000, hands the single command string to the user shell, keeps exit status and stdout', { skip: process.platform !== 'linux' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcap-wrap-'));
  const callerAdjForRestore = fs.readFileSync('/proc/self/oom_score_adj', 'utf8').trim();
  try {
    const w = path.join(dir, 'w.sh');
    fs.writeFileSync(w, OOM_TOOL_WRAPPER_SCRIPT, { mode: 0o755 });
    execFileSync('sh', ['-n', w]); // syntax
    // This test must not depend on WHO runs it: a Bash tool command of a capped member is itself at +1000 (and children inherit it). An unprivileged process may lower
    // itself back to 0 (its floor), so the baseline is made 0 here and restored after — otherwise "the tool runs at 1000" would pass vacuously inside a capped member.
    try { fs.writeFileSync('/proc/self/oom_score_adj', '0'); } catch { /* floor above 0 (a privileged parent set it): the assertions below then use the real baseline */ }
    const baseline = fs.readFileSync('/proc/self/oom_score_adj', 'utf8').trim();
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', SHELL: '/bin/bash' };
    const out = execFileSync(w, ['cat /proc/self/oom_score_adj; echo "$0 ok"'], { env, encoding: 'utf8' });
    assert.equal(out.split('\n')[0], String(OOM_ADJ_TOOLS), 'the command (and everything under it) runs at +1000');
    assert.match(out, /bash ok/);
    // exit status passes through exec
    assert.throws(() => execFileSync(w, ['exit 7'], { env }), (e: { status?: number }) => e.status === 7);
    // a non-bash/zsh SHELL (fish…) falls back to bash instead of failing the command
    assert.match(execFileSync(w, ['echo fine'], { env: { ...env, SHELL: '/usr/bin/fish' }, encoding: 'utf8' }), /fine/);
    // our own adj stays at 0: the wrapper changed only the process it exec'd into
    assert.equal(fs.readFileSync('/proc/self/oom_score_adj', 'utf8').trim(), baseline, 'the wrapper raised only the process it exec\'d into, not its caller');
    assert.notEqual(baseline, String(OOM_ADJ_TOOLS), 'precondition: the baseline is not already 1000, else the raise proves nothing');
    // the user's own prefix is chained exactly as the CLI would have called it
    const inner = path.join(dir, 'inner.sh');
    fs.writeFileSync(inner, '#!/bin/sh\necho "inner got: $1"\n', { mode: 0o755 });
    assert.match(execFileSync(w, ['echo hi'], { env: { ...env, [INNER_SHELL_PREFIX_ENV]: inner }, encoding: 'utf8' }), /inner got: echo hi/);
  } finally {
    try { fs.writeFileSync('/proc/self/oom_score_adj', callerAdjForRestore); } catch { /* cannot raise back: harmless for a test process */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wrapperPathUsable: only an absolute path without whitespace can be CLAUDE_CODE_SHELL_PREFIX (the CLI splits it at spaces)', () => {
  assert.equal(wrapperPathUsable('/home/lmas/.orchestra/bin/oom-tool-wrapper.sh'), true);
  for (const bad of ['/home/my user/.orchestra/bin/w.sh', 'bin/w.sh', '', undefined, null, '/tmp/a\tb']) assert.equal(wrapperPathUsable(bad as string | undefined), false, String(bad));
});

test('describeCapState: only `active` is info; unprotected / not-applied / no-scope / unknown say what the member is left with', () => {
  assert.equal(describeCapState('active', 'u.scope', 6 * GIB).level, 'info');
  for (const st of ['unprotected', 'not-applied', 'no-scope', undefined] as const) assert.equal(describeCapState(st, 'u.scope', 6 * GIB).level, 'warn', String(st));
  assert.match(describeCapState('unprotected', 'u.scope', 6 * GIB).text, /kill the CLI/);
  assert.match(describeCapState('not-applied', 'u.scope', 6 * GIB).text, /UNCAPPED/);
  assert.match(describeCapState(undefined, 'u.scope', 6 * GIB).text, /UNVERIFIED/);
});

test('formatMemoryCapLine counts scopes that are NOT a cap (no limit applied)', () => {
  const v = { switchOn: true, softBytes: 3 * GIB, hardBytes: 6 * GIB, scopes: 4, unlimited: 1, supported: true };
  assert.match(formatMemoryCapLine(v), /4 member scope\(s\) live, 1 WITHOUT a limit applied$/);
  assert.match(formatMemoryCapLine({ ...v, unlimited: 0 }), /4 member scope\(s\) live$/);
});
