import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Pure, Electron-free — importable bare here (verified) so the #180 behavioural
// arm below drives the REAL detector with the REAL constant, not a source regex.
import {
  decideBootWedge,
  BOOT_SILENCE_MS,
  GATE_SILENCE_RELEASE_MS,
} from '../shared/session-wedge.ts';

// Tests that DRIVE `src/main/session-watchdog.ts` itself (review R4).
//
// ── Why this file exists, stated plainly ────────────────────────────────────
//
// The pure-policy tests in `src/shared/session-wedge.test.ts` are good and they
// were STRUCTURALLY INCAPABLE of catching any of the three defects review found
// in this feature (R1: the recycle path consulted no progress evidence; R2: the
// wake delivered a message the hook then re-delivered; the R2 residual: step 4's
// snapshot was taken before the drain landed). All three lived in the MODULE —
// in how it composes `sdkStop`, `sdkWake`, `readInbox` and `releaseInboxBlock`
// against a real file and a real session — and none of them were reachable from
// a function that takes a plain object and returns a verdict.
//
// A 293-line module that performs a DESTRUCTIVE act (`sdkStop` calls
// `session.q.interrupt()`) with no test that imports it is the gap. This closes
// it.
//
// ── Why it runs the module in a SUBPROCESS ──────────────────────────────────
//
// `session-watchdog.ts` transitively pulls in `./platform`, `./store` and
// `agent-sdk.ts`, which need Electron plus a module-resolution hook for the
// `./platform` DIRECTORY import and the extensionless relative imports. The
// repo already ships that hook (`scripts/.r2-register.mjs`) and already drives
// the real modules through it (`scripts/e2e-r2-repro.mjs`). Importing this
// module bare under `node --test` fails with ERR_MODULE_NOT_FOUND — verified,
// which is exactly why the naive version of this test could not exist. So the
// rig runs as a child process and this file asserts on its JSON verdict.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RIG = path.join(REPO, 'scripts', 'e2e-session-wedge-redelivery.mjs');
const REGISTER = path.join(REPO, 'scripts', '.r2-register.mjs');

function runArm(arm: string): Record<string, unknown> {
  const out = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--import', REGISTER, RIG, arm],
    {
      encoding: 'utf8',
      timeout: 120_000,
      cwd: REPO,
      env: { ...process.env, WEDGE_HOME: `/tmp/wedge90-unit-${arm}-${process.pid}` },
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  const line = out.trim().split('\n').filter(Boolean).pop();
  // An EMPTY result must never read as a pass. A rig that crashed prints
  // nothing, and `JSON.parse(undefined)` throwing here is the intended loud
  // failure rather than a silent green.
  assert.ok(line, `arm ${arm} produced no output — the rig did not run`);
  return JSON.parse(line) as Record<string, unknown>;
}

test('the rig and its register hook actually exist', () => {
  // Guards the whole file: if either path moves, every test below would
  // otherwise fail with an opaque spawn error rather than naming the cause.
  assert.ok(fs.existsSync(RIG), `${RIG} missing`);
  assert.ok(fs.existsSync(REGISTER), `${REGISTER} missing`);
});

test('recycleSession delivers every parked message EXACTLY ONCE', () => {
  // Drives the real `recycleSession` against a real inbox file on disk, with
  // the real `releaseInboxBlock`. This is the R2 promise.
  const r = runArm('exactly_once') as {
    ok: boolean;
    counts: Record<string, number>;
    duplicates: string[];
    remainingAfter: number;
  };
  assert.deepEqual(r.duplicates, [], 'no message may be delivered twice');
  assert.deepEqual(
    r.counts,
    { 'PARKED-ALPHA': 1, 'PARKED-BRAVO': 1, 'PARKED-CHARLIE': 1 },
    'each parked message exactly once',
  );
  assert.equal(r.remainingAfter, 0, 'the inbox is empty once all three are delivered');
  assert.equal(r.ok, true);
});

test('NEGATIVE ARM: when no turn starts, NOTHING is removed from the inbox', () => {
  // The instrument audit. Without this, "remainingAfter: 0" above could not be
  // distinguished from a rig that simply deletes the file — and the whole
  // exactly-once claim would rest on an unaudited zero.
  const r = runArm('control_nodeliver') as {
    ok: boolean;
    counts: Record<string, number>;
    remainingAfter: number;
  };
  assert.equal(r.remainingAfter, 3, 'every block survives an unconfirmed delivery');
  assert.deepEqual(
    r.counts,
    { 'PARKED-ALPHA': 0, 'PARKED-BRAVO': 0, 'PARKED-CHARLIE': 0 },
    'nothing is delivered when the session never starts a turn',
  );
  assert.equal(r.ok, true);
});

test('R2 RESIDUAL: a hook drain racing the release loop still delivers once', () => {
  // The defect review found on the FIRST fix: the wake turn's UserPromptSubmit
  // hook drains the inbox asynchronously, and step 4's `for…of readInbox()`
  // took ONE snapshot before that drain landed — so a block the hook was about
  // to show the agent was ALSO released. Measured 3/3 deterministic before the
  // fix (PARKED-ALPHA delivered twice, remaining 0); this arm reproduces that
  // race and now observes the DUPLICATE directly rather than inferring it.
  const r = runArm('hook_drain_race') as {
    ok: boolean;
    counts: Record<string, number>;
    duplicates: string[];
  };
  assert.deepEqual(
    r.duplicates,
    [],
    'the hook drain and the release loop must not both deliver the same block',
  );
  assert.deepEqual(r.counts, {
    'PARKED-ALPHA': 1,
    'PARKED-BRAVO': 1,
    'PARKED-CHARLIE': 1,
  });
  assert.equal(r.ok, true);
});

// ── SOURCE-BINDING GUARDS ───────────────────────────────────────────────────
//
// The subprocess arms above prove BEHAVIOUR. These pin the two structural
// properties that behaviour depends on, so a refactor that quietly reintroduces
// a reviewed defect fails here with a NAME rather than as a flaky race. Both
// strip comments first: prose about the old design must not satisfy a check
// about the code.

function sourceOf(file: string): string {
  return fs
    .readFileSync(path.join(REPO, 'src', 'main', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

test('R2 guard: the wake prompt carries NO parked message content', () => {
  const src = sourceOf('session-watchdog.ts');
  // The reviewed defect was `sdkWake(wsId, parked[0].text)` — waking with a
  // parked body delivers it while its block stays on disk for the hook to
  // re-deliver.
  assert.match(src, /sdkWake\(wsId,\s*WAKE_PROMPT\)/, 'wake must use the neutral prompt');
  assert.doesNotMatch(src, /sdkWake\([^)]*parked\[/, 'wake must not carry a parked body');
  // Positive control: the isolation worked and we are reading real code.
  assert.match(src, /releaseInboxBlock/, 'control: the release path is present in this file');
});

test('R2-residual guard: the inbox is re-read INSIDE the release loop', () => {
  const src = sourceOf('session-watchdog.ts');
  // `for (const block of readInbox(wsId))` evaluates its iterable ONCE, so the
  // snapshot predates the wake turn's hook drain and a block gets delivered
  // twice (measured 3/3 before the fix). The loop must read per iteration.
  assert.doesNotMatch(
    src,
    /for\s*\(\s*const\s+\w+\s+of\s+readInbox\(/,
    'a for…of over readInbox() takes ONE snapshot — that is the residual defect',
  );
  assert.match(src, /INBOX_DRAIN_GRACE_MS/, 'the drain must be given a chance to land first');
});

test('R1 guard: the recycle decision is fed live progress evidence', () => {
  const src = sourceOf('session-watchdog.ts');
  // R1: the destructive path must not rely on #88's `status` guard alone. It
  // must receive the REAL-STREAM clock (issue #174 clock-pollution), never
  // `lastStreamAt` (which a turn-arm resets) — otherwise a boot-wedge verdict is
  // refused HERE by a wake-delivery arm it should ignore.
  assert.match(
    src,
    /lastStreamAt:\s*progress\?\.lastStreamMessageAt/,
    'decideSessionRecycle must receive the REAL-STREAM stamp (lastStreamMessageAt)',
  );
  assert.doesNotMatch(
    src,
    /lastStreamAt:\s*progress\?\.lastStreamAt\b/,
    'must NOT feed the turn-arm-polluted lastStreamAt to the destructive recycle refusal (#174)',
  );
});

test('#174 clock-pollution: decideBootWedge keys on the REAL-STREAM clock, never the turn-arm one', () => {
  const src = sourceOf('session-watchdog.ts');
  // The whole fix: the boot-wedge silence window must key on lastStreamMessageAt
  // (bumped only by a real stream message in consume()) — NOT lastStreamAt, which
  // promptStream re-bumps at turn-ARM, so repeated bus-wake deliveries would hold
  // the window open forever and the wedge would never self-heal (field: ws
  // 1a9ffb75 + ba1040aa, repeated wake, zero heal). must-FAIL arm: a reversion to
  // `lastStreamAt: progress.lastStreamAt` in the decideBootWedge call reddens.
  const bootWedgeCall = src.slice(src.indexOf('decideBootWedge({'));
  assert.match(
    bootWedgeCall.slice(0, 400),
    /lastStreamAt:\s*progress\.lastStreamMessageAt/,
    'decideBootWedge must be fed progress.lastStreamMessageAt, not the polluted lastStreamAt',
  );
  assert.doesNotMatch(
    bootWedgeCall.slice(0, 400),
    /lastStreamAt:\s*progress\.lastStreamAt\b/,
    'decideBootWedge must NOT read the turn-arm-polluted lastStreamAt (#174 clock-pollution)',
  );
});

test('#180/#174 wiring: decideSessionRecycle gets BOOT_SILENCE_MS on the boot path, 10-min on the stall path', () => {
  const src = sourceOf('session-watchdog.ts');
  // The masking fix (OPS BLOCKING finding): decideBootWedge fires at 3 min but
  // decideSessionRecycle's own progress refusal would default to 10 min and
  // REFUSE the boot recycle until 10 — masking #180's heal (Gate #4). The window
  // passed to decideSessionRecycle must be CONDITIONAL on the recycle being a
  // boot wedge (and NOT a #88 stall). must-FAIL arm: dropping the conditional
  // (a bare `silenceMs: BOOT_SILENCE_MS` OR no silenceMs at all in the
  // decideSessionRecycle call) reddens here.
  const recycleCall = src.slice(src.indexOf('decideSessionRecycle({'));
  // F4: the window must key on `bootWedge` PRESENCE, not `recycleReason === 'boot-wedge'`
  // (≡ bootWedge && !stalled), which re-masked the boot+stall co-fire back to 10 min.
  assert.match(
    recycleCall.slice(0, 500),
    /silenceMs:\s*bootWedge\s*\?\s*BOOT_SILENCE_MS\s*:\s*GATE_SILENCE_RELEASE_MS/,
    'the recycle window must be BOOT_SILENCE_MS whenever a boot wedge is PRESENT (F4), else GATE_SILENCE_RELEASE_MS',
  );
  // must-FAIL arm: the old `recycleReason === 'boot-wedge'` gate re-masks the
  // co-fire — it must be GONE from the silenceMs choice.
  assert.doesNotMatch(
    recycleCall.slice(0, 500),
    /silenceMs:\s*recycleReason === 'boot-wedge'/,
    'the window must NOT gate on recycleReason (bootWedge && !stalled) — that re-masks the co-fire (F4)',
  );
  // The stall side must be explicitly the 10-min constant — a mutant that used
  // BOOT_SILENCE_MS on both sides (shrinking the stall window) reddens.
  assert.match(
    recycleCall.slice(0, 500),
    /:\s*GATE_SILENCE_RELEASE_MS/,
    'the non-boot (stall) branch must keep the 10-min GATE_SILENCE_RELEASE_MS — no stall-window regression',
  );
});

// ── Issue #174: the boot wedge is detected AND its opening prompt re-delivered ─
//
// The pure detector (`decideBootWedge`) is mutation-proven in
// src/shared/session-wedge.test.ts. What lives ONLY in this module — and is
// therefore what these source-binding guards pin — is the WIRING: that
// `watchdogTick` feeds a boot-wedge verdict into the same `decideSessionRecycle`,
// and that `recycleSession` re-delivers the opening prompt through
// `recoverPendingPrompts` (the boot-wedge prompt is in `sdkPendingPrompts`, NOT
// the inbox the pre-#174 recycle read). A refactor that dropped either half would
// silently reopen the exact double-lock the ticket closes, so each is pinned with
// a NAME. The end-to-end behaviour is driven by the scratch rig at report time;
// these guards are the committed catchers.

test('#174 guard: watchdogTick feeds a boot-wedge verdict into the recycle decision', () => {
  const src = sourceOf('session-watchdog.ts');
  // The detector must be called with the live proof-of-life evidence, and its
  // verdict must reach decideSessionRecycle's `stalled` input (via `?? bootWedge`)
  // so it inherits the anti-flap/backoff/progress machinery.
  assert.match(src, /decideBootWedge\(/, 'the boot-wedge detector must be invoked');
  assert.match(
    src,
    /firstMessageSeen:\s*progress\.firstMessageSeen/,
    'the detector must be fed the live proof-of-life evidence, not a guess',
  );
  assert.match(
    src,
    /stalled:\s*stalled\s*\?\?\s*bootWedge/,
    'the boot-wedge verdict must feed the SAME decideSessionRecycle as a #88 stall',
  );
});

// ── Issue #180: the BOOT call site overrides silenceMs to BOOT_SILENCE_MS ─────
//
// #180's ONE behaviour change lives ENTIRELY at this call site: `decideBootWedge`
// defaults to the 10-min GATE_SILENCE_RELEASE_MS, and the watchdog must OVERRIDE
// it with the shorter BOOT_SILENCE_MS (3 min) so a never-started session heals 3x
// sooner. A source regex alone is fragile (it passes on `silenceMs: SOME_OTHER`),
// so this pairs a source guard with a BEHAVIOURAL arm that resolves the actual
// argument the call site passes and drives the real detector with it.

test('#180 guard: the boot-wedge call site overrides silenceMs with BOOT_SILENCE_MS', () => {
  const src = sourceOf('session-watchdog.ts');
  // The override must be present AND must be the boot constant — not the 10-min
  // default (which is what dropping the line reverts to) and not some other value.
  assert.match(
    src,
    /silenceMs:\s*BOOT_SILENCE_MS/,
    'the BOOT case must pass its own shorter window, not inherit the 10-min default',
  );
  // And the constant must actually be imported into this module, or the line
  // above would be a reference error the bundler would reject.
  assert.match(
    src,
    /\bBOOT_SILENCE_MS\b[\s\S]*from\s+['"]\.\.\/shared\/session-wedge\.ts['"]/,
    'BOOT_SILENCE_MS must be imported from the shared policy module',
  );
});

test('#180 behavioural arm: the overridden window makes a 3-min boot wedge fire where the default would NOT', () => {
  // This is the arm that REDDENS IF THE OVERRIDE IS DROPPED. It extracts the
  // silenceMs expression the call site actually passes, resolves it to a number,
  // and drives the REAL decideBootWedge with it against a never-started session
  // silent for 3min+1ms. With the override (BOOT_SILENCE_MS = 180_000) the detector
  // wedges; revert the call site to the default and the SAME 3min+1ms silence is
  // under the 10-min window → null. The pair below proves the value doing the work
  // is genuinely the shorter one, asserted against the literal 180_000.
  const src = sourceOf('session-watchdog.ts');
  const m = src.match(/decideBootWedge\(\{[\s\S]*?silenceMs:\s*([A-Za-z0-9_]+)[\s\S]*?\}\)/);
  assert.ok(m, 'could not find a silenceMs argument at the decideBootWedge call site — the override is missing');
  const passed = m![1];
  // Resolve the identifier the call site passes to its real runtime value. Only
  // the two policy constants are legitimate here; anything else is a defect.
  const resolved =
    passed === 'BOOT_SILENCE_MS'
      ? BOOT_SILENCE_MS
      : passed === 'GATE_SILENCE_RELEASE_MS'
        ? GATE_SILENCE_RELEASE_MS
        : NaN;
  assert.ok(
    Number.isFinite(resolved),
    `the call site passes an unrecognised silenceMs (${passed}); expected BOOT_SILENCE_MS`,
  );
  assert.equal(resolved, 180_000, 'the resolved boot window must be 3 minutes (180_000 ms)');

  const NOW = 1_800_000_000_000;
  const neverStarted = {
    sessionLive: true,
    firstMessageSeen: false,
    turnInFlight: true,
    pendingPromptCount: 1,
    lastStreamAt: NOW - 180_000 - 1, // silent 3 min + 1 ms since spawn
    stopping: false,
    now: NOW,
  };
  // WIRED value → wedged at 3 min.
  assert.ok(
    decideBootWedge({ ...neverStarted, silenceMs: resolved }),
    'with the wired BOOT_SILENCE_MS the session is boot-wedged at 3min+1ms',
  );
  // MUTANT: the dropped-override world (10-min default) → NOT wedged at the same
  // 3min+1ms. This is exactly what reverting the call-site line produces.
  assert.equal(
    decideBootWedge({ ...neverStarted, silenceMs: GATE_SILENCE_RELEASE_MS }),
    null,
    'the 10-min default would NOT wedge at 3min+1ms — so dropping the override reddens this arm',
  );
});

test('#174 guard: recycleSession re-delivers the opening prompt via recoverPendingPrompts', () => {
  const src = sourceOf('session-watchdog.ts');
  // The heal for the boot wedge: the opening prompt lives in sdkPendingPrompts,
  // which the inbox-only recycle never touched. recoverPendingPrompts is the
  // existing honest re-delivery — it must be called on the recycle path.
  assert.match(
    src,
    /recoverPendingPrompts\(wsId,\s*\[\]\)/,
    'recycle must re-send pending opening prompts (empty history = nothing consumed)',
  );
  // And it must be GATED on there actually being a pending prompt, so an ordinary
  // stall recycle (inbox mail, no pending prompt) is unaffected.
  assert.match(
    src,
    /normalizePendingPromptCount\(wsId\)\s*>\s*0/,
    'opening-prompt recovery must be gated on a pending prompt existing',
  );
  // The neutral WAKE_PROMPT must be SKIPPED when the opening-prompt recovery
  // already started the session, or the fresh session gets a redundant turn.
  assert.match(
    src,
    /if\s*\(\s*!sdkSessionLive\(wsId\)\s*\)/,
    'the neutral wake must be skipped when recovery already brought the session up',
  );
});

test('F1 guard: the flap-limit surface is edge-triggered and re-arms on recovery', () => {
  const src = sourceOf('session-watchdog.ts');
  // The surface must be gated on a once-set (`stoodDown`) so it fires on the
  // transition, not every tick. The behaviour is proven by the exactly-once
  // count arm below; this pins the two structural halves so a refactor that
  // dropped either fails with a NAME.
  assert.match(src, /if\s*\(\s*!stoodDown\.has\(ws\.id\)\s*\)/, 'surface must be gated on the once-set');
  assert.match(src, /stoodDown\.add\(ws\.id\)/, 'the transition must mark the ws stood-down');
  // ...and it must CLEAR when the ws is no longer at flap-limit, or the surface
  // never re-arms after a recovery (a permanently silenced stand-down).
  assert.match(
    src,
    /decision\.action\s*!==\s*'flap-limit'\).*stoodDown\.delete\(ws\.id\)/s,
    'the once-set must clear on any non-flap-limit decision so recovery re-arms it',
  );
});

// ── Issue #97: flap-limit SURFACE + widening BACKOFF, driven end-to-end ──────
//
// The pure-policy tests in session-wedge.test.ts prove decideSessionRecycle
// returns `backoff`/`flap-limit`, but they are STRUCTURALLY BLIND to whether the
// MODULE actually spaces its real recycles and emits a human surface — that
// lives in `watchdogTick` composing the real `decideSessionRecycle`,
// `platform.broadcast` and `platform.notify` against a real store and a live
// session. The flap-budget rig drives 14 real ticks and reports what the module
// actually did; this test asserts on that JSON. Same subprocess pattern and
// reasoning as the R2 arms above (the module can't be imported bare under the
// strip-types runner — it pulls in `./platform` as a directory import).

const FLAP_RIG = path.join(REPO, 'scripts', 'wedge90-rigs', 'flap-budget.mjs');

test('flap rig and its register hook exist', () => {
  assert.ok(fs.existsSync(FLAP_RIG), `${FLAP_RIG} missing`);
});

test('#97: recycles WIDEN and the stand-down SURFACES to a human', () => {
  const out = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--import', REGISTER, FLAP_RIG],
    {
      encoding: 'utf8',
      timeout: 120_000,
      cwd: REPO,
      env: { ...process.env, FLAP_HOME: `/tmp/flap97-unit-${process.pid}` },
      // stderr carries the rig's VACUITY/SURFACE guards; keep it off the parsed
      // channel but let the JSON come through stdout.
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  // The flap rig prints ONE pretty-printed JSON object on stdout (stderr, which
  // carries the MODULE_TYPELESS warning and the rig's guards, is discarded
  // above). Parse the whole stdout, not the last line — the object spans lines.
  const text = out.trim();
  assert.ok(text, 'the flap rig produced no output — it did not run');
  const r = JSON.parse(text) as {
    totalRecycles: number;
    recycleTicks: number[];
    backoffGaps: number[];
    backoffSpaced: boolean;
    flapLimitTick: number | null;
    overBudgetTicks: number;
    flapBroadcastCount: number;
    flapNotifyCount: number;
    flapBroadcast: boolean;
    flapNotify: boolean;
    surfacedChannels: string[];
  };

  // G4 — the widening backoff, as an OBSERVED DIFFERENCE: the pre-#97 build
  // recycles on consecutive ticks [0,1,2]; this build spaces them as the
  // interval doubles (measured [0,2,6], gaps [2,4]). Assert the spacing, not a
  // flag the module could set without acting.
  assert.equal(r.totalRecycles, 3, 'the full budget is still spent (3/hour)');
  assert.ok(r.backoffSpaced, `recycles must NOT be back-to-back — gaps were ${JSON.stringify(r.backoffGaps)}`);
  assert.ok(
    r.backoffGaps.some((g) => g > 1),
    'at least one inter-recycle gap must widen past a single tick (the backoff)',
  );
  // The gaps must be non-decreasing — a widening interval, not a random one.
  for (let i = 1; i < r.backoffGaps.length; i++) {
    assert.ok(
      r.backoffGaps[i] >= r.backoffGaps[i - 1],
      `gap ${i} (${r.backoffGaps[i]}) must be >= gap ${i - 1} (${r.backoffGaps[i - 1]})`,
    );
  }

  // G3 — the surface. On the unfixed build surfacedChannels is ONLY
  // `workspace:update` and the counts are 0 (the measured defect). Require BOTH
  // the in-app broadcast and the OS notify.
  assert.equal(r.flapBroadcast, true, 'flap-limit must emit the watchdog:flap-limit broadcast');
  assert.equal(r.flapNotify, true, 'flap-limit must emit an OS notify()');
  assert.ok(typeof r.flapLimitTick === 'number', 'the stand-down must actually fire within the run');
  assert.ok(
    r.surfacedChannels.includes('watchdog:flap-limit') && r.surfacedChannels.includes('NOTIFY'),
    `human surface missing — surfacedChannels was ${JSON.stringify(r.surfacedChannels)}`,
  );

  // review F1/F2 — the surface is EDGE-triggered, asserted as a COUNT not a
  // boolean. The flap-limit CONDITION holds for `overBudgetTicks` (>= 7 here),
  // but the human surface must fire EXACTLY ONCE — a boolean `true` is identical
  // for "once" and "storm", which is exactly how the first cut's un-guarded
  // ~54-toasts/hr regression stayed green. must-FAIL: the un-guarded build fires
  // `flapBroadcastCount === flapNotifyCount === overBudgetTicks` (measured 7/7).
  assert.ok(r.overBudgetTicks >= 2, `the condition must hold for multiple ticks to make the once-guard meaningful (was ${r.overBudgetTicks})`);
  assert.equal(
    r.flapBroadcastCount,
    1,
    `the broadcast must fire ONCE across ${r.overBudgetTicks} over-budget ticks, not per tick (was ${r.flapBroadcastCount} — a storm)`,
  );
  assert.equal(
    r.flapNotifyCount,
    1,
    `the OS notify must fire ONCE across ${r.overBudgetTicks} over-budget ticks, not per tick (was ${r.flapNotifyCount} — a toast storm)`,
  );
});
