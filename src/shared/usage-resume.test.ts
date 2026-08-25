import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resetsAtMsFromNotice,
  isActionableStopReason,
  ACTIONABLE_STOP_REASONS,
  decideResume,
  isCoordinatorWorkspace,
  usageLimitPausedText,
  RESUME_NUDGE_TEXT,
  type ResumeDecisionInput,
} from './usage-resume.ts';

// Auto-resume when the usage limit resets (#74). The field failure this guards:
// a coordinator died on "You've hit your session limit · resets 6pm" and the
// whole fleet froze for 75 minutes because nothing watched for the reset.
//
// Every assertion below names the clause it guards and is reachable ONLY
// through that clause — see the per-test notes. The mutation matrix that proved
// each one fails on the unfixed logic is recorded in the PR body; the tests
// most at risk of being vacuous (the unit conversion, the queue-beats-nudge
// precedence, and the unknown-reset path) each carry an explicit control.

// ─── the epoch-SECONDS → epoch-MS conversion ─────────────────────────────────
//
// THE bug this feature ships or dies on. Both units are plausible-looking
// positive integers, so a mix-up type-checks, renders, and fails silently in
// one of two directions: seconds-read-as-ms puts the reset in 1970 (resume
// instantly, back into the wall), ms-read-as-seconds puts it ~50000 years out
// (never resume). Neither throws.

test('resetsAtMsFromNotice: converts epoch SECONDS to epoch MS', () => {
  // 2026-08-25T18:00:00Z — the "resets 6pm" of the actual incident.
  const seconds = 1787680800;
  assert.equal(resetsAtMsFromNotice(seconds), 1787680800000);
  // The clause: it MULTIPLIES. A pass-through (`return resetsAtSeconds`) is the
  // likeliest wrong implementation and this is what rejects it — asserting the
  // result is 1000x the input, not merely that it is a number.
  assert.equal(resetsAtMsFromNotice(seconds), seconds * 1000);
});

test('resetsAtMsFromNotice: the converted value lands in the FUTURE, not 1970', () => {
  // The consequence assertion, stated in the units the driver actually
  // compares against. Without the *1000 this reads as 1970-01-21, i.e. already
  // past, i.e. resume immediately — the exact silent failure. This test would
  // pass a pass-through implementation only if `Date.now()` were < 1787680800,
  // which it never is; so it genuinely discriminates.
  const ms = resetsAtMsFromNotice(1787680800);
  assert.ok(ms !== null && ms > Date.parse('2026-01-01T00:00:00Z'), 'must be a 2026 date, not 1970');
});

test('resetsAtMsFromNotice: REFUSES a value already in milliseconds', () => {
  // Guards the SECONDS_CEILING clause. A caller that hands us an ms value must
  // get null (→ "reset unknown", gate on fresh usage) rather than a silent
  // second multiplication yielding a year-51000 date that never resumes.
  const alreadyMs = 1787680800000;
  assert.equal(resetsAtMsFromNotice(alreadyMs), null);
  // Control proving the ceiling is not simply rejecting everything large: a
  // value just UNDER the ceiling still converts. Without this the test above
  // would also pass a `return null` implementation.
  assert.equal(resetsAtMsFromNotice(99_999_999_999), 99_999_999_999_000);
});

test('resetsAtMsFromNotice: absent / non-finite / non-positive all mean "unknown"', () => {
  // The 429-turn-result path reports NO reset time at all, so `undefined` is a
  // routine input, not an error case. Each of these must be null so the driver
  // gates on fresh usage instead of computing a bogus clock.
  assert.equal(resetsAtMsFromNotice(undefined), null);
  assert.equal(resetsAtMsFromNotice(null), null);
  assert.equal(resetsAtMsFromNotice(Number.NaN), null);
  assert.equal(resetsAtMsFromNotice(Number.POSITIVE_INFINITY), null);
  assert.equal(resetsAtMsFromNotice(0), null);
  assert.equal(resetsAtMsFromNotice(-1), null);
});

// ─── the shared stop-reason predicate ────────────────────────────────────────

test('isActionableStopReason: accepts the three that need a marker, rejects the two that do not', () => {
  // The whole point of the predicate: `usage_limit` must be in, and the two
  // benign reasons must stay out. A clean finish and a user-requested stop are
  // not conditions anyone must act on — if they became "actionable" every
  // finished agent would grow an alarm glyph.
  assert.equal(isActionableStopReason('max_turns'), true);
  assert.equal(isActionableStopReason('error'), true);
  assert.equal(isActionableStopReason('usage_limit'), true);
  assert.equal(isActionableStopReason('end_turn'), false);
  assert.equal(isActionableStopReason('interrupted'), false);
  assert.equal(isActionableStopReason(undefined), false);
  assert.equal(isActionableStopReason(null), false);
});

test('ACTIONABLE_STOP_REASONS and the predicate cannot drift apart', () => {
  // The failure this prevents is the ORIGINAL bug: the allowlist existed in
  // (measured) seven hardcoded copies and adding an eighth was the obvious
  // move. The list and the narrowing predicate are two encodings of one fact,
  // so assert they agree — otherwise a reason added to the const would still
  // be dropped by the predicate at every call site, silently.
  for (const r of ACTIONABLE_STOP_REASONS) {
    assert.equal(isActionableStopReason(r), true, `${r} is in the list but the predicate rejects it`);
  }
  // Control: the predicate is not simply `return true`.
  assert.equal(isActionableStopReason('end_turn'), false);
});

// ─── the resume decision ─────────────────────────────────────────────────────

const base: ResumeDecisionInput = {
  lastStopReason: 'usage_limit',
  resetsAtMs: 1000,
  isCoordinator: false,
  queuedCount: 0,
  freshUsageSaysRecovered: true,
  now: 2000, // reset has passed
};
const d = (over: Partial<ResumeDecisionInput> = {}) => decideResume({ ...base, ...over });

test('decideResume: only a LIMIT-KILLED session is eligible', () => {
  // #74's explicit non-goal: never blanket-wake idle workspaces. Every other
  // input here is maximally favourable (reset passed, usage recovered, no
  // queue), so ONLY the stop-reason clause can be producing `wait` — which is
  // what makes this test reach the clause it claims to guard.
  assert.equal(d({ lastStopReason: 'end_turn' }), 'wait');
  assert.equal(d({ lastStopReason: 'max_turns' }), 'wait');
  assert.equal(d({ lastStopReason: 'error' }), 'wait');
  assert.equal(d({ lastStopReason: undefined }), 'wait');
  // Control: the identical input WITH the right reason does resume, proving the
  // `wait`s above come from the reason and not from some other guard.
  assert.equal(d(), 'nudge');
});

test('decideResume: waits until the reset time has actually PASSED', () => {
  // Guards the clock clause. `now` before the reset must wait however healthy
  // everything else looks — resuming early just burns the nudge against the
  // same wall.
  assert.equal(d({ now: 999, resetsAtMs: 1000 }), 'wait');
  // Boundary: at the reset instant it IS eligible (>=, not >).
  assert.equal(d({ now: 1000, resetsAtMs: 1000 }), 'nudge');
});

test('decideResume: an UNKNOWN reset time gates on fresh usage, never on "now"', () => {
  // The 429-turn-result arm (D2): no `resetsAt` on the wire. The tempting
  // implementation — treat null as "now" — would resume instantly, straight
  // back into the limit.
  //
  // MUST be asserted on a COORDINATOR. Found by mutation (M4): deleting the
  // null-guard entirely still produced 'wait' for a NON-coordinator, because
  // the staggering gate at clause 4 catches that case anyway — a right answer
  // from the wrong check, and the test was vacuous for a full round. The guard
  // only ever binds for a coordinator, which clause 4 exempts from the stagger.
  // That is also the exact field shape: the wave-6 coordinator was killed by a
  // 429, which reports NO reset time.
  assert.equal(
    d({ resetsAtMs: null, isCoordinator: true, freshUsageSaysRecovered: false }),
    'wait',
  );
  assert.equal(
    d({ resetsAtMs: null, isCoordinator: true, freshUsageSaysRecovered: true }),
    'nudge',
  );
  // The non-coordinator arm still asserted — it reaches the same verdict via
  // clause 4, and both routes matter.
  assert.equal(d({ resetsAtMs: null, freshUsageSaysRecovered: false }), 'wait');
  assert.equal(d({ resetsAtMs: null, freshUsageSaysRecovered: true }), 'nudge');
});

test('decideResume: banner-queued prompts WIN over the nudge', () => {
  // Queued prompts carry real user intent; the nudge is a synthesized guess.
  // Asserted for both roles — a coordinator must not be exempted from this,
  // which a `isCoordinator` check placed above the queue check would do.
  assert.equal(d({ queuedCount: 1 }), 'queue');
  assert.equal(d({ queuedCount: 5, isCoordinator: true }), 'queue');
  // Control: same inputs with an EMPTY queue take the nudge, proving the
  // `queue` verdicts above are driven by the count and not by something else.
  assert.equal(d({ queuedCount: 0 }), 'nudge');
});

test('decideResume: the queue wins even when a nudge would NOT have been allowed', () => {
  // Ordering guard. The queue check sits ABOVE the staggering gate, so a
  // non-coordinator with no fresh reading still yields `queue` rather than
  // `wait`. If the two were swapped this returns 'wait' and the user's own
  // queued prompts would sit unqueued behind a stagger that does not apply to
  // them. (The queue path re-verifies usage itself before sending.)
  assert.equal(
    d({ queuedCount: 1, isCoordinator: false, freshUsageSaysRecovered: false }),
    'queue',
  );
});

test('decideResume: COORDINATORS resume at the reset; others wait for fresh usage', () => {
  // The anti-thundering-herd stagger, and the reason the fleet unfreezes in the
  // right order: a coordinator's first act is to re-read its ledger and
  // re-dispatch, so it must be up before its children ask it anything.
  assert.equal(d({ isCoordinator: true, freshUsageSaysRecovered: false }), 'nudge');
  assert.equal(d({ isCoordinator: false, freshUsageSaysRecovered: false }), 'wait');
  // Control: the non-coordinator is not blocked forever — fresh evidence
  // releases it. Without this the line above would also pass an implementation
  // that never resumes a non-coordinator at all.
  assert.equal(d({ isCoordinator: false, freshUsageSaysRecovered: true }), 'nudge');
});

test('decideResume: a coordinator still respects the CLOCK', () => {
  // The coordinator exemption is from the STAGGER only, not from the reset
  // time. An implementation that short-circuits on `isCoordinator` before the
  // clock check would nudge into an unexpired limit.
  assert.equal(d({ isCoordinator: true, now: 999, resetsAtMs: 1000 }), 'wait');
});

test('isCoordinatorWorkspace: both routes to the coordinator role count', () => {
  // Mirrors canOrchestrate: the `orchestrator` kind AND a promoted worktree.
  // Missing the promoted case would leave a real coordinator in the staggered
  // group, resuming late — the exact ordering failure #74 is about.
  assert.equal(isCoordinatorWorkspace({ kind: 'orchestrator' }), true);
  assert.equal(isCoordinatorWorkspace({ kind: 'worktree', canOrchestrate: true }), true);
  assert.equal(isCoordinatorWorkspace({ kind: 'worktree' }), false);
  assert.equal(isCoordinatorWorkspace({ kind: 'scratch' }), false);
});

// ─── the surfaces ────────────────────────────────────────────────────────────

test('usageLimitPausedText: states the ETA when the reset time is known', () => {
  // The string #74 specifies. `formatTime` is injected so the assertion is not
  // hostage to the runner's timezone — a real risk here, since the natural
  // implementation calls Date#getHours.
  assert.equal(
    usageLimitPausedText(1787680800000, () => '6pm'),
    '⏸ limit reached — resumes ~6pm',
  );
});

test('usageLimitPausedText: DROPS the ETA when the reset time is unknown', () => {
  // The 429 arm again (D2). A fabricated time is worse than none because a
  // reader takes it as measured. Assert both that the text is honest and that
  // it did not fall back to some default clock.
  const text = usageLimitPausedText(null);
  assert.match(text, /limit reached/);
  assert.ok(!text.includes('~'), 'must not imply an ETA it does not have');
  assert.ok(!/\d/.test(text), 'must contain no time-like digits');
});

test('usageLimitPausedText: the default formatter renders a human clock time', () => {
  // Guards the real formatter (the tests above inject a stub, so without this
  // `defaultFormatTime` would be entirely uncovered). Built from LOCAL time
  // parts so it is timezone-independent: whatever zone the runner is in, 18:00
  // local must render "6pm".
  const at6pm = new Date(2026, 7, 25, 18, 0, 0).getTime();
  assert.equal(usageLimitPausedText(at6pm), '⏸ limit reached — resumes ~6pm');
  const at630 = new Date(2026, 7, 25, 18, 30, 0).getTime();
  assert.equal(usageLimitPausedText(at630), '⏸ limit reached — resumes ~6:30pm');
  // Midnight/noon are the two the 12-hour wrap gets wrong (`0` instead of 12).
  assert.equal(usageLimitPausedText(new Date(2026, 7, 25, 0, 0, 0).getTime()),
    '⏸ limit reached — resumes ~12am');
  assert.equal(usageLimitPausedText(new Date(2026, 7, 25, 12, 0, 0).getTime()),
    '⏸ limit reached — resumes ~12pm');
});

test('RESUME_NUDGE_TEXT is GENERIC — it cannot leak the interrupted work', () => {
  // #74 forbids replaying the interrupted input: the killed turn may have
  // half-executed, so a replay re-runs side effects (#57 family). The nudge is
  // a fixed constant precisely so there is no code path that could interpolate
  // the old prompt into it — assert the property that makes that true.
  assert.equal(typeof RESUME_NUDGE_TEXT, 'string');
  assert.ok(RESUME_NUDGE_TEXT.length > 0, 'wakeAgentWithPrompt is prompt-mandatory');
  // It must TELL the agent not to assume completion — that instruction is the
  // whole safety argument for nudging instead of replaying.
  assert.match(RESUME_NUDGE_TEXT, /do NOT assume/i);
  assert.match(RESUME_NUDGE_TEXT, /durable state|re-read/i);
});
