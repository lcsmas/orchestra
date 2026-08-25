#!/usr/bin/env node
// #74 evidence — the DETECTION → DECISION chain, driven from real SDK wire
// payloads through the SAME functions the app runs.
//
// WHAT THIS IS AND IS NOT. This drives `normalizeSdkMessage` (the real
// producer, src/shared/agent-events.ts) and `decideResume` (the real policy,
// src/shared/usage-resume.ts) on real `rate_limit_event` / result payloads. It
// does NOT boot Electron, so it does not exercise `emitFrom`'s latch,
// `markStoppedOnUsageLimit`'s store write, or the flusher tick — those are
// covered by the structural guards in src/main/usage-limit-wiring.test.ts and
// by the GUI drive, and the gap is declared in the report rather than papered
// over.
//
// It deliberately does NOT seed `lastStopReason`. activity.ts's own docblock
// records that seeding it proves only that the renderer renders a field, and
// that the previous attempt at #69 passed its E2E precisely that way while the
// producer was broken. Here the reason is DERIVED from a wire payload.
//
// Run: node --experimental-strip-types scripts/e2e-usage-resume-chain.mjs

import { normalizeSdkMessage } from '../src/shared/agent-events.ts';
import { decideResume, resetsAtMsFromNotice } from '../src/shared/usage-resume.ts';

let failures = 0;
const results = [];
function check(name, got, want, note) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  results.push({ ok, name, got, want, note });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}\n       got=${JSON.stringify(got)} want=${JSON.stringify(want)}${note ? `\n       (${note})` : ''}`);
}

const ctx = () => ({ seq: 0, wsId: 'ws-rig', lastApiCallUsage: null });

// ── 1. The SDK's rate_limit_event, REJECTED, with a reset time ──────────────
// Wire shape per the SDK: { type, rate_limit_info: { status, resetsAt } }.
// resetsAt is epoch SECONDS. 1787680800 = 2026-08-25T18:00:00Z — "resets 6pm",
// the shape of the incident that motivated the ticket.
console.log('\n[1] rate_limit_event status=rejected (the wave-6 fleet-freeze shape)');
{
  const evs = normalizeSdkMessage(
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1787680800 } },
    ctx(),
  );
  const notice = evs.find((e) => e.type === 'notice' && e.kind === 'rate-limit');
  check('a rate-limit notice is produced', !!notice, true);
  check('it is flagged structurally as REJECTED', notice?.rejected, true,
    'this bit is what separates it from allowed_warning — never the prose');
  check('resetsAt passes through as epoch SECONDS', notice?.resetsAt, 1787680800);
  const ms = resetsAtMsFromNotice(notice?.resetsAt);
  check('converted to epoch MS', ms, 1787680800000);
  check('the converted value is a 2026 date, not 1970', ms > Date.parse('2026-01-01'), true,
    'a missing *1000 would land in Jan 1970 = already past = resume instantly into the wall');
}

// ── 2. allowed_warning — THE NEGATIVE CASE (OPS requirement) ───────────────
// A rig that only shows the pause firing cannot see the opposite failure:
// freezing healthy agents that are merely near the limit.
console.log('\n[2] rate_limit_event status=allowed_warning (~80%) — MUST NOT pause');
{
  const evs = normalizeSdkMessage(
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 0.8, resetsAt: 1787680800 } },
    ctx(),
  );
  const notice = evs.find((e) => e.type === 'notice' && e.kind === 'rate-limit');
  check('a notice IS still produced (the user is warned)', !!notice, true);
  check('but it is NOT flagged rejected', notice?.rejected ?? false, false,
    'if this were true, every agent at 80% usage would be paused and auto-resumed');
  // And the consequence, at the decision layer: no rejection => no marker =>
  // the driver must never consider it.
  check('decideResume ignores it (no usage_limit marker)',
    decideResume({ lastStopReason: 'end_turn', resetsAtMs: 1, isCoordinator: true,
      queuedCount: 0, freshUsageSaysRecovered: true, now: 9e12 }),
    'wait');
}

// ── 3. The 429 turn result — the OTHER producer (ledger D2) ────────────────
// The wave-6 death shape: the turn dies on a 429 and no separate
// rate_limit_event is guaranteed. Carries NO reset time.
console.log('\n[3] is_error result api_error_status=429 (no reset time on the wire)');
{
  const evs = normalizeSdkMessage(
    { type: 'result', is_error: true, api_error_status: 429, subtype: 'error_during_execution',
      result: 'usage limit', num_turns: 1, session_id: 's' },
    ctx(),
  );
  const notice = evs.find((e) => e.type === 'notice' && e.kind === 'rate-limit');
  check('a rate-limit notice is produced from the STATUS CODE', !!notice, true,
    'structural — a 429 is not prose');
  check('flagged rejected', notice?.rejected, true);
  check('and carries NO resetsAt', notice?.resetsAt, undefined,
    'the result reports none; inventing one would resume blind');
  check('so the conversion yields "unknown"', resetsAtMsFromNotice(notice?.resetsAt), null);
  const turnEnd = evs.find((e) => e.type === 'turn-end');
  check('the turn-end reports isError', turnEnd?.isError, true,
    'the marking branch requires this — a retried-through limit must not be marked');
  check('and its stopReason is NOT usage_limit', turnEnd?.stopReason !== 'usage_limit', true,
    'THE F1 DEFECT: the reason is written out-of-band, so fireFinished used to erase it');
}

// ── 4. A 529 must NOT be treated as a usage limit ──────────────────────────
console.log('\n[4] is_error result api_error_status=529 (upstream overload) — MUST NOT pause');
{
  const evs = normalizeSdkMessage(
    { type: 'result', is_error: true, api_error_status: 529, subtype: 'error', result: 'overloaded',
      num_turns: 1, session_id: 's' },
    ctx(),
  );
  const notice = evs.find((e) => e.type === 'notice' && e.kind === 'rate-limit');
  check('NO rate-limit notice for a 529', !!notice, false,
    'transient overload is not a quota problem — pausing on it would freeze a healthy fleet');
}

// ── 5. The decision, on the two real reset shapes ──────────────────────────
console.log('\n[5] decideResume on the two real shapes — observation (b): staggering + per-account');
{
  const RESET = 1787680800000;
  const before = RESET - 60_000, after = RESET + 60_000;

  check('coordinator BEFORE the reset waits',
    decideResume({ lastStopReason: 'usage_limit', resetsAtMs: RESET, isCoordinator: true,
      queuedCount: 0, freshUsageSaysRecovered: false, now: before }), 'wait');
  check('coordinator AT/AFTER the reset resumes FIRST (no fresh reading needed)',
    decideResume({ lastStopReason: 'usage_limit', resetsAtMs: RESET, isCoordinator: true,
      queuedCount: 0, freshUsageSaysRecovered: false, now: after }), 'nudge',
    'its first act is to re-read its ledger and re-dispatch, so it must precede its fleet');
  check('a CHILD at the same instant still WAITS (anti thundering-herd)',
    decideResume({ lastStopReason: 'usage_limit', resetsAtMs: RESET, isCoordinator: false,
      queuedCount: 0, freshUsageSaysRecovered: false, now: after }), 'wait');
  check('the child resumes once ITS OWN account reads recovered',
    decideResume({ lastStopReason: 'usage_limit', resetsAtMs: RESET, isCoordinator: false,
      queuedCount: 0, freshUsageSaysRecovered: true, now: after }), 'nudge',
    'per-account: freshUsageSaysRecovered comes from usageForWorkspace(ws), not a global flag');

  // observation (c)
  console.log('\n[6] observation (c): a banner-queued workspace gets its QUEUE, not a nudge');
  check('queued prompts WIN over the nudge',
    decideResume({ lastStopReason: 'usage_limit', resetsAtMs: RESET, isCoordinator: false,
      queuedCount: 2, freshUsageSaysRecovered: true, now: after }), 'queue',
    'they carry user intent; the nudge is synthesized');
  check('...even for a coordinator',
    decideResume({ lastStopReason: 'usage_limit', resetsAtMs: RESET, isCoordinator: true,
      queuedCount: 1, freshUsageSaysRecovered: false, now: after }), 'queue');

  // The 429 arm end-to-end: no reset time anywhere, so the clock cannot help.
  console.log('\n[7] the 429 arm (no ETA) falls back to fresh-usage evidence');
  check('unknown reset + no fresh reading → wait (never "now")',
    decideResume({ lastStopReason: 'usage_limit', resetsAtMs: null, isCoordinator: true,
      queuedCount: 0, freshUsageSaysRecovered: false, now: after }), 'wait',
    'treating null as now would resume instantly, straight back into the limit');
  check('unknown reset + fresh reading → nudge',
    decideResume({ lastStopReason: 'usage_limit', resetsAtMs: null, isCoordinator: true,
      queuedCount: 0, freshUsageSaysRecovered: true, now: after }), 'nudge');
}

console.log(`\n${failures === 0 ? 'CHAIN PASS' : `CHAIN FAIL (${failures})`} — ${results.length} checks, ${results.filter(r => r.ok).length} ok`);
process.exit(failures === 0 ? 0 : 1);
