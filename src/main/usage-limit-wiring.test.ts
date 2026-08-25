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

test('GUARD: the driver clears the marker before waking (idempotence)', () => {
  const code = codeOf(PROMPT_QUEUE);
  const driver = code.indexOf('async function resumeUsageLimited(');
  const body = code.slice(driver, driver + 2500);
  // SCOPE THE SLICE TO THE NUDGE BRANCH FIRST. Found by mutation (W5): there
  // are TWO clearStopReason calls — one in the `queue` branch, one in the
  // nudge path — so a whole-body `indexOf('clearStopReason')` always finds the
  // queue one, which precedes the wake no matter where the nudge's clear sits.
  // The guard passed with the nudge clear moved AFTER the wake, i.e. it was
  // vacuous for exactly the defect it names. Isolate the branch, then assert.
  // Anchor on the queue branch's own clear, then take everything after it —
  // anchoring on a bare `continue;` picks up the earlier `action === 'wait'`
  // one instead (the control below caught exactly that mistake).
  const queueClear = body.indexOf('clearStopReason');
  assert.notEqual(queueClear, -1, 'expected the queue branch to clear the marker');
  const nudgeBranch = body.slice(queueClear + 'clearStopReason'.length);
  // Control: the isolation actually dropped the queue branch's call and kept a
  // real slice — without this, an over-eager slice would make the assertions
  // below pass on an empty string.
  assert.ok(nudgeBranch.length > 200, 'the nudge-branch slice came back suspiciously short');
  assert.equal(
    (nudgeBranch.match(/clearStopReason/g) ?? []).length,
    1,
    'control: the nudge branch must contain exactly the ONE clear this test is about',
  );

  const clearAt = nudgeBranch.indexOf('clearStopReason');
  const wakeAt = nudgeBranch.indexOf('wakeAgentWithPrompt');
  assert.notEqual(clearAt, -1, 'the nudge path must clear the marker');
  assert.notEqual(wakeAt, -1, 'the nudge path must wake the agent');
  // A marker left in place makes every subsequent 20s tick decide to resume
  // again — a nudge storm. Clearing first also means a wake slower than one
  // tick cannot be started twice (same ordering flushQueuedPrompts uses).
  assert.ok(
    clearAt < wakeAt,
    'the marker must be cleared BEFORE the wake, or a slow wake is started on every tick',
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
