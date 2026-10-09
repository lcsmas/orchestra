import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  INNER_SHELL_PREFIX_ENV,
  MEMORY_SCOPE_UNIT_PREFIX,
  OOM_ADJ_TOOLS,
  OOM_TOOL_WRAPPER_SCRIPT,
  buildScopeLaunchArgv,
  KEEPER_LEAF_RESERVE_BYTES,
  MEMCAP_RESERVE_ENV,
  WORK_LEAF_ENV,
  reserveBytesFromEnv,
  SCOPE_LEAF_KEEPER,
  SCOPE_LEAF_WORK,
  scopeMemoryMaxBytes,
  scopePathOfCgroup,
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
  swapLimitApplied,
  wrapperPathUsable,
  snapKey,
  type MemoryCapInput,
  type ScopeMember,
  type VictimSnap,
  launcherExecedKeeper,
  parseKernelOomMessage,
  planKernelPairing,
  parseMemoryStat,
  workingSetBytes,
  kernelKillsForUnit,
  applyKernelKills,
  memNoticeText,
  memBusBody,
  isSoftRecord,
  formatMemSoftLine,
  type MemKillRecord,
  type MemSoftRecord,
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

test('buildScopeLaunchArgv: new DELEGATED scope, OOMPolicy=continue, MemoryMax=hard+keeper-leaf reserve (the work leaf carries the hard level), MemorySwapMax=0 — and NEVER a MemoryHigh (ledger D-Q2)', () => {
  const unit = 'orchestra-ws-ws1-abcdef.scope';
  const { cmd, args } = buildScopeLaunchArgv({ unit, limits: { hardBytes: 6 * GIB, softBytes: 3 * GIB, swapMaxBytes: 0 }, cmd: '/usr/bin/node', args: ['keeper.js', 'ws1'] });
  assert.equal(cmd, 'systemd-run');
  const props = args.flatMap((a, i) => (args[i - 1] === '-p' ? [a] : []));
  assert.deepEqual(props, ['OOMPolicy=continue', 'Delegate=yes', `MemoryMax=${6 * GIB + KEEPER_LEAF_RESERVE_BYTES}`, 'MemorySwapMax=0']);
  assert.ok(!args.some((a) => a.includes('MemoryHigh')), 'the soft level is a warning level: never a kernel MemoryHigh (it would crawl a runaway forever instead of killing it)');
  assert.deepEqual(args.slice(0, 5), ['--user', '--scope', '--collect', '--quiet', `--unit=${unit}`]);
  assert.deepEqual(args.slice(args.indexOf('--')), ['--', '/usr/bin/node', 'keeper.js', 'ws1'], 'the command follows `--`: it is the scope\'s main process, never an existing one');
});

test('#332 leaves: the scope\'s limit is the hard level + a reserve (the work leaf must trip first); a leaf path maps back to its scope; only the two leaf names are leaves', () => {
  assert.equal(scopeMemoryMaxBytes(6 * GIB), 6 * GIB + KEEPER_LEAF_RESERVE_BYTES);
  assert.ok(KEEPER_LEAF_RESERVE_BYTES >= 512 * 1024 * 1024, 'room for the keeper + the real CLI (≈330 MB) + its MCP servers: a smaller backstop would trip BEFORE the work leaf and take the session');
  assert.equal(scopeMemoryMaxBytes(6 * GIB, 0), null, 'reserve 0 = no scope-level limit (rigs ≤ 300 MB)');
  assert.equal(scopeMemoryMaxBytes(6 * GIB, 100), 6 * GIB + 100);
  const env = (v?: string) => ({ [MEMCAP_RESERVE_ENV]: v });
  assert.equal(reserveBytesFromEnv(env()), KEEPER_LEAF_RESERVE_BYTES);
  assert.equal(reserveBytesFromEnv(env('0')), 0);
  assert.equal(reserveBytesFromEnv(env(' 47185920 ')), 47185920);
  for (const bad of ['-1', '1.5', 'abc', '', '9'.repeat(30)]) assert.equal(reserveBytesFromEnv(env(bad)), KEEPER_LEAF_RESERVE_BYTES, `ignored: ${JSON.stringify(bad)}`);
  const noBackstop = buildScopeLaunchArgv({ unit: 'u.scope', limits: { hardBytes: GIB, softBytes: null, swapMaxBytes: 0 }, cmd: 'node', args: [], reserveBytes: 0 });
  assert.deepEqual(noBackstop.args.flatMap((a, i) => (noBackstop.args[i - 1] === '-p' ? [a] : [])), ['OOMPolicy=continue', 'Delegate=yes', 'MemorySwapMax=0'], 'reserve 0: delegated, swap closed, no scope-level MemoryMax');
  const scope = '/user.slice/user-1000.slice/user@1000.service/app.slice/orchestra-ws-w1-abc.scope';
  assert.equal(scopePathOfCgroup(scope), scope);
  assert.equal(scopePathOfCgroup(`${scope}/${SCOPE_LEAF_KEEPER}`), scope);
  assert.equal(scopePathOfCgroup(`${scope}/${SCOPE_LEAF_WORK}`), scope);
  assert.equal(scopePathOfCgroup(`${scope}/other`), `${scope}/other`, 'a directory that is not one of our leaves is not mapped');
  assert.equal(scopePathOfCgroup('/'), '/');
});

test('#332 kernelKillsForUnit: a kill whose victim lived in the work leaf (`<unit>/w`) belongs to the unit; a victim in the KEEPER leaf (a scope-level backstop episode, not in the work leaf\'s counter) and another unit\'s leaf do not', () => {
  const mk = (memcg: string, pid: number) => ({ atMs: 1000, pid, comm: 'python3', oomMemcg: memcg, taskMemcg: memcg });
  const u = 'orchestra-ws-w1-abc.scope';
  const lines = [mk(`/a/b/${u}/w`, 1), mk(`/a/b/${u}`, 2), mk('/a/b/orchestra-ws-w2-abc.scope/w', 3), mk(`/a/b/${u}/k`, 4), mk(`/a/b/x${u}/w`, 5)];
  assert.deepEqual(kernelKillsForUnit(lines, u, 0).map((l) => l.pid), [1, 2]);
  // the victim's memcg decides: an episode opened at the scope but whose victim sat in the work leaf IS a work-leaf kill
  assert.deepEqual(kernelKillsForUnit([{ atMs: 1000, pid: 9, comm: 'python3', oomMemcg: `/a/b/${u}`, taskMemcg: `/a/b/${u}/w` }], u, 0).map((l) => l.pid), [9]);
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
    // other than ONE argument (a CLI version with another calling convention) the wrapper stays out of the way: it raises and runs argv as given
    assert.equal(execFileSync(w, ['printf', '%s', 'two-args'], { env, encoding: 'utf8' }), 'two-args', 'review m: the arity guard — argv ≠ 1 is exec\'d as is, never fed to the user shell as a command string');
    // a non-bash/zsh SHELL (fish…) falls back to bash instead of failing the command
    assert.match(execFileSync(w, ['echo fine'], { env: { ...env, SHELL: '/usr/bin/fish' }, encoding: 'utf8' }), /fine/);
    // #332: a capped member's tool shell moves ITSELF into the work leaf named by the env (a plain file here; the cgroup.procs of the real leaf in the rig) — and ONLY then
    const leafDir = path.join(dir, 'leaf');
    fs.mkdirSync(leafDir);
    const r = spawnSync(w, ['echo moved'], { env: { ...env, [WORK_LEAF_ENV]: leafDir }, encoding: 'utf8' });
    assert.equal(r.stdout.trim(), 'moved');
    assert.equal(fs.readFileSync(path.join(leafDir, 'cgroup.procs'), 'utf8').trim(), String(r.pid), 'the wrapper wrote ITS OWN pid (the shell it became) into the work leaf');
    const none = spawnSync(w, ['echo plain'], { env, encoding: 'utf8' });
    assert.equal(none.stdout.trim(), 'plain');
    assert.equal(fs.readdirSync(leafDir).length, 1, 'no WORK_LEAF env (an uncapped / pre-#332 keeper) ⇒ the wrapper moves nothing');
    const broken = spawnSync(w, ['echo still-runs'], { env: { ...env, [WORK_LEAF_ENV]: path.join(dir, 'no-such-leaf') }, encoding: 'utf8' });
    assert.equal(broken.stdout.trim(), 'still-runs', 'a leaf that cannot be entered never stops the tool (it stays at adj 1000 under the scope backstop)');
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

test('review m4 — swapLimitApplied: the swap escape is closed only by memory.swap.max = 0; no file is acceptable ONLY on a host with no swap', () => {
  assert.equal(swapLimitApplied('0\n', 8_000_000), true);
  assert.equal(swapLimitApplied('max\n', 8_000_000), false, 'swap allowed ⇒ MemoryMax never kills (zram)');
  assert.equal(swapLimitApplied('1048576\n', 8_000_000), false, 'a non-zero swap limit still lets a hog park');
  assert.equal(swapLimitApplied(null, 8_000_000), false, 'no swap accounting + swap present ⇒ the hog parks and is never killed: NOT a cap');
  assert.equal(swapLimitApplied(null, 0), true, 'no swap at all ⇒ nothing to escape into');
  assert.equal(swapLimitApplied(null, null), false, 'unknown swap size is not "no swap"');
});

test('FI-1 v1.9 — classifyScopeMembers with a host-wide parentOf: a member whose parent LEFT the set is still the session\'s; without it (the 1981ec9e behaviour) it reads as a Reliquat', () => {
  const members = [m(100, 1, 'node'), m(101, 100, 'claude'), m(104, 103, 'chromium-helper')]; // 103 (the browser main) is in another scope, parent 102 -> 101
  const host = new Map<number, number>([[103, 102], [102, 101], [101, 100], [100, 1], [104, 103]]);
  const roles = (parentOf?: (pid: number) => number | null) => Object.fromEntries(classifyScopeMembers(members, 100, 101, parentOf).map((c) => [c.pid, c.role]));
  assert.deepEqual(roles((pid) => host.get(pid) ?? null), { 100: 'keeper', 101: 'cli', 104: 'session' });
  assert.deepEqual(roles(), { 100: 'keeper', 101: 'cli', 104: 'reliquat' }, 'control: in-set-only chains cannot cross the boundary');
  assert.deepEqual(Object.fromEntries(classifyScopeMembers([m(100, 1), m(300, 301)], 100, null, (pid) => (pid === 300 ? 301 : pid === 301 ? 300 : null)).map((c) => [c.pid, c.role])), { 100: 'keeper', 300: 'reliquat' }, 'a cycle in the host chain terminates');
});

test('launcherExecedKeeper (pre-review m6): systemd-run exec\'d INTO the keeper is a slow keeper, a launcher still being systemd-run is hung', () => {
  const script = '/home/u/.orchestra/bin/keeper.js';
  const ws = '198c38e4-5529-4d47-b9cd-738dfb4eb971';
  const raw = (...a: string[]) => a.join('\0') + '\0';
  assert.equal(launcherExecedKeeper(raw('/usr/bin/node', script, ws, '/run/s.sock', '/run/s.pid', '/run/s.log'), script, ws), true, 'the exec happened: the process IS the keeper');
  assert.equal(launcherExecedKeeper(raw('systemd-run', '--user', '--scope', '--unit=u', '--', '/usr/bin/node', script, ws), script, ws), false, 'still the launcher (its argv merely CONTAINS the keeper command, after `--`): hung, killable');
  assert.equal(launcherExecedKeeper(raw('/usr/bin/node', script, 'another-ws'), script, ws), false, 'another workspace\'s keeper is not ours');
  assert.equal(launcherExecedKeeper('', script, ws), false, 'gone / unreadable');
  assert.equal(launcherExecedKeeper(raw('sleep', '300'), script, ws), false, 'the rig\'s hung stub');
});

test('classifyScopeMembers (review F1): a member that EXITS between the snapshot and the walk stays «session» — the host resolver is asked only about pids OUTSIDE the member set', () => {
  const mk = (pid: number, ppid: number): ScopeMember => ({ pid, ppid, startTicks: pid * 10, comm: `p${pid}`, cmdline: `p${pid}`, rssBytes: 1000 });
  const members = [mk(10, 1), mk(11, 10), mk(12, 11), mk(13, 99)]; // keeper, cli, a tool, a browser helper whose parent 99 (the browser main) lives in ANOTHER scope
  const gone = new Set([10, 11, 12, 13]); // every member has exited by the time the walk reads /proc
  const asked: number[] = [];
  const parentOf = (pid: number): number | null => {
    asked.push(pid);
    if (gone.has(pid)) return null; // /proc/<pid>/stat is gone
    return pid === 99 ? 12 : null; // the browser main's parent is the tool
  };
  const roles = Object.fromEntries(classifyScopeMembers(members, 10, 11, parentOf).map((m) => [m.pid, m.role]));
  assert.deepEqual(roles, { 10: 'keeper', 11: 'cli', 12: 'session', 13: 'session' }, 'snapshot ppids carry the walk; only 99 (outside the set) goes to the resolver');
  assert.deepEqual([...new Set(asked)], [99], 'no member pid was re-read from the host');
  const orphan = classifyScopeMembers([mk(10, 1), mk(14, 1)], 10, null, () => null).find((m) => m.pid === 14);
  assert.equal(orphan?.role, 'reliquat', 'control: a member whose snapshot ppid is init is still a Reliquat');
});

// ─── #322: the kernel names its victim; the words of the notice and the bus message ─────────────────────────────────

const REAL_OOM_LINE = 'oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=user.slice,mems_allowed=0,oom_memcg=/user.slice/user-1000.slice/user@1000.service/app.slice/orchestra-rig-wh-h1-mcabcckill-muzvubbk.scope,task_memcg=/user.slice/user-1000.slice/user@1000.service/app.slice/orchestra-rig-wh-h1-mcabcckill-muzvubbk.scope,task=python3,pid=2413311,uid=1000'; // captured from `journalctl -k` on this host

test('#322 m2: a REAL kernel oom-kill line is parsed (cgroup, comm, pid); other kernel lines and global OOMs are not', () => {
  const k = parseKernelOomMessage(REAL_OOM_LINE, 1000);
  assert.deepEqual(k && { pid: k.pid, comm: k.comm, atMs: k.atMs }, { pid: 2413311, comm: 'python3', atMs: 1000 });
  assert.match(k?.oomMemcg ?? '', /orchestra-rig-wh-h1-mcabcckill-muzvubbk\.scope$/);
  assert.equal(parseKernelOomMessage('Memory cgroup out of memory: Killed process 5 (x) total-vm:1kB', 1), null, 'only the structured oom-kill: line');
  assert.equal(parseKernelOomMessage(REAL_OOM_LINE.replace('CONSTRAINT_MEMCG', 'CONSTRAINT_NONE'), 1), null, 'a GLOBAL oom is not a scope kill');
  assert.equal(parseKernelOomMessage('oom-kill:constraint=CONSTRAINT_MEMCG,garbage', 1), null);
  const odd = parseKernelOomMessage(REAL_OOM_LINE.replace('task=python3', 'task=my,prog'), 1);
  assert.equal(odd?.comm, 'my,prog', 'a comm with a comma survives');
});

test('#322 m2: only THIS scope\'s kills inside the window, oldest first — a neighbour scope\'s kill is never ours', () => {
  const mine = parseKernelOomMessage(REAL_OOM_LINE, 5000)!;
  const mine2 = { ...mine, pid: 7, atMs: 4000 };
  const other = parseKernelOomMessage(REAL_OOM_LINE.replaceAll('mcabcckill-muzvubbk', 'someone-else-aaaa'), 5000)!;
  const old = { ...mine, pid: 9, atMs: 10 };
  const got = kernelKillsForUnit([mine, other, old, mine2], 'orchestra-rig-wh-h1-mcabcckill-muzvubbk.scope', 3000);
  assert.deepEqual(got.map((g) => g.pid), [7, 2413311], 'mine, in window, oldest first');
});

const rec = (over: Partial<MemKillRecord> = {}): MemKillRecord => ({ kind: 'kill', source: 'inferred', seq: 1, at: 1, level: 'hard', command: 'bigbuild --all', pid: 100, rssBytes: 90 * 1024 * 1024, candidates: ['other'], unit: 'u.scope', hardBytes: 6 * 1024 ** 3, ...over });

test('#322 m2: applyKernelKills — the kernel\'s pid/comm replace the inference; the larger command that exited normally stops being the answer', () => {
  const snaps = [{ pid: 100, comm: 'bigbuild', cmdline: 'bigbuild --all', rssPages: 20000 }]; // exited NORMALLY, bigger than the victim
  const victim = parseKernelOomMessage(REAL_OOM_LINE, 1)!; // pid 2413311 python3, never snapshotted
  const [r] = applyKernelKills([rec()], [victim], snaps, 4096);
  assert.equal(r.source, 'kernel');
  assert.equal(r.pid, 2413311);
  assert.equal(r.command, 'python3', 'unsnapshotted victim: the kernel\'s comm, not a made-up name');
  assert.deepEqual(r.candidates, [], 'the others exited on their own');
  const seen = applyKernelKills([rec()], [{ ...victim, pid: 100, comm: 'bigbuild' }], snaps, 4096)[0];
  assert.equal(seen.command, 'bigbuild --all', 'a snapshotted victim keeps its full command line and rss');
  assert.equal(seen.rssBytes, 20000 * 4096);
  const none = applyKernelKills([rec(), rec({ seq: 2 })], [victim], snaps, 4096);
  assert.deepEqual(none.map((x) => x.source), ['kernel', 'inferred'], 'a record with no kernel line keeps its inference, labelled so');
  assert.equal(none[1].command, 'bigbuild --all');
});

test('#322: the member row, the coordinator message and the soft line say workspace / command / level — and say «probably» when only inferred', () => {
  assert.equal(memNoticeText(rec({ source: 'kernel', command: 'python3 swarm.py 8' })), 'Command python3 swarm.py 8 killed: Plafond mémoire 6 GB reached');
  assert.equal(memNoticeText(rec({ command: 'python3 swarm.py' })), 'A command (probably python3 swarm.py) killed: Plafond mémoire 6 GB reached');
  assert.equal(memNoticeText(rec({ command: null })), 'A command was killed: Plafond mémoire 6 GB reached (it lived too briefly to be named)');
  assert.match(memNoticeText(rec({ source: 'kernel', level: 'external', hardBytes: null })), /killed by the system under memory pressure \(not by the Plafond mémoire\)/);
  assert.equal(memNoticeText(rec({ source: 'kernel', command: 'x'.repeat(300) })).includes('x'.repeat(200)), false, 'a huge command line is clipped');
  const soft: MemSoftRecord = { kind: 'soft', seq: 3, at: 5, unit: 'u.scope', bytes: Math.round(3.1 * 1024 ** 3), softBytes: 3 * 1024 ** 3, hardBytes: 6 * 1024 ** 3 };
  assert.ok(isSoftRecord(soft) && !isSoftRecord(rec()));
  assert.equal(memNoticeText(soft), 'Working set 3.1 GB (reclaimable cache excluded) — Plafond mémoire warning level (3 GB) crossed; hard cap 6 GB');
  const body = memBusBody('feat-x', rec({ source: 'kernel', command: 'cargo build', pid: 42 }));
  assert.match(body, /workspace feat-x/);
  assert.match(body, /command `cargo build` \(pid 42, ~90 MB\)/);
  assert.match(body, /hard level \(6 GB\)/);
  assert.match(memBusBody('feat-x', soft), /Nothing was killed or slowed/);
  assert.match(formatMemSoftLine('feat-x', soft), /^memory-cap\[feat-x\] warning level crossed: working set 3\.10 GB >= 3\.00 GB — scope u\.scope/);
});

test('#322: inferKillRecords labels what it makes `inferred` (the kill kind is explicit)', () => {
  const before = new Map([['1:7', { pid: 1, startTicks: 7, comm: 'hog', cmdline: 'hog', rssPages: 10, adj: 1000 }]]);
  const [r] = inferKillRecords({ before, aliveKeys: new Set(), delta: { oomKill: 1, hardCredit: 1 }, maxBytes: 1 << 28, unit: 'u.scope', seqNext: 1, nowMs: 1 });
  assert.equal(r.kind, 'kill');
  assert.equal(r.source, 'inferred');
});

test('#322 R5: the working set = memory.current − inactive_file (never negative; the raw figure when memory.stat has no inactive_file)', () => {
  const stat = parseMemoryStat('anon 1000\nfile 5000\ninactive_file 3000\nactive_file 2000\nsomething_else 12\nbad line\nx 1.5\n');
  assert.deepEqual({ a: stat.anon, f: stat.inactive_file, x: stat.x }, { a: 1000, f: 3000, x: undefined });
  assert.equal(workingSetBytes(10_000, stat), 7000);
  assert.equal(workingSetBytes(2_000, stat), 0, 'a stale stat larger than the reading ⇒ 0, not negative');
  assert.equal(workingSetBytes(10_000, {}), 10_000);
});

test('#322 review F7: when the CLI (or the keeper) is the victim the text says the SESSION ENDED — never «the member\'s session survived»', () => {
  const k = (over: Partial<MemKillRecord>): MemKillRecord => ({ kind: 'kill', source: 'kernel', seq: 1, at: 1, level: 'hard', command: 'claude --output-format stream-json', pid: 7, rssBytes: 1, candidates: [], unit: 'u.scope', hardBytes: 6 * 1024 ** 3, ...over });
  assert.match(memBusBody('w', k({})), /The member's session survived\./);
  const cli = memBusBody('w', k({ role: 'cli' }));
  assert.doesNotMatch(cli, /session survived/);
  assert.match(cli, /agent process: its SESSION ENDED/);
  assert.match(memBusBody('w', k({ role: 'keeper' })), /keeper: its SESSION ENDED/);
  assert.match(memNoticeText(k({ role: 'cli' })), /the member's own agent process: the session ended$/);
  assert.doesNotMatch(memNoticeText(k({})), /session ended/);
  const soft: MemSoftRecord = { kind: 'soft', seq: 3, at: 5, unit: 'u.scope', bytes: 3 * 1024 ** 3, softBytes: 3 * 1024 ** 3, hardBytes: null, suppressed: 4 };
  assert.match(memBusBody('w', soft), /4 further crossing\(s\) since the last warning were not repeated/);
});

// --- planKernelPairing: oldest-first from UNCLAIMED lines, with the debt of records that never got theirs ---

test("planKernelPairing: lines pair oldest-first with the records; the SURPLUS (the next kill's line already in the journal) is left unclaimed for the next round", () => {
  const L = (pid: number) => parseKernelOomMessage(REAL_OOM_LINE.replace('pid=2413311', `pid=${pid}`), pid)!;
  const plan = planKernelPairing([L(12), L(13)], new Set(), 0, 1);
  assert.deepEqual(plan.pair.map((l) => l.pid), [12]);
  assert.deepEqual(plan.claim.map((l) => l.pid), [12], '13 is NOT claimed: it names the next kill');
  assert.equal(plan.newDebts, 0);
});

test("planKernelPairing: records that never got their line OWE it - the oldest unclaimed lines are theirs and are set aside, never handed to the current kill", () => {
  const L = (pid: number) => parseKernelOomMessage(REAL_OOM_LINE.replace('pid=2413311', `pid=${pid}`), pid)!;
  const plan = planKernelPairing([L(12), L(13)], new Set(), 1, 1);
  assert.deepEqual(plan.pair.map((l) => l.pid), [13], "the stale 12 is the earlier kill's");
  assert.deepEqual(plan.claim.map((l) => l.pid), [12, 13]);
  assert.equal(plan.debtsSettled, 1);
  const stale = planKernelPairing([L(12)], new Set(), 1, 1);
  assert.deepEqual(stale.pair, []);
  assert.deepEqual(stale.claim.map((l) => l.pid), [12]);
  assert.equal(stale.newDebts, 1);
});

test("planKernelPairing: a line naming a pid an earlier record already named is that record's (set aside, settling one debt); fewer lines than records pairs NOTHING and the missing ones are owed", () => {
  const L = (pid: number) => parseKernelOomMessage(REAL_OOM_LINE.replace('pid=2413311', `pid=${pid}`), pid)!;
  const named = planKernelPairing([L(12), L(13)], new Set([12]), 1, 1);
  assert.deepEqual(named.pair.map((l) => l.pid), [13]);
  assert.equal(named.debtsSettled, 1);
  const short = planKernelPairing([L(12)], new Set(), 0, 2);
  assert.deepEqual(short.pair, [], 'one line for two kills: which kill is it? - no certainty');
  assert.deepEqual(short.claim.map((l) => l.pid), [12], 'but the line is accounted for');
  assert.equal(short.newDebts, 1);
  assert.deepEqual(planKernelPairing([], new Set(), 0, 1), { claim: [], pair: [], debtsSettled: 0, newDebts: 1 });
});

test("planKernelPairing: a LATE line (its debt already forgiven) naming a pid an earlier record guessed is recognised as that record's - the current kill is not handed it", () => {
  const L = (pid: number) => parseKernelOomMessage(REAL_OOM_LINE.replace('pid=2413311', `pid=${pid}`), pid)!;
  const plan = planKernelPairing([L(12), L(13)], new Set([12]), 0, 1); // debts 0: the 4 s are over; pid 12 was the (right) guess of an earlier record
  assert.deepEqual(plan.pair.map((l) => l.pid), [13]);
  assert.deepEqual(plan.claim.map((l) => l.pid), [12, 13]);
});
