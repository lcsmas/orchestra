// Unit tests for the soak SCHEDULER's pure decision (C5 #212): idle-time, change-gated, never overlapping the user's work, capped by D7.
// Literals only. Every gate has a must-SKIP arm (the gate closed → the exact reason) AND the base case is a must-RUN arm (all gates open),
// so a gate deleted from the decision — or a decision that never runs — reddens a named test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCampaignEnv, decideSoakRun, DEFAULT_SOAK_POLICY, EMPTY_SOAK_STATE, fitSessions, shouldYield, userActivity, type SoakActivity, type SoakTick } from './soak-schedule.ts';

const GB = 1048576;
const MIN = 60_000;
const H = 3600_000;
const NOW = 1_800_000_000_000;

const idleActivity = (over: Partial<SoakActivity> = {}): SoakActivity => ({
  appUptimeMs: 3 * H, windowFocused: false, lastFocusedAt: NOW - 2 * H, systemIdleSec: 3600,
  workspaces: [{ id: 'aaaaaaaa-1', status: 'idle', lastActivityAt: NOW - 3 * H }, { id: 'bbbbbbbb-2', status: 'stopped' }], ...over,
});
const tick = (over: Partial<SoakTick> = {}): SoakTick => ({
  now: NOW, enabled: true, campaignRunning: false, current: { codeId: 'code-B', cliVersion: '2.1.284' },
  state: { schema: 1, lastCompleted: { codeId: 'code-A', cliVersion: '2.1.284', at: NOW - 24 * H, terminator: 'PASS', reportJson: '/r.json' }, lastAttempt: { at: NOW - 24 * H, outcome: 'pass' } },
  activity: idleActivity(), machine: { memAvailKB: 20 * GB, load1: 4 }, ...over,
});
const skip = (t: SoakTick) => { const d = decideSoakRun(t); return d.run ? 'RUN' : d.skip; };

test('policy literals', () => {
  assert.equal(DEFAULT_SOAK_POLICY.minAppUptimeMs, 10 * MIN);
  assert.equal(DEFAULT_SOAK_POLICY.userIdleMs, 15 * MIN);
  assert.equal(DEFAULT_SOAK_POLICY.workspaceQuietMs, 10 * MIN);
  assert.equal(DEFAULT_SOAK_POLICY.yieldIdleMs, 60_000);
  assert.equal(DEFAULT_SOAK_POLICY.attemptCooldownMs, 60 * MIN);
  assert.equal(DEFAULT_SOAK_POLICY.minIntervalMs, 6 * H);
  assert.equal(DEFAULT_SOAK_POLICY.minSessions, 3);
  assert.equal(DEFAULT_SOAK_POLICY.durationSec, 3600);
});

test('MUST-RUN: idle machine + idle user + changed code → run, sized to the RAM, with the reason', () => {
  const d = decideSoakRun(tick());
  assert.equal(d.run, true);
  if (d.run) { assert.equal(d.sessions, 10); assert.match(d.reason, /code changed \(code-A → code-B\)/); }
});

test('change gate: unchanged code AND CLI → skip; a changed CLI alone or code alone → run; never-ran → run', () => {
  assert.equal(skip(tick({ current: { codeId: 'code-A', cliVersion: '2.1.284' } })), 'unchanged');
  const cli = decideSoakRun(tick({ current: { codeId: 'code-A', cliVersion: '2.1.290' } }));
  assert.equal(cli.run, true);
  if (cli.run) assert.match(cli.reason, /claude CLI changed \(2\.1\.284 → 2\.1\.290\)/);
  assert.equal(skip(tick({ current: { codeId: 'code-B', cliVersion: '2.1.284' } })), 'RUN');
  assert.equal(skip(tick({ state: EMPTY_SOAK_STATE })), 'RUN', 'no campaign ever completed → the first one runs');
  assert.equal(skip(tick({ current: { codeId: 'code-A', cliVersion: null } })), 'identity-unreadable', 'an unreadable CLI is not a change — nothing to exercise');
});

test('a campaign that did not RUN to its end never advances the gate: only lastCompleted counts', () => {
  const aborted = tick({ current: { codeId: 'code-B', cliVersion: '2.1.284' }, state: { schema: 1, lastCompleted: null, lastAttempt: { at: NOW - 2 * H, outcome: 'aborted' } } });
  assert.equal(skip(aborted), 'RUN', 'an aborted attempt 2 h ago (past the cooldown) does not mark the code as covered');
});

test('cooldown between attempts and the minimum interval between completed campaigns', () => {
  assert.equal(skip(tick({ state: { schema: 1, lastCompleted: null, lastAttempt: { at: NOW - 30 * MIN, outcome: 'aborted' } } })), 'cooldown');
  assert.equal(skip(tick({ state: { schema: 1, lastCompleted: null, lastAttempt: { at: NOW - 61 * MIN, outcome: 'aborted' } } })), 'RUN');
  const recent = { schema: 1 as const, lastCompleted: { codeId: 'code-A', cliVersion: '2.1.284', at: NOW - 5 * H, terminator: 'PASS' as const, reportJson: '' }, lastAttempt: { at: NOW - 5 * H, outcome: 'pass' } };
  assert.equal(skip(tick({ state: recent })), 'min-interval', 'code changed but the last completed campaign was 5 h ago (< 6 h)');
  assert.equal(skip(tick({ state: { ...recent, lastCompleted: { ...recent.lastCompleted, at: NOW - 7 * H }, lastAttempt: { at: NOW - 7 * H, outcome: 'pass' } } })), 'RUN');
});

test('never overlaps the user\'s active work: focus, a running/waiting workspace, recent input, recent agent activity, unknown idle', () => {
  assert.equal(skip(tick({ activity: idleActivity({ windowFocused: true }) })), 'user-active');
  assert.equal(skip(tick({ activity: idleActivity({ workspaces: [{ id: 'aaaaaaaa-1', status: 'running' }] }) })), 'user-active');
  assert.equal(skip(tick({ activity: idleActivity({ workspaces: [{ id: 'aaaaaaaa-1', status: 'waiting' }] }) })), 'user-active');
  assert.equal(skip(tick({ activity: idleActivity({ systemIdleSec: 5 * 60 }) })), 'user-active', 'input 5 min ago < 15 min idle');
  assert.equal(skip(tick({ activity: idleActivity({ systemIdleSec: 16 * 60 }) })), 'RUN');
  assert.equal(skip(tick({ activity: idleActivity({ workspaces: [{ id: 'aaaaaaaa-1', status: 'idle', lastActivityAt: NOW - 5 * MIN }] }) })), 'user-active', 'agent activity 5 min ago < 10 min quiet');
  assert.equal(skip(tick({ activity: idleActivity({ workspaces: [{ id: 'aaaaaaaa-1', status: 'idle', lastActivityAt: NOW - 11 * MIN }] }) })), 'RUN');
  // no OS idle reading: fall back to the window's focus history — and never treat "unknown" as idle
  assert.equal(skip(tick({ activity: idleActivity({ systemIdleSec: null, lastFocusedAt: NOW - 5 * MIN }) })), 'user-active');
  assert.equal(skip(tick({ activity: idleActivity({ systemIdleSec: null, lastFocusedAt: NOW - 20 * MIN }) })), 'RUN');
  assert.equal(skip(tick({ activity: idleActivity({ systemIdleSec: null, lastFocusedAt: undefined }) })), 'user-active');
});

test('userActivity names the signal', () => {
  assert.match(userActivity(idleActivity({ windowFocused: true }), NOW, DEFAULT_SOAK_POLICY, 'start').why, /window is focused/);
  assert.match(userActivity(idleActivity({ workspaces: [{ id: 'cafebabe-9', status: 'running' }] }), NOW, DEFAULT_SOAK_POLICY, 'start').why, /1 workspace\(s\) running \(cafebabe\)/);
  assert.deepEqual(userActivity(idleActivity(), NOW, DEFAULT_SOAK_POLICY, 'start'), { active: false, why: 'idle' });
});

test('D7 machine gates: RAM floor, load ceiling, and a machine too small to fit the minimum campaign', () => {
  assert.equal(skip(tick({ machine: { memAvailKB: 5 * GB, load1: 4 } })), 'machine');
  assert.equal(skip(tick({ machine: { memAvailKB: 20 * GB, load1: 20.5 } })), 'machine');
  assert.equal(skip(tick({ machine: { memAvailKB: NaN, load1: 4 } })), 'machine', 'unreadable → fail closed');
  assert.equal(skip(tick({ machine: { memAvailKB: 7 * GB, load1: 4 } })), 'no-fit', '7 GB free: above the floor but 3 sessions (2.2 GB) would break it');
  const d = decideSoakRun(tick({ machine: { memAvailKB: 11 * GB, load1: 4 } }));
  assert.equal(d.run && d.sessions, 7, '11 GB free fits 7 sessions (400+7×600 MB) above the 6 GB floor');
});

test('fitSessions: the largest N that leaves the floor, capped at 10, 0 below the minimum', () => {
  assert.equal(fitSessions(11 * GB, 5, DEFAULT_SOAK_POLICY), 7);
  assert.equal(fitSessions(30 * GB, 5, DEFAULT_SOAK_POLICY), 10, 'never above the D7 cap of 10');
  assert.equal(fitSessions(8.5 * GB, 5, DEFAULT_SOAK_POLICY), 3);
  assert.equal(fitSessions(8 * GB, 5, DEFAULT_SOAK_POLICY), 0);
  assert.equal(fitSessions(30 * GB, 25, DEFAULT_SOAK_POLICY), 0, 'load over the cap → nothing fits');
});

test('the remaining gates: disabled, campaign running, unreadable identity, app just started', () => {
  assert.equal(skip(tick({ enabled: false })), 'disabled');
  assert.equal(skip(tick({ campaignRunning: true })), 'campaign-running');
  assert.equal(skip(tick({ current: { codeId: null, cliVersion: '2.1.284' } })), 'identity-unreadable');
  assert.equal(skip(tick({ current: { codeId: 'code-B', cliVersion: null } })), 'identity-unreadable');
  assert.equal(skip(tick({ activity: idleActivity({ appUptimeMs: 5 * MIN }) })), 'app-just-started');
});

test('a RUNNING campaign yields to the user: focus, a workspace starting, input in the last minute — not to mere quiet', () => {
  assert.equal(shouldYield(idleActivity({ windowFocused: true }), NOW).yield, true);
  assert.equal(shouldYield(idleActivity({ workspaces: [{ id: 'aaaaaaaa-1', status: 'running' }] }), NOW).yield, true);
  assert.equal(shouldYield(idleActivity({ systemIdleSec: 30 }), NOW).yield, true, 'input 30 s ago < the 60 s yield idle');
  assert.equal(shouldYield(idleActivity({ systemIdleSec: 120 }), NOW).yield, false, 'input 2 min ago: keep running (the start bar of 15 min is not the stay bar)');
  assert.equal(shouldYield(idleActivity({ systemIdleSec: null }), NOW).yield, false);
});

test('ZERO TOKENS: the campaign parent env is an allowlist — no API key, no auth token, no OAuth token, no secrets ride along', () => {
  const env = buildCampaignEnv({
    ANTHROPIC_API_KEY: 'sk-ant-REAL', ANTHROPIC_AUTH_TOKEN: 'tok', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', GITHUB_TOKEN: 'gh', AWS_SECRET_ACCESS_KEY: 'aws',
    LANG: 'fr_FR.UTF-8', ORCHESTRA_HOME: '/home/u/.orchestra', CLAUDE_CONFIG_DIR: '/home/u/.claude-mc', PATH: '/weird',
  }, '/home/u', ['/home/u/.local/bin', '/home/u/.local/share/pnpm', null, '/usr/bin']);
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CONFIG_DIR', 'HOME', 'LANG', 'ORCHESTRA_HOME', 'PATH', 'TERM']);
  assert.equal(env.PATH, '/home/u/.local/bin:/home/u/.local/share/pnpm:/usr/bin:/usr/local/bin:/bin', 'the tool dirs first (deduped, null skipped), then the system dirs — nothing from the inherited PATH');
  assert.equal(env.HOME, '/home/u');
  assert.equal(JSON.stringify(env).includes('sk-ant'), false);
  assert.deepEqual(Object.keys(buildCampaignEnv({}, '/h', [null])).sort(), ['HOME', 'LANG', 'PATH', 'TERM']);
});
