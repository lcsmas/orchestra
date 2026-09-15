import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideGateRelease,
  decideSessionRecycle,
  pruneRecycles,
  recycleBackoffMs,
  GATE_SILENCE_RELEASE_MS,
  MAX_RECYCLES_PER_HOUR,
  RECYCLE_BACKOFF_BASE_MS,
  RECYCLE_BACKOFF_MAX_MS,
} from './session-wedge.ts';
import { decideQueueStall } from './queue-stall.ts';

const NOW = 1_800_000_000_000;
/** A stream stamp old enough to clear the progress refusal, so cases that are
 *  ABOUT something else (anti-flap, sessionLive, the stall verdict) are not
 *  silently passing because of the progress guard instead. */
const SILENT = NOW - GATE_SILENCE_RELEASE_MS - 1;

// ── Layer 1: the turn gate ──────────────────────────────────────────────────
//
// Each case names the ONE guard it exercises and satisfies every OTHER guard,
// so a passing case cannot be passing for an incidental reason. (A fixture
// rejected by an earlier guard would go green while proving nothing about the
// clause under test.)

const liveGate = {
  gateHeld: true,
  observedTurnUuid: 'turn-a',
  currentTurnUuid: 'turn-a',
  lastStreamAt: NOW - GATE_SILENCE_RELEASE_MS - 1,
  stopping: false,
  queuedCount: 2,
  now: NOW,
};

test('gate: a turn silent past the window WITH work waiting releases', () => {
  assert.equal(decideGateRelease(liveGate), true);
});

test('gate: a turn still emitting is NEVER released, however long it has run', () => {
  // The progress bound, stated as a test: the turn started 6 hours ago but
  // emitted 1 second ago. This is the legitimate-long-turn case that a
  // duration bound would wrongly cut off (issue #62's mistake).
  assert.equal(
    decideGateRelease({ ...liveGate, lastStreamAt: NOW - 1_000 }),
    false,
    'a turn that emitted 1s ago must never be released',
  );
});

test('gate: silence one ms short of the window does not release (boundary)', () => {
  assert.equal(
    decideGateRelease({ ...liveGate, lastStreamAt: NOW - GATE_SILENCE_RELEASE_MS + 1 }),
    false,
  );
  // ...and exactly AT the window does. The two together bracket the boundary,
  // so neither `>` nor `>=` can be silently swapped for the other.
  assert.equal(
    decideGateRelease({ ...liveGate, lastStreamAt: NOW - GATE_SILENCE_RELEASE_MS }),
    true,
  );
});

test('gate: a REUSED gate slot (different turn) is never released', () => {
  // The guard that stops the watchdog from ever killing a healthy turn: we
  // observed turn-a going silent, but turn-b owns the gate now.
  assert.equal(decideGateRelease({ ...liveGate, currentTurnUuid: 'turn-b' }), false);
});

test('gate: unprovable turn identity refuses rather than guesses', () => {
  assert.equal(decideGateRelease({ ...liveGate, observedTurnUuid: null }), false);
  assert.equal(decideGateRelease({ ...liveGate, currentTurnUuid: null }), false);
});

test('gate: nothing waiting -> no release (the action would be a no-op)', () => {
  assert.equal(decideGateRelease({ ...liveGate, queuedCount: 0 }), false);
});

test('gate: not while stopping (teardown releases the gate itself)', () => {
  assert.equal(decideGateRelease({ ...liveGate, stopping: true }), false);
});

test('gate: no gate held -> nothing to release', () => {
  assert.equal(decideGateRelease({ ...liveGate, gateHeld: false }), false);
});

// ── Layer 2: the recycle watchdog ───────────────────────────────────────────

const stalled = { parkedCount: 3, stalledForMs: 35 * 60_000 };

test('recycle: a stalled workspace with a live session is recycled', () => {
  const d = decideSessionRecycle({
    sessionLive: true,
    stalled,
    lastStreamAt: SILENT,
    recentRecycles: [],
    now: NOW,
  });
  assert.deepEqual(d, { action: 'recycle', parkedCount: 3, stalledForMs: 35 * 60_000 });
});

test('recycle: NOT stalled -> never recycled', () => {
  assert.deepEqual(
    decideSessionRecycle({ sessionLive: true, stalled: null, lastStreamAt: SILENT, recentRecycles: [], now: NOW }),
    { action: 'none' },
  );
});

test('recycle: no live session -> nothing to recycle', () => {
  assert.deepEqual(
    decideSessionRecycle({ sessionLive: false, stalled, lastStreamAt: SILENT, recentRecycles: [], now: NOW }),
    { action: 'none' },
  );
});

test('recycle: anti-flap stops at the budget and SURFACES rather than going silent', () => {
  const recent = [NOW - 50 * 60_000, NOW - 30 * 60_000, NOW - 10 * 60_000];
  assert.equal(recent.length, MAX_RECYCLES_PER_HOUR);
  const d = decideSessionRecycle({
    sessionLive: true,
    stalled,
    lastStreamAt: SILENT,
    recentRecycles: recent,
    now: NOW,
  });
  assert.deepEqual(d, {
    action: 'flap-limit',
    recyclesInWindow: 3,
    stalledForMs: 35 * 60_000,
  });
  // One BELOW the budget still recycles — so the limit is a real boundary and
  // not an always-on refusal.
  assert.equal(
    decideSessionRecycle({
      sessionLive: true,
      stalled,
      lastStreamAt: SILENT,
      recentRecycles: recent.slice(1),
      now: NOW,
    }).action,
    'recycle',
  );
});

test('recycle: stamps outside the rolling window do not count against the budget', () => {
  const old = [NOW - 90 * 60_000, NOW - 80 * 60_000, NOW - 70 * 60_000];
  assert.equal(
    decideSessionRecycle({ sessionLive: true, stalled, lastStreamAt: SILENT, recentRecycles: old, now: NOW }).action,
    'recycle',
    'hour-old recycles must age out, or the watchdog permanently disables itself',
  );
  assert.deepEqual(pruneRecycles(old, NOW), []);
});

// ── The false-positive fixture the ticket names, driven END TO END ──────────

test('FIELD FIXTURE: parked=2, idle, alive, age 46s -> MUST NOT recycle', () => {
  // Ledger #89, verbatim. Five busy agents parked deliveries during one
  // broadcast; two read `idle` while provably working. Recycling a healthy
  // mid-turn session is strictly worse than the stall this ticket treats.
  //
  // Driven through the REAL #88 detector, not a hand-made `stalled` object —
  // otherwise this asserts my fixture, not the composed system.
  const stall = decideQueueStall({
    status: 'idle',
    lastStopReason: undefined,
    queuedCount: 0,
    parkedInboxCount: 2,
    lastTurnStartAt: NOW - 46_000,
    createdAt: NOW - 3_600_000,
    hibernated: false,
    observableSince: NOW - 3_600_000,
    now: NOW,
  });
  assert.equal(stall, null, '#88 detector must not call a 46s-old park a stall');
  assert.deepEqual(
    decideSessionRecycle({ sessionLive: true, stalled: stall, lastStreamAt: SILENT, recentRecycles: [], now: NOW }),
    { action: 'none' },
  );
});

test('FIELD FIXTURE: a busy (running) agent with parked work is NEVER recycled', () => {
  // The negative arm that matters most. Same parked work, same age as the
  // positive control below — the ONLY difference is `status`.
  const stall = decideQueueStall({
    status: 'running',
    lastStopReason: undefined,
    queuedCount: 0,
    parkedInboxCount: 3,
    lastTurnStartAt: NOW - 35 * 60_000,
    createdAt: NOW - 3_600_000,
    hibernated: false,
    observableSince: NOW - 3_600_000,
    now: NOW,
  });
  assert.equal(stall, null);
  assert.deepEqual(
    decideSessionRecycle({ sessionLive: true, stalled: stall, lastStreamAt: SILENT, recentRecycles: [], now: NOW }),
    { action: 'none' },
  );
});

test('POSITIVE CONTROL: occurrence-1 shape (parked=3, idle, 35min) IS recycled', () => {
  // Without this, every assertion above would also pass on a detector that
  // returns null for everything — i.e. on a watchdog that does nothing at all.
  const stall = decideQueueStall({
    status: 'idle',
    lastStopReason: undefined,
    queuedCount: 0,
    parkedInboxCount: 3,
    lastTurnStartAt: NOW - 35 * 60_000,
    createdAt: NOW - 3_600_000,
    hibernated: false,
    observableSince: NOW - 3_600_000,
    now: NOW,
  });
  assert.ok(stall, 'the real field stall must be detected');
  const d = decideSessionRecycle({
    sessionLive: true,
    stalled: stall,
    lastStreamAt: SILENT,
    recentRecycles: [],
    now: NOW,
  });
  assert.equal(d.action, 'recycle');
});

// ── Review R1: the DESTRUCTIVE path carries its own progress evidence ───────
//
// These are the cases whose absence let the first cut reach `sdkStop` — which
// calls `session.q.interrupt()` — on nothing but #88's `status` guard, a
// display field documented in queue-stall.ts as not surviving a restart.

test('R1: a session that emitted INSIDE the silence window is never recycled', () => {
  // Everything else says "recycle": stalled verdict present, session live,
  // budget empty. The ONLY thing standing between a healthy agent and an
  // interrupt is the progress evidence.
  assert.deepEqual(
    decideSessionRecycle({
      sessionLive: true,
      stalled,
      lastStreamAt: NOW - 1_000, // emitted 1s ago
      recentRecycles: [],
      now: NOW,
    }),
    { action: 'none' },
  );
});

test('R1: THE PERMISSION-BLOCK CASE — a `waiting` agent mid-prompt is not torn down', () => {
  // The sharpest real case (review R1): `waiting` is the DESIGNED status for a
  // permission/dialog block. #88's detector does NOT suppress `waiting` — only
  // `running` — so a human parked on an Allow dialog for 15+ minutes while a
  // peer messages them produces a genuine stall verdict.
  const stall = decideQueueStall({
    status: 'waiting',
    lastStopReason: undefined,
    queuedCount: 0,
    parkedInboxCount: 2,
    lastTurnStartAt: NOW - 20 * 60_000,
    createdAt: NOW - 3_600_000,
    hibernated: false,
    observableSince: NOW - 3_600_000,
    now: NOW,
  });
  // Pin the premise: if #88 ever starts suppressing `waiting`, this test must
  // be re-argued rather than silently passing for a different reason.
  assert.ok(stall, 'premise: #88 DOES produce a stall verdict for `waiting`');

  // The session is alive and its subprocess emitted recently (it is sitting on
  // a permission request, not wedged). The recycle must refuse.
  assert.deepEqual(
    decideSessionRecycle({
      sessionLive: true,
      stalled: stall,
      lastStreamAt: NOW - 30_000,
      recentRecycles: [],
      now: NOW,
    }),
    { action: 'none' },
    'a permission-blocked agent must not have its turn interrupted',
  );
});

test('R1: unprovable progress (null) refuses rather than guessing', () => {
  assert.deepEqual(
    decideSessionRecycle({
      sessionLive: true,
      stalled,
      lastStreamAt: null,
      recentRecycles: [],
      now: NOW,
    }),
    { action: 'none' },
  );
});

test('R1: the progress refusal does not consume anti-flap budget', () => {
  // Placement matters: if the budget were charged before the progress check, a
  // healthy-but-noisy workspace could exhaust its own budget and then be
  // REPORTED as flapping — a false alarm manufactured by the guard itself.
  const d = decideSessionRecycle({
    sessionLive: true,
    stalled,
    lastStreamAt: NOW - 1_000,
    recentRecycles: [NOW - 50 * 60_000, NOW - 30 * 60_000, NOW - 10 * 60_000],
    now: NOW,
  });
  assert.deepEqual(d, { action: 'none' }, 'must be none, NOT flap-limit');
});

test('R1 POSITIVE CONTROL: a genuinely silent stalled session IS still recycled', () => {
  // Without this, every R1 assertion above would also pass on a watchdog that
  // refuses everything — i.e. one that does nothing at all.
  assert.equal(
    decideSessionRecycle({
      sessionLive: true,
      stalled,
      lastStreamAt: NOW - GATE_SILENCE_RELEASE_MS - 1,
      recentRecycles: [],
      now: NOW,
    }).action,
    'recycle',
  );
});

// ── Issue #97: the WIDENING BACKOFF interval ────────────────────────────────
//
// The anti-flap COUNT (tested above) is necessary but not sufficient: without a
// widening interval a session that re-wedges instantly burns its whole budget on
// consecutive ticks (TICK_MS = 60s → three recycles in three minutes). These
// cases pin that the interval GROWS with each recycle already spent, and that a
// too-soon attempt returns the distinct `backoff` action rather than recycling.

test('backoff fn: the interval doubles per recycle and caps', () => {
  // The growth is the claim, so assert the actual computed delays, not a flag.
  assert.equal(recycleBackoffMs(0), 0, 'first recycle waits nothing');
  assert.equal(recycleBackoffMs(1), RECYCLE_BACKOFF_BASE_MS, 'second waits base');
  assert.equal(recycleBackoffMs(2), RECYCLE_BACKOFF_BASE_MS * 2, 'third waits 2×base');
  assert.equal(recycleBackoffMs(3), RECYCLE_BACKOFF_BASE_MS * 4);
  // Strictly increasing until the cap, then clamped.
  assert.ok(recycleBackoffMs(2) > recycleBackoffMs(1));
  assert.ok(recycleBackoffMs(3) > recycleBackoffMs(2));
  assert.equal(recycleBackoffMs(100), RECYCLE_BACKOFF_MAX_MS, 'clamped at the cap');
  assert.ok(RECYCLE_BACKOFF_BASE_MS > 60_000, 'base must exceed one 60s tick so the 2nd attempt defers');
});

test('backoff: a 2nd recycle too soon after the 1st WAITS, then fires once the interval passes', () => {
  // One recycle in the window, base backoff = 2min. An attempt 1min later is
  // inside the interval → backoff, NOT recycle. The SAME inputs 3min later (past
  // the 2min interval) DO recycle. The two together prove the interval is real
  // and eventually crosses — not a permanent refusal.
  const oneRecycleAgo = (agoMs: number) => ({
    sessionLive: true,
    stalled,
    lastStreamAt: NOW - GATE_SILENCE_RELEASE_MS - 1,
    recentRecycles: [NOW - agoMs],
    now: NOW,
  });
  const tooSoon = decideSessionRecycle(oneRecycleAgo(60_000)); // 1min < 2min base
  assert.equal(tooSoon.action, 'backoff', '1min after a recycle must back off, not recycle again');
  assert.ok(
    tooSoon.action === 'backoff' && tooSoon.waitMs > 0 && tooSoon.recyclesInWindow === 1,
    'backoff carries the remaining wait and the count',
  );

  const enoughLater = decideSessionRecycle(oneRecycleAgo(RECYCLE_BACKOFF_BASE_MS + 1_000));
  assert.equal(enoughLater.action, 'recycle', 'once the interval passes the recycle proceeds');
});

test('backoff: the interval WIDENS — 2 recycles need a longer gap than 1', () => {
  // MUST-FAIL mutant target: a constant (non-widening) interval passes the
  // single-recycle case but fails this one, because the gap that satisfied
  // attempt 2 (just over base) is NOT enough for attempt 3 (2×base).
  const twoRecyclesGap = RECYCLE_BACKOFF_BASE_MS + 1_000; // enough for attempt 2, not attempt 3
  const d = decideSessionRecycle({
    sessionLive: true,
    stalled,
    lastStreamAt: NOW - GATE_SILENCE_RELEASE_MS - 1,
    // Two recycles in the window; the most recent is `twoRecyclesGap` ago.
    recentRecycles: [NOW - 40 * 60_000, NOW - twoRecyclesGap],
    now: NOW,
  });
  assert.equal(
    d.action,
    'backoff',
    'the 3rd attempt needs 2×base; a gap that satisfied the 2nd must NOT satisfy it',
  );
  // And a gap that DOES satisfy 2×base recycles — pinning that it is the
  // widened interval, not an always-backoff.
  const wide = decideSessionRecycle({
    sessionLive: true,
    stalled,
    lastStreamAt: NOW - GATE_SILENCE_RELEASE_MS - 1,
    recentRecycles: [NOW - 40 * 60_000, NOW - (RECYCLE_BACKOFF_BASE_MS * 2 + 1_000)],
    now: NOW,
  });
  assert.equal(wide.action, 'recycle');
});

test('backoff: the FIRST recycle (empty ledger) is never delayed', () => {
  // A genuine one-off stall — both 2026-08-25 field occurrences — must be
  // treated instantly; backoff only applies once at least one recycle is spent.
  assert.equal(
    decideSessionRecycle({
      sessionLive: true,
      stalled,
      lastStreamAt: SILENT,
      recentRecycles: [],
      now: NOW,
    }).action,
    'recycle',
  );
});

test('backoff never masks the flap ceiling: at budget it is flap-limit, not backoff', () => {
  // Ordering pin: the ceiling is checked before backoff, so a workspace AT the
  // budget stands down (surfaced) rather than silently backing off forever.
  const recent = [NOW - 50 * 60_000, NOW - 30 * 60_000, NOW - 10 * 60_000];
  assert.equal(recent.length, MAX_RECYCLES_PER_HOUR);
  assert.equal(
    decideSessionRecycle({ sessionLive: true, stalled, lastStreamAt: SILENT, recentRecycles: recent, now: NOW }).action,
    'flap-limit',
  );
});
