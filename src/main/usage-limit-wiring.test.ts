import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ─── Issue #74: the WIRING of usage-limit auto-resume ───────────────────────
//
// The POLICY is unit-tested in src/shared/usage-resume.test.ts, executed
// directly and mutation-proven. This file guards the seams that policy cannot
// reach — the places where a correct decision function is connected to the
// wrong thing, in the wrong order, or not at all. Those are exactly the
// failures a passing policy test says nothing about.
//
// Structural source guards rather than an executed model, and deliberately so:
// `emitFrom` and the flusher tick live inside Electron-bound modules that
// cannot be imported under `node --test`. The tradeoff is stated openly — a
// source guard proves the code is SHAPED correctly, not that it RUNS correctly,
// so each one below names the specific defect it would catch. The end-to-end
// behaviour is listed as NOT VERIFIED in the PR body rather than implied here.
//
// Every guard reads comment-STRIPPED source, so a comment describing the
// design can never satisfy a check about the code.

const ROOT = process.cwd(); // pnpm test runs from the repo root
const AGENT_SDK = path.join(ROOT, 'src', 'main', 'agent-sdk.ts');
const ACTIVITY = path.join(ROOT, 'src', 'main', 'activity.ts');
const PROMPT_QUEUE = path.join(ROOT, 'src', 'main', 'prompt-queue.ts');
const AGENT_EVENTS = path.join(ROOT, 'src', 'shared', 'agent-events.ts');

/** Source with line/block-comment lines stripped, so prose ABOUT a design
 *  cannot satisfy a structural code check. Mirrors the helper in
 *  max-turns-surfacing.test.ts (same rationale, same shape). */
function codeOf(file: string): string {
  const raw = fs.readFileSync(file, 'utf8');
  const stripped = raw
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
  assert.ok(stripped.length > 2_000, `comment-stripping ${path.basename(file)} returned too little`);
  return stripped;
}

/** `emitFrom`'s body — where the per-event work happens. */
function emitFromBody(code: string): string {
  const start = code.indexOf('function emitFrom(');
  assert.notEqual(start, -1, 'emitFrom() not found in agent-sdk.ts — was it renamed?');
  const rest = code.slice(start);
  const end = rest.indexOf('\nfunction ', 1);
  const body = end === -1 ? rest : rest.slice(0, end);
  // Positive control: the slice really IS emitFrom, not an empty string that
  // would make every assertion below pass for free.
  assert.ok(body.length > 500, 'the emitFrom slice came back suspiciously short');
  assert.match(body, /driveStatusFromEvent\(session, ev\)/, 'the emitFrom slice looks wrong');
  return body;
}

// ─── Detection is STRUCTURAL, never the error prose ─────────────────────────

test('GUARD: the limit is detected from the `rejected` FLAG, never from notice text', () => {
  const body = emitFromBody(codeOf(AGENT_SDK));
  // The rule #74 states absolutely. The two rate-limit notices differ only by
  // their prose ("Usage limit reached" vs "Approaching usage limit"), so a
  // text match would (a) break silently when the copy is reworded and (b) pause
  // healthy sessions sitting at 80% usage.
  assert.match(
    body,
    /ev\.kind === 'rate-limit' && ev\.rejected === true/,
    'the latch must key on the structural `rejected` bit',
  );
  // The negative half, and the one that actually enforces the rule: no branch
  // in emitFrom may match the notice COPY. Asserted with a control below so a
  // typo in these patterns cannot make the check vacuous.
  assert.doesNotMatch(body, /Usage limit reached/, 'must not match the notice prose');
  assert.doesNotMatch(body, /Approaching usage limit/, 'must not match the warning prose');
  // Control: the absence assertions above are being applied to real content —
  // a string that IS present in this slice must be found by the same method.
  assert.match(body, /rate-limit/, 'control: the slice really does contain the notice kind');
});

test('GUARD: both producers set the structural `rejected` flag', () => {
  const code = codeOf(AGENT_EVENTS);
  // Two independent producers: the SDK rate_limit_event and the 429 turn
  // result (ledger D2). If either omits the flag, that entire detection path
  // goes silently dead — the feature still "works" in tests while missing the
  // exact shape that motivated the ticket.
  const hits = code.match(/rejected: true/g) ?? [];
  assert.equal(
    hits.length,
    2,
    `expected exactly 2 producers to set rejected:true, found ${hits.length} — ` +
      'the SDK rate_limit_event path and the 429 classifyTurnError path',
  );
  // The allowed_warning branch must NOT set it: that notice means "you are at
  // 80%", and pausing on it would freeze healthy agents.
  const warnAt = code.indexOf("info.status === 'allowed_warning'");
  assert.notEqual(warnAt, -1, 'the allowed_warning branch is gone — was it renamed?');
  const warnBranch = code.slice(warnAt, warnAt + 400);
  assert.doesNotMatch(
    warnBranch,
    /rejected: true/,
    'an allowed_warning is NOT a rejection — flagging it would pause agents at 80% usage',
  );
});

// ─── The latch, and the turn-boundary reset ─────────────────────────────────

test('GUARD: a limit-killed turn is marked OUTSIDE the driveStatus gate', () => {
  const body = emitFromBody(codeOf(AGENT_SDK));
  const markAt = body.indexOf('markStoppedOnUsageLimit(');
  const gateAt = body.indexOf('driveStatusFromEvent(session, ev)');
  assert.notEqual(markAt, -1, 'emitFrom must write the usage_limit reason');
  assert.notEqual(gateAt, -1, 'emitFrom should still call driveStatusFromEvent');
  // Identical reasoning to #69's guard: driveStatusFromEvent is gated on
  // session.driveStatus, TRUE only when a terminal PTY coexists. In the plain
  // structured-view configuration a gated write reaches nobody — measured, and
  // the whole bug #69 reported. #74 inherits that hazard exactly.
  assert.ok(
    markAt < gateAt,
    'the usage_limit write must not depend on driveStatusFromEvent — in the no-PTY ' +
      'configuration the reason (and therefore auto-resume itself) would never fire',
  );
});

test('GUARD: the latch is cleared at EVERY turn boundary', () => {
  const body = emitFromBody(codeOf(AGENT_SDK));
  // Without an unconditional clear, a rejection latched on one turn survives
  // into later ones and marks a perfectly healthy turn as limit-killed — which
  // auto-resumes a session nobody stopped. The clear must not sit inside the
  // marking branch, or it only runs on the path that already acted.
  assert.match(
    body,
    /if \(ev\.type === 'turn-end'\) session\.rateLimitHit = undefined;/,
    'the latch must be cleared on every turn-end, not only when it fired',
  );
});

test('GUARD: marking requires the turn to have actually ERRORED', () => {
  const body = emitFromBody(codeOf(AGENT_SDK));
  const at = body.indexOf('markStoppedOnUsageLimit(');
  const branch = body.slice(Math.max(0, at - 400), at);
  // A turn that hit the limit, was retried by the CLI and still completed is
  // NOT a stopped session. Marking it would pause — and then auto-resume — an
  // agent that never stopped.
  assert.match(branch, /ev\.isError/, 'the mark must require an errored turn-end');
  // And it must not double-report a max_turns death as a usage limit.
  assert.match(branch, /ev\.stopReason !== 'max_turns'/, 'must stay exclusive with max_turns');
});

// ─── The store seam ─────────────────────────────────────────────────────────

test('GUARD: markStoppedOnUsageLimit records the reason without changing the status', () => {
  const code = codeOf(ACTIVITY);
  const start = code.indexOf('export async function markStoppedOnUsageLimit(');
  assert.notEqual(start, -1, 'markStoppedOnUsageLimit() not found in activity.ts');
  const body = code.slice(start, start + 1200);
  assert.match(
    body,
    /setStatus\(id, 'idle', 'usage_limit'\)/,
    "must record 'usage_limit' — a stopped session is idle, and the REASON is the " +
      'orthogonal axis (never a new WorkspaceStatus)',
  );
  // The stale-reset hazard: a limit reported WITHOUT a reset time must clear
  // any previous one. An inherited past timestamp reads as "already reset", so
  // the driver would resume instantly, straight back into the wall.
  assert.match(
    body,
    /usageLimitResetsAt: undefined/,
    'a limit with no reset time must CLEAR the previous one, not inherit it',
  );
});

test('GUARD: clearStopReason only ever clears a usage_limit marker', () => {
  const code = codeOf(ACTIVITY);
  const start = code.indexOf('export async function clearStopReason(');
  assert.notEqual(start, -1, 'clearStopReason() not found in activity.ts');
  const body = code.slice(start, start + 900);
  // Clearing indiscriminately would drop a max_turns/error marker the human
  // still needs — resurrecting the #69 bug this machinery exists to fix.
  assert.match(
    body,
    /lastStopReason !== 'usage_limit'/,
    'must refuse to clear a marker set for a different reason',
  );
});

// ─── The driver, and the precedence that makes it correct ───────────────────

test('GUARD: the resume driver runs BEFORE the queue loop, coordinators first', () => {
  const code = codeOf(PROMPT_QUEUE);
  const start = code.indexOf('async function tick(');
  assert.notEqual(start, -1, 'tick() not found in prompt-queue.ts');
  const body = code.slice(start, start + 900);
  assert.match(body, /resumeUsageLimited\(now\)/, 'the tick must drive the resume pass');

  const driver = code.indexOf('async function resumeUsageLimited(');
  assert.notEqual(driver, -1, 'resumeUsageLimited() not found');
  const driverBody = code.slice(driver, driver + 2500);
  // Coordinators-first is the ordering the field incident turned on: a
  // coordinator's first act is to re-read its ledger and re-dispatch, so it
  // must be up before its children start asking it for work.
  assert.match(driverBody, /isCoordinatorWorkspace/, 'must sort/gate on the coordinator role');
  assert.match(driverBody, /\.sort\(/, 'candidates must be ordered, not taken in store order');
  // Eligibility is filtered on the marker, so idle workspaces are never woken.
  assert.match(
    driverBody,
    /lastStopReason === 'usage_limit'/,
    'only limit-killed sessions may be candidates',
  );
});

test('GUARD: the driver nudges GENERICALLY and never replays the interrupted input', () => {
  const code = codeOf(PROMPT_QUEUE);
  const driver = code.indexOf('async function resumeUsageLimited(');
  const body = code.slice(driver, driver + 2500);
  // The #57 partial-execution hazard: the killed turn may have half-executed,
  // so replaying it re-runs side effects. The nudge must be the fixed
  // constant, with no interpolation of prior input.
  assert.match(
    body,
    /wakeAgentWithPrompt\(ws\.id, RESUME_NUDGE_TEXT\)/,
    'the nudge must be the shared constant, never reconstructed input',
  );
  // Nothing resembling stored prompt text may reach the wake call.
  assert.doesNotMatch(
    body,
    /wakeAgentWithPrompt\([^)]*queuedPrompts/,
    'queued prompt text must never be passed to the resume nudge',
  );
});

test('GUARD: clear before wake AND RE-MARK on failure (no permanent freeze)', () => {
  const code = codeOf(PROMPT_QUEUE);
  const driver = code.indexOf('async function resumeUsageLimited(');
  const body = code.slice(driver, driver + 4000);
  // Isolate the nudge branch: there are TWO clearStopReason calls (one in the
  // `queue` branch), so a whole-body indexOf always finds the queue one and the
  // assertion below would hold no matter where the nudge's clear sat.
  const queueClear = body.indexOf('clearStopReason');
  assert.notEqual(queueClear, -1, 'expected the queue branch to clear the marker');
  const nudgeBranch = body.slice(queueClear + 'clearStopReason'.length);
  assert.ok(nudgeBranch.length > 200, 'the nudge-branch slice came back suspiciously short');
  assert.equal(
    (nudgeBranch.match(/clearStopReason/g) ?? []).length,
    1,
    'control: the nudge branch must contain exactly the ONE clear this test is about',
  );

  const clearAt = nudgeBranch.indexOf('clearStopReason');
  const wakeAt = nudgeBranch.indexOf('wakeAgentWithPrompt');
  assert.ok(clearAt !== -1 && wakeAt !== -1, 'the nudge path must clear and wake');
  assert.ok(
    clearAt < wakeAt,
    'the marker must be cleared BEFORE the wake, or a slow wake is started on every tick',
  );

  // THE HALF THIS GUARD USED TO MISS (review-74 R1). An EARLIER version of this
  // test asserted only `clearAt < wakeAt` — and thereby PINNED THE BUG IN
  // PLACE: it demanded the early clear while saying nothing about restoring the
  // marker when the wake fails. With the marker cleared and the wake failed,
  // the workspace has left the `lastStopReason === 'usage_limit'` candidate
  // filter, so NO later tick reconsiders it: the session is frozen forever and
  // the pause glyph is gone, so nothing on screen tells a human to look.
  //
  // The ordering was borrowed from flushQueuedPrompts, which pairs it with a
  // `requeue()` compensator; this path had none. So assert the COMPENSATOR,
  // not just the ordering.
  const reMarkAt = nudgeBranch.indexOf('markStoppedOnUsageLimit');
  assert.notEqual(
    reMarkAt,
    -1,
    'the nudge path must RE-MARK on failure — without it a failed wake freezes the ' +
      'workspace permanently, which is strictly worse than not shipping auto-resume',
  );
  assert.ok(
    reMarkAt > wakeAt,
    'the re-mark must come AFTER the wake — it is the failure compensator, not a second mark',
  );
  // It must be reachable on the failure path specifically, i.e. guarded by the
  // wake's own result rather than run unconditionally.
  assert.match(
    nudgeBranch,
    /if \(woke\)/,
    'the wake result must be branched on, so the re-mark runs only when the wake failed',
  );
  // And the restored reset time must be the ORIGINAL one: minting a new one
  // would push the retry further out on every attempt.
  assert.match(
    nudgeBranch,
    /markStoppedOnUsageLimit\(ws\.id, ws\.usageLimitResetsAt/,
    'the re-mark must restore the ORIGINAL reset time, not fabricate a new one',
  );
});

test('GUARD: a queued workspace hands over to the queue instead of being nudged', () => {
  const code = codeOf(PROMPT_QUEUE);
  const driver = code.indexOf('async function resumeUsageLimited(');
  const body = code.slice(driver, driver + 2500);
  // Banner-queued prompts carry user intent and must win. The driver must
  // recognise the 'queue' verdict and stand down rather than ALSO nudging,
  // which would deliver the queue and a synthesized prompt in the same window.
  assert.match(body, /action === 'queue'/, "the driver must handle the 'queue' verdict");
  const queueAt = body.indexOf("action === 'queue'");
  const wakeAt = body.indexOf('wakeAgentWithPrompt');
  assert.ok(
    queueAt < wakeAt,
    'the queue verdict must be handled before the wake, so a queued workspace is never nudged',
  );
});

// ─── The shared predicate actually replaced the hardcoded copies ────────────

test('GUARD: no renderer site hardcodes the stop-reason allowlist any more', () => {
  // The defect this whole refactor targets: the allowlist existed in seven
  // copies, so each new reason had to be added seven times or drift silently.
  // Walk the renderer and assert the literal pair is gone.
  const rendererDir = path.join(ROOT, 'src', 'renderer');
  const offenders: string[] = [];
  let scanned = 0;
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts')) {
        scanned++;
        const src = fs.readFileSync(p, 'utf8');
        // The exact hardcoded shape: a max_turns comparison OR-ed with an
        // error comparison. The glyph's own render branch legitimately tests
        // `stopReason === 'max_turns'` to pick a SHAPE — that is not an
        // allowlist, so the pattern deliberately requires the OR-ed pair.
        if (/=== 'max_turns' \|\|[^\n]*=== 'error'/.test(src)) {
          offenders.push(path.relative(ROOT, p));
        }
      }
    }
  };
  walk(rendererDir);
  // Positive control: the walk actually read files. Without this a broken
  // path would yield an empty offender list and a triumphant green.
  assert.ok(scanned > 20, `control: expected to scan many renderer files, scanned ${scanned}`);
  assert.deepEqual(
    offenders,
    [],
    'these files still hardcode the allowlist instead of using isActionableStopReason',
  );
});

test('GUARD: the glyph surface types its prop from the shared predicate', () => {
  const glyph = fs.readFileSync(
    path.join(ROOT, 'src', 'renderer', 'components', 'WorkspaceStatusGlyph.tsx'),
    'utf8',
  );
  // Site 6 of 7. A locally-written union here silently narrows what the five
  // feeding sites may pass, which is how a new reason becomes a tsc error at
  // best and an invisible render gap at worst.
  assert.match(
    glyph,
    /stopReason\?: ActionableStopReason;/,
    'the prop must be typed from the shared union, not a local literal',
  );
});

// ─── The consumer that silently undid the whole feature ─────────────────────
//
// Found by tracing DOWNSTREAM of a guard that was itself correct, which is the
// only way this class of defect surfaces: every policy test stayed green while
// auto-resume could never fire once.
//
// The mechanism, measured on the real code rather than reasoned about: a
// limit-killed turn's own `turn-end` carries stopReason 'error' / 'end_turn' /
// undefined — NEVER 'usage_limit', which is written out-of-band by
// markStoppedOnUsageLimit from a latched rate_limit_event. fireFinished then
// runs on that same turn-end, and its #69 allowlist mapped every non-
// max_turns/error reason to `null` — i.e. CLEAR. So the marker was overwritten
// with 'error' or erased, `lastStopReason` stopped being 'usage_limit', and the
// resume driver's filter matched nothing. Feature dead, tests green.

test('GUARD: a finished turn must NOT erase a usage_limit pause marker', () => {
  const code = codeOf(ACTIVITY);
  const start = code.indexOf('function finishedStopReason(');
  assert.notEqual(
    start,
    -1,
    'finishedStopReason() not found — fireFinished must not inline the #69 allowlist, ' +
      'which clears a usage_limit marker and kills auto-resume silently',
  );
  const body = code.slice(start, start + 800);
  // The reason must survive when it arrives explicitly...
  assert.match(body, /stopReason === 'usage_limit'/, 'must record an explicit usage_limit');
  // ...AND, the load-bearing half, must be PRESERVED when the turn-end carries
  // no reason of its own — which is the actual observed shape.
  assert.match(
    body,
    /lastStopReason === 'usage_limit'/,
    'must read the CURRENT marker and preserve it rather than clearing unconditionally',
  );
  // fireFinished must route through it, not keep its own copy of the allowlist.
  const fired = code.slice(code.indexOf('function fireFinished('), code.indexOf('function fireFinished(') + 1500);
  assert.match(fired, /finishedStopReason\(id, stopReason\)/, 'fireFinished must delegate');
  assert.doesNotMatch(
    fired,
    /stopReason === 'max_turns' \|\| stopReason === 'error' \? stopReason : null/,
    'the inlined allowlist must be gone, not merely shadowed',
  );
});

// ─── review-74 R2: the session-death path must not bypass the latch ─────────

test('GUARD: the synthetic turn-end on session death also marks the limit', () => {
  const code = codeOf(AGENT_SDK);
  // consume()'s finally builds its OWN turn-end and calls emit() +
  // driveStatusFromEvent() directly — it does NOT go through emitFrom, where
  // the latch lives (emitFrom has exactly ONE call site, the stream loop).
  // So `rate_limit_event{rejected}` → subprocess dies before any `result`
  // would never be marked, never resumed: it satisfies every other gate in
  // the feature and simply never reaches them. Plausibly the ACTUAL wave-6
  // shape (the coordinator's CLI exited rather than returning a result).
  // Anchor on the EMIT, not on driveStatusFromEvent: the mark is inserted
  // BETWEEN them, so a window starting at the latter cannot contain it.
  const at = code.indexOf('emit(session.wsId, turnEnd)');
  assert.notEqual(at, -1, 'the synthetic turn-end path is gone — was it renamed?');
  const branch = code.slice(at, at + 700);
  // Control: the slice really spans this path, so the assertions below are not
  // being applied to some unrelated region of the file.
  assert.match(branch, /driveStatusFromEvent\(session, turnEnd\)/,
    'control: the slice must reach the status drive that closes this path');
  assert.match(
    branch,
    /markStoppedOnUsageLimit\(session\.wsId, session\.rateLimitHit\.resetsAtMs\)/,
    'the session-death path must mark a latched limit, or detection misses the ' +
      'die-before-result shape entirely',
  );
  // A user-requested interrupt is not a limit death; auto-resuming it would
  // restart a session the human just stopped.
  assert.match(branch, /!endedByInterrupt/, 'an interrupted session must NOT be marked');
  // And the latch must be cleared here too, or it leaks past this teardown.
  assert.match(branch, /session\.rateLimitHit = undefined/, 'the latch must be cleared');
});

test('GUARD: emitFrom still has exactly one call site (the R2 premise)', () => {
  const code = codeOf(AGENT_SDK);
  // R2 exists BECAUSE emitFrom is called from only the stream loop. If a second
  // call site appears, the reasoning above needs re-deriving rather than
  // silently continuing to hold. Definition + one call = 2 occurrences.
  const hits = (code.match(/emitFrom\(/g) ?? []).length;
  assert.equal(hits, 2, `expected defn + 1 call site, found ${hits} occurrences of emitFrom(`);
});

// ─── the interrupted gap (found while settling R3) ──────────────────────────

test('GUARD: an INTERRUPTED turn is never marked as a usage limit', () => {
  const body = emitFromBody(codeOf(AGENT_SDK));
  const at = body.indexOf('markStoppedOnUsageLimit(');
  const branch = body.slice(Math.max(0, at - 500), at);
  // Enumerating the reachable (stopReason, isError) pairs while settling R3
  // showed `error_during_execution` normalizes to ('interrupted', true) — which
  // the original gate ADMITTED, because it excluded only max_turns. A user who
  // hits the limit and then interrupts would have their session marked and
  // auto-resumed against their explicit stop.
  assert.match(
    branch,
    /ev\.stopReason !== 'interrupted'/,
    'the gate must exclude interrupted turns, not only max_turns',
  );
});

// ─── review-74 R4 / R5 ─────────────────────────────────────────────────────

test('GUARD: a repeat limit death refreshes lastStopReasonAt', () => {
  const code = codeOf(ACTIVITY);
  const start = code.indexOf('export async function markStoppedOnUsageLimit(');
  const body = code.slice(start, start + 1800);
  // A SECOND limit death on an already idle+usage_limit workspace hits
  // setStatus's no-op guard and writes nothing, so the spread would preserve
  // the FIRST death's timestamp. #74 is the first consumer to make a RESUME
  // decision from that field (it is the driver's `blockedAt`), and a stale one
  // makes canAutoFlushQueue accept a reading older than the real block —
  // resuming prematurely, straight back into the wall.
  assert.match(
    body,
    /lastStopReasonAt: Date\.now\(\)/,
    'the timestamp must be refreshed explicitly — setStatus no-ops on a repeat mark',
  );
});

test('GUARD: resumes are capped per tick (thundering-herd spread)', () => {
  const code = codeOf(PROMPT_QUEUE);
  assert.match(code, /const MAX_RESUMES_PER_TICK = \d+/, 'a per-tick cap must exist');
  const driver = code.indexOf('async function resumeUsageLimited(');
  const body = code.slice(driver, driver + 4000);
  assert.match(body, /budget/, 'the driver must consume a per-tick budget');
  // The budget must be spent by a real resume, NOT by a `wait` — otherwise a
  // fleet of not-yet-due workspaces exhausts it and starves the due ones,
  // turning a spread into a delay.
  const waitAt = body.indexOf("action === 'wait'");
  const decAt = body.indexOf('budget--');
  assert.ok(waitAt !== -1 && decAt !== -1, 'expected both the wait skip and the decrement');
  assert.ok(
    decAt > waitAt,
    'the budget must be decremented AFTER the wait skip, so a wait costs nothing',
  );
});
