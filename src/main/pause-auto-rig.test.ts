import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #256 (ledger #276 D6) — the auto Pause / auto Reprise through the REAL modules (agent-sdk producer → activity → prompt-queue tick →
// pause-auto → bus; migrate; accountLoginStart) over a real bus + store, one arm per SUBPROCESS (scripts/e2e-pause-auto.mjs). The ONLY fakes:
// the SDK query, the `claude` binary and the Anthropic usage API (a local HTTP server; every other outbound fetch is refused). Scratch
// HOME/ORCHESTRA_HOME/CLAUDE_CONFIG_DIR + account dirs under ~/.cache (D9). Arm titles are what the in-place mutants redden.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RIG = path.join(REPO, 'scripts', 'e2e-pause-auto.mjs');
const REGISTER = path.join(REPO, 'scripts', '.r2-register.mjs');
const RIG_HOME = path.join(os.homedir(), '.cache', `e2e-pause-auto-unit-${process.pid}`);

type R = Record<string, any> & { ok: boolean; arm: string };

function runArm(arm: string): R {
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', REGISTER, RIG, arm], {
      encoding: 'utf8', timeout: 170_000, cwd: REPO, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.homedir(), PAUSE_AUTO_RIG_HOME: RIG_HOME }, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    stdout = (e as { stdout?: string }).stdout ?? ''; // a red arm exits 1 but still printed its verdict line
  }
  const line = stdout.trim().split('\n').filter(Boolean).pop();
  assert.ok(line, `arm ${arm} produced no output — the rig did not run`); // a crashed rig must read as a failure, never a pass
  const r = JSON.parse(line) as R;
  assert.equal(r.arm, arm, 'the rig ran the arm that was asked for');
  return r;
}

test.after(() => fs.rmSync(RIG_HOME, { recursive: true, force: true }));

test('the rig + its register hook exist', () => {
  assert.ok(fs.existsSync(RIG) && fs.existsSync(REGISTER));
});

test('RIG limit_pause: a member turn dying on the limit (real SDK producer chain) pauses ITS run, auto, with its pinned account; the unrelated run is not touched; the pause gates the siblings', () => {
  const r = runArm('limit_pause');
  assert.equal(r.paused, true);
  assert.equal(r.marker, 'usage_limit');
  assert.equal(r.pausedBy, 'host:usage_limit');
  assert.equal(r.mode, 'hard');
  assert.equal(r.trapOwed, true);
  assert.deepEqual([r.reason.reason, r.reason.wsIds, r.reason.accountIds], ['usage_limit', ['ws-m1'], ['acct-a']]);
  assert.equal(r.xopsPaused, false);
  assert.equal(r.m2Wake, false, 'an AUTO wake of a sibling member is refused by the pause');
  assert.equal(r.xmWake, true, 'control: the unrelated run still starts');
  assert.equal(r.ok, true);
});

test('RIG switch_resume: limited acct-a (reset an hour away) ⇒ paused, a tick does not resume it; the account SWITCH forces a fresh reading of acct-b (cache bypassed) and Reprises within one poll tick', () => {
  const r = runArm('switch_resume');
  assert.equal(r.paused, true);
  assert.deepEqual([r.cacheA, r.cacheB], [100, 10], 'both readings were cached (inside the 180 s floor) before the switch');
  assert.equal(r.resumedByTickWhileLimited, false, 'a tick alone does not resume while the account is limited');
  assert.equal(r.migrate.ok, true);
  assert.equal(r.resumed, true);
  assert.equal(r.withinOneTick, true, `resume latency ${r.resumeLatencyMs} ms must be ≤ one 20 s poll tick`);
  assert.ok(r.forcedFetchOfB >= 1, 'the cached <180 s reading was NOT reused: the fake API saw a fresh fetch of tok-b');
  assert.equal(r.repinned, 'acct-b');
  assert.deepEqual(r.storedAccount, ['acct-b'], 'the stored display account follows the pin');
  assert.equal(r.markerKept, 'usage_limit', 'the trigger\'s marker is LEFT: #74 stays the safety net that restarts a limit-killed member once it may start');
  assert.equal(r.xopsTouched, false);
  assert.equal(r.ok, true);
});

test('RIG switch_default_login: a switch to the DEFAULT login forces the global poller\'s fresh reading too (its cache is separate) and Reprises within one tick', () => {
  const r = runArm('switch_default_login');
  assert.equal(r.paused, true);
  assert.equal(r.resumedWhileLimited, false);
  assert.equal(r.migrate.ok, true);
  assert.equal(r.resumed, true);
  assert.ok(r.resumeLatencyMs <= 20_000, `latency ${r.resumeLatencyMs} ms`);
  assert.ok(r.forcedFetchOfDefault >= 1, 'the default login\'s token was read at once');
  assert.equal(r.repinned, null);
  assert.equal(r.ok, true);
});

test('RIG relogin_resume: a re-login (real accountLoginStart + login watcher) forces a fresh reading of that account and Reprises within one tick', () => {
  const r = runArm('relogin_resume');
  assert.equal(r.paused, true);
  assert.equal(r.resumedWhileLimited, false);
  assert.equal(r.resumed, true);
  assert.ok(r.resumeLatencyMs <= 20_000, `latency ${r.resumeLatencyMs} ms`);
  assert.ok(r.forcedFetchOfNewToken >= 1, 'the NEW token was read at once (the old reading was <180 s old)');
  assert.equal(r.ok, true);
});

test('RIG quota_back_tick: no switch — the poller\'s reading shows quota well before the stored reset ⇒ the NEXT flusher tick Reprises (a fresh reading overrides the stored reset time)', () => {
  const r = runArm('quota_back_tick');
  assert.deepEqual([r.beforeQuota, r.beforeTick, r.afterOneTick], [false, false, true]);
  assert.equal(r.ok, true);
});

test('RIG manual_never: a MANUAL pause is never auto-resumed (quota everywhere, ticks, account switch, re-login), and a limit stop under it does not make it auto', () => {
  const r = runArm('manual_never');
  assert.equal(r.pauseResult, 'paused');
  assert.equal(r.autoAfterLimit, null);
  assert.equal(r.resume, null);
  assert.equal(r.pausedBy, 'ws-ops');
  assert.equal(r.stillPaused, true);
  assert.equal(r.lift, 'lifted', 'control: the human lift still works');
  assert.equal(r.ok, true);
});

test('RIG trap_wait: quota is back but the host trap has not stamped ⇒ no Reprise (the Bilans are the Consigne source); stamped ⇒ Reprise', () => {
  const r = runArm('trap_wait');
  assert.deepEqual([r.paused, r.whileTrapOwed, r.afterTrap], [true, false, true]);
  assert.equal(r.ok, true);
});

test('RIG repause: a member hitting the limit AFTER the Reprise started sends the run back to PAUSED (a NEW epoch, trap owed, reason carried), the new member joins — and the flap guard holds the next Reprise although quota readings are back', () => {
  const r = runArm('repause');
  assert.equal(r.resuming, true);
  assert.equal(r.backToPaused, true);
  assert.equal(r.epochCarried, true, 'pause_auto is bound to the NEW epoch');
  assert.deepEqual(r.reason.wsIds, ['ws-m1', 'ws-m2']);
  assert.equal(r.reprisedAgainAtOnce, false, 'a Fable-only / unreadable limit must not loop pause → trap → Reprise');
  assert.equal(r.ok, true);
});

test('RIG relogin_race: an OLDER plain fetch landing after the forced one must not replace it in the cache — the tick after the trap still Reprises', () => {
  const r = runArm('relogin_race');
  assert.equal(r.expired, true);
  assert.equal(r.hits, 2, 'the plain refresh AND the forced one both fetched');
  assert.equal(r.reprisedBeforeTrap, false);
  assert.equal(r.reprisedAtTickAfterTrap, true);
  assert.equal(r.ok, true);
});

test('RIG remark_no_repause: #74\'s own failed-wake re-mark is not a new limit stop (no pause); a real stop right after is', () => {
  const r = runArm('remark_no_repause');
  assert.equal(r.pausedBefore, false);
  assert.equal(r.wakeAttempts, 1, '#74 really attempted the wake that then failed');
  assert.equal(r.markerRestored, 'usage_limit', 'the compensator re-marked');
  assert.equal(r.pausedByRemark, false);
  assert.equal(r.pausedByRealStop, true, 'control: the instrument can see a pause');
  assert.equal(r.ok, true);
});

test('RIG wake_off_no_pause: a carrier with the frozen `wake` switch OFF gets NO auto Pause (a Reprise could wake nobody) — nothing written; a wake-ON run pauses (control)', () => {
  const r = runArm('wake_off_no_pause');
  assert.equal(r.runsIdentical, true);
  assert.equal(r.pausedOps, false);
  assert.equal(r.pausedControl, true);
  assert.equal(r.ok, true);
});

test('RIG wake_off_nested: a child OPS run with wake OFF under a pause+wake ON carrier stops the auto Pause (its coordinator could not be woken) — nothing written; the unrelated run pauses', () => {
  const r = runArm('wake_off_nested');
  assert.equal(r.runsIdentical, true);
  assert.equal(r.pausedCarrier, false);
  assert.equal(r.pausedControl, true);
  assert.equal(r.ok, true);
});

test('RIG release_clears_marker: a member sent its Reprise row (coordinator Bilan at beginReprise, worker Consigne at `run release`) loses its #74 marker BEFORE the nudge — no second wake', () => {
  const r = runArm('release_clears_marker');
  assert.equal(r.resuming, true);
  assert.equal(r.opsMarker, null, 'the coordinator trigger: cleared in the SAME tick as its Bilan row');
  assert.equal(r.m1MarkerBlocked, 'usage_limit', 'the blocked worker keeps its marker (its OPS has not released it)');
  assert.equal(r.startsAfterReprise, 0);
  assert.deepEqual(r.released, ['ws-m1']);
  assert.equal(r.m1MarkerAfterRelease, null);
  assert.equal(r.startsAfterRelease, 0, '#74 did NOT nudge the released worker next to its Consigne (429 path: reset unknown + fresh reading would have)');
  assert.equal(r.ok, true);
});

test('RIG nudge_throttle: a reset unknown / passed with no conclusive reading asks the poller for one at most once per 120 s per account (a failed status is never fresh)', () => {
  const r = runArm('nudge_throttle');
  assert.equal(r.failedStatus, true);
  assert.equal(r.fetchesOver3Ticks, 1, 'three 20 s ticks ⇒ ONE usage fetch, not three');
  assert.equal(r.resumed, false);
  assert.equal(r.ok, true);
});

test('RIG usage_newer_wins: a plain default-login poll issued BEFORE a forced refreshUsageNow and landing after it never replaces its snapshot (issue-sequence order)', () => {
  const r = runArm('usage_newer_wins');
  assert.deepEqual([r.forcedSnapshot, r.afterLateAnswer], [10, 10]);
  assert.equal(r.ok, true);
});

test('RIG off_identity: switch OFF ⇒ a limit stop writes no pause column, a tick forces/fetches nothing extra, an account switch forces nothing, #74 still waits for the stored reset', () => {
  const r = runArm('off_identity');
  assert.equal(r.runsIdentical, true);
  assert.equal(r.nudged, 0, '#74 alone waits for the reset although a fresh reading shows quota — master behaviour, unchanged');
  assert.equal(r.markerKept, true);
  assert.equal(r.forcedFetches.a, 0);
  assert.ok(r.forcedFetches.b <= 1, 'only the migrate\'s own non-forcing refresh may read acct-b');
  assert.equal(r.runsIdenticalAfterSwitch, true);
  assert.equal(r.ok, true);
});

test('RIG safety net: an arm that never settles still prints an ok:false verdict (deadline), never a silent exit', () => {
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', REGISTER, RIG, 'hang_selftest'], {
      encoding: 'utf8', timeout: 60_000, cwd: REPO, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.homedir(), PAUSE_AUTO_RIG_HOME: RIG_HOME, PAUSE_RIG_DEADLINE_MS: '2500' }, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    stdout = (e as { stdout?: string }).stdout ?? '';
  }
  const r = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '{}');
  assert.equal(r.ok, false);
  assert.match(String(r.abort), /deadline/);
});
