// Unit tests for the soak campaign's INSTRUMENTS (C5 #212): the fault plan (the injection point C6 builds on), the fake API's hang / per-session
// stats / bounded retention, the seeded-leak MCP server, the single-flight lock, the code identity, and the driver's D7 refusals. None of it needs
// bwrap, a real `claude` or the network: the host-dependent arms live in `pnpm run test:soak-campaign` (scripts/session-budget/soak-selftest.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const S = (f: string) => `${REPO}/scripts/session-budget/${f}`;
const faultPlan = await import(S('fault-plan.mjs'));
const api = await import(S('fake-anthropic-api.mjs'));
const lib = await import(S('soak-lib.mjs'));

function scratch(prefix: string): string {
  const base = path.join(os.homedir(), '.cache', 'session-budget-test');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, `${prefix}-`));
}
const model = (tools: number, sid: string) => ({ type: 'model', tools, sid });

// ── fault plan ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('fault plan: `hang` applies to the named session\'s MAIN model requests after N, never to others, side calls or other routes', () => {
  const f = faultPlan.compileFaultPlan({ rules: [{ match: { session: 's2', main: true }, after: 2, action: { kind: 'hang' } }] });
  assert.equal(f(model(92, 's2')), null, '1st main request passes');
  assert.equal(f(model(92, 's2')), null, '2nd passes');
  assert.deepEqual(f(model(92, 's2')), { kind: 'hang' }, '3rd onward hangs');
  assert.deepEqual(f(model(92, 's2')), { kind: 'hang' });
  assert.equal(f(model(92, 's1')), null, 'another session is never touched');
  assert.equal(f(model(0, 's2')), null, 'a tool-less side call (main:true only) is not the target');
  assert.equal(f({ type: 'count_tokens', sid: 's2' }), null, 'not a model route');
  assert.equal(faultPlan.compileFaultPlan(null)(model(92, 's2')), null, 'no plan → no fault');
  const any = faultPlan.compileFaultPlan({ rules: [{ action: { kind: 'hang' } }] });
  assert.deepEqual(any(model(0, 'sX')), { kind: 'hang' }, 'an empty match hits every model request');
});

test('fault plan: kinds reserved for C6 and unknown kinds THROW at compile time — a plan that injects nothing must never run "fault-free"', () => {
  for (const kind of ['delay', 'status', 'reset', 'truncate', 'blackhole']) {
    assert.throws(() => faultPlan.compileFaultPlan({ rules: [{ action: { kind } }] }), /reserved for C6 \(#213\)/, kind);
  }
  assert.throws(() => faultPlan.compileFaultPlan({ rules: [{ action: { kind: 'explode' } }] }), /unknown action kind "explode"/);
  assert.throws(() => faultPlan.compileFaultPlan({ rules: [{}] }), /unknown action kind undefined/);
  assert.throws(() => faultPlan.compileFaultPlan({ nope: 1 }), /expected \{ rules/);
  assert.throws(() => faultPlan.compileFaultPlan({ rules: [{ after: -1, action: { kind: 'hang' } }] }), /non-negative integer/);
  assert.deepEqual([...faultPlan.IMPLEMENTED_ACTIONS], ['hang']);
});

// ── fake API: hang, per-session stats, retention ────────────────────────────────────────────────────────────────────────────────
test('fake API: a hang fault is HELD OPEN (a wedged upstream), other sessions keep being served, stats name it, stop() releases it', async () => {
  const f = await api.startFakeApi({
    sessionTag: (h: any) => /soak-(s\d+)/.exec(String(h['x-api-key'] ?? ''))?.[1] ?? 'unknown',
    fault: faultPlan.compileFaultPlan({ rules: [{ match: { session: 's1', main: true }, after: 1, action: { kind: 'hang' } }] }),
  });
  try {
    const call = (key: string, tools: number, ms = 1500) => fetch(`${f.url}/v1/messages`, {
      method: 'POST', headers: { 'x-api-key': `sk-soak-${key}-fake` }, signal: AbortSignal.timeout(ms),
      body: JSON.stringify({ model: 'm', max_tokens: 1, stream: false, tools: Array.from({ length: tools }, () => ({ name: 't' })), messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal((await call('s1', 5)).status, 200, 'the first main request of s1 is served');
    const hung = call('s1', 5, 60_000); // the CLI's own request timeout is minutes: it just waits
    const hungOutcome = hung.then(() => 'answered', () => 'closed');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await call('s0', 5)).status, 200, 's0 is served while s1 hangs');
    assert.equal((await call('s1', 0)).status, 200, 's1\'s tool-less side call is not the target');
    const st = f.stats();
    assert.equal(st.totals.heldEver, 1);
    assert.equal(st.totals.held, 1, 'the hung socket is still open');
    assert.equal(st.sessions.s1.main, 2);
    assert.equal(st.sessions.s1.side, 1);
    assert.equal(st.sessions.s1.held, 1);
    assert.equal(st.sessions.s0.held, 0);
    assert.equal(st.sessions.s0.main, 1);
    assert.equal(f.requests.find((r: any) => r.fault === 'hang')?.sid, 's1');
    await f.stop(); // stop() releases the held socket: the pending request ends, it was never ANSWERED
    assert.equal(await hungOutcome, 'closed');
  } finally { await f.stop(); }
});

test('fake API: `retain` bounds the request/egress records but NOT the counters (a 2 h campaign must not grow the API process)', async () => {
  const f = await api.startFakeApi({ retain: 5, sessionTag: () => 's0' });
  try {
    for (let i = 0; i < 20; i++) await fetch(`${f.url}/v1/messages/count_tokens`, { method: 'POST', body: '{}' });
    assert.equal(f.requests.length, 5);
    assert.equal(f.stats().totals.count_tokens, 20, 'the counter still saw all 20');
    assert.equal(f.stats().sessions.s0.count_tokens, 20);
    assert.equal(f.requests[0].seq, 16, 'the oldest kept record is the 16th');
  } finally { await f.stop(); }
});

// ── the seeded-leak MCP server ────────────────────────────────────────────────────────────────────────────────────────────────
const rssKB = (pid: number): number => Number(/^VmRSS:\s+(\d+) kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]);

test('seeded leak: the fake MCP server retains memory forever ONLY when told to; still speaks MCP', async () => {
  const mk = (extra: string[]) => spawn(process.execPath, [S('fake-mcp-server.mjs'), '--name', 'x', '--tools', '2', ...extra], { stdio: ['pipe', 'pipe', 'ignore'] });
  const leaker = mk(['--leak-mb-per-min', '600']); // 10 MB/s
  const control = mk([]);
  try {
    await new Promise((r) => setTimeout(r, 700)); // both past startup
    const l0 = rssKB(leaker.pid!), c0 = rssKB(control.pid!);
    await new Promise((r) => setTimeout(r, 2500));
    const l1 = rssKB(leaker.pid!), c1 = rssKB(control.pid!);
    assert.ok(l1 - l0 >= 8 * 1024, `the seeded leaker grew ${Math.round((l1 - l0) / 1024)} MB in 2.5 s (want ≥ 8 MB)`);
    assert.ok(c1 - c0 < 4 * 1024, `the control did not grow (${Math.round((c1 - c0) / 1024)} MB)`);
    const reply: any = await new Promise((resolve) => { leaker.stdout!.once('data', (d) => resolve(JSON.parse(String(d).split('\n')[0]))); leaker.stdin!.write('{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n'); });
    assert.equal(reply.result.tools.length, 2, 'the leaker is still a working MCP server');
  } finally { leaker.kill('SIGKILL'); control.kill('SIGKILL'); }
});

// ── lock, identity, driver refusals ────────────────────────────────────────────────────────────────────────────────────────────
test('single-flight lock: a live holder refuses the second campaign; release frees it; a dead holder\'s lock is taken over', () => {
  const dir = scratch('lock');
  const lp = path.join(dir, 'campaign.lock');
  try {
    const a = lib.acquireLock(lp, 'first');
    assert.throws(() => lib.acquireLock(lp, 'second'), /another campaign is running \(first pid \d+/);
    a.release();
    assert.equal(fs.existsSync(lp), false);
    const b = lib.acquireLock(lp, 'third');
    b.release();
    // a stale lock: a holder pid that is not alive (start-time cannot match)
    fs.writeFileSync(lp, JSON.stringify({ pid: 999999, startTicks: 1, label: 'dead', at: 'then' }));
    const c = lib.acquireLock(lp, 'after-crash');
    assert.equal(JSON.parse(fs.readFileSync(lp, 'utf8')).label, 'after-crash');
    c.release();
    // a recycled pid: alive, but a different start time → NOT the holder
    fs.writeFileSync(lp, JSON.stringify({ pid: process.pid, startTicks: 1, label: 'recycled', at: 'then' }));
    lib.acquireLock(lp, 'over-recycled').release();
    // release never removes someone else's lock
    const d = lib.acquireLock(lp, 'mine');
    fs.writeFileSync(lp, JSON.stringify({ pid: 1, startTicks: 1, label: 'theirs', at: 'now' }));
    d.release();
    assert.equal(JSON.parse(fs.readFileSync(lp, 'utf8')).label, 'theirs');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function gitRepo(): string {
  const dir = scratch('ident');
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, stdio: 'pipe' });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts', 'session-budget'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'session-budget', 'h.mjs'), '// h\n');
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lock: 1\n');
  fs.writeFileSync(path.join(dir, 'docs', 'x.md'), 'x\n');
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'init');
  return dir;
}

test('code identity (the change gate\'s key): moves with code, lockfile and uncommitted edits; NOT with docs; null when it cannot be read', () => {
  const dir = gitRepo();
  try {
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, stdio: 'pipe' });
    const base = lib.codeIdentity(dir);
    assert.match(base.codeId, /^[0-9a-f]{16}$/);
    assert.equal(base.dirty, null);
    assert.equal(lib.codeIdentity(dir).codeId, base.codeId, 'stable');
    fs.writeFileSync(path.join(dir, 'docs', 'x.md'), 'changed docs\n'); git('add', '-A'); git('commit', '-q', '-m', 'docs');
    assert.equal(lib.codeIdentity(dir).codeId, base.codeId, 'a docs-only commit is not a code change');
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
    const dirty = lib.codeIdentity(dir);
    assert.notEqual(dirty.codeId, base.codeId, 'an UNCOMMITTED source edit changes it');
    assert.match(dirty.dirty, /^[0-9a-f]{12}$/);
    git('add', '-A'); git('commit', '-q', '-m', 'src');
    const committed = lib.codeIdentity(dir);
    assert.notEqual(committed.codeId, base.codeId);
    assert.equal(committed.dirty, null);
    fs.writeFileSync(path.join(dir, 'src', 'new.ts'), 'export const n = 1;\n');
    assert.notEqual(lib.codeIdentity(dir).codeId, committed.codeId, 'an UNTRACKED source file changes it');
    fs.rmSync(path.join(dir, 'src', 'new.ts'));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lock: 2\n'); git('add', '-A'); git('commit', '-q', '-m', 'lock');
    assert.notEqual(lib.codeIdentity(dir).codeId, committed.codeId, 'a dependency change (lockfile) changes it');
    const notGit = scratch('notgit');
    try { assert.equal(lib.codeIdentity(notGit).codeId, null, 'not a git checkout → NO identity (the gate fails closed), never a hash of a constant'); } finally { fs.rmSync(notGit, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('driver: >10 sessions is REFUSED outright (D7), spawning nothing and writing nothing', async () => {
  const out = scratch('refuse');
  try {
    const r = await lib.runCampaign({ repo: REPO, params: { sessions: 11, durationSec: 300, turnIntervalSec: 20, sampleSec: 10, turnDeadlineSec: 60, replyDelayMs: 500 }, outDir: out, lockPath: path.join(out, 'l.lock') });
    assert.match(r.refused.join('|'), /exceeds the D7 cap of 10 concurrent sessions/);
    assert.deepEqual(fs.readdirSync(out), [], 'no report, no lock');
    const cli = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', S('soak-campaign.mjs'), '--sessions', '11'], { encoding: 'utf8' });
    assert.equal(cli.status, 2);
    assert.match(cli.stderr, /REFUSED — sessions=11 exceeds the D7 cap of 10/);
    assert.equal(/SOAK-CAMPAIGN:/.test(cli.stdout), false, 'a refusal never prints a terminator that could be mistaken for a run');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('driver: a second campaign is REFUSED while the lock is held (D7: never two at once)', async () => {
  const out = scratch('locked');
  const lp = path.join(out, 'l.lock');
  const held = lib.acquireLock(lp, 'other-campaign');
  try {
    const r = await lib.runCampaign({ repo: REPO, params: { sessions: 3, durationSec: 300, turnIntervalSec: 20, sampleSec: 10, turnDeadlineSec: 60, replyDelayMs: 500 }, outDir: out, lockPath: lp });
    assert.match(r.refused.join('|'), /another campaign is running \(other-campaign/);
    assert.equal(fs.readdirSync(out).filter((f) => f.startsWith('soak-')).length, 0);
  } finally { held.release(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('D7 MUST-ABORT through the real driver: a machine below the RAM floor yields a dated ABORTED report, spawns nothing, rc 4', async () => {
  const out = scratch('abort');
  try {
    // capsOverride can only TIGHTEN: demanding 1 TB free makes this host "below the floor" without depending on how loaded it really is.
    const r = await lib.runCampaign({
      repo: REPO, params: { sessions: 3, durationSec: 300, turnIntervalSec: 20, sampleSec: 10, turnDeadlineSec: 60, replyDelayMs: 500 }, outDir: out, label: 'unit',
      lockPath: path.join(out, 'l.lock'), capsOverride: { minMemAvailKB: 1024 ** 3 },
    });
    assert.equal(r.refused, undefined);
    assert.equal(r.terminator, 'ABORTED');
    assert.equal(r.rc, 4);
    assert.equal(r.report.status, 'ABORTED');
    assert.equal(r.report.aborted.reason, 'low-ram');
    assert.match(r.report.aborted.detail, /free RAM .* GB < 1024\.0 GB/);
    assert.equal(r.report.params.sessions, 3, 'the aborted report still says what was asked');
    assert.match(path.basename(r.files.json), /^soak-\d{8}T\d{6}Z-unit\.json$/, 'dated');
    const onDisk = JSON.parse(fs.readFileSync(r.files.json, 'utf8'));
    assert.equal(onDisk.terminator, 'ABORTED');
    assert.match(fs.readFileSync(r.files.md, 'utf8'), /status ABORTED \(low-ram/);
    assert.equal(lib.otherRunnerAlive(), null, 'nothing was spawned');
    assert.equal(fs.existsSync(path.join(out, 'l.lock')), false, 'the lock was released');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
