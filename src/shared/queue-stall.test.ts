// Tests for the queue-stall policy (issue #88).
//
// THE TICKET'S PROMISE, stated so the reader can check the tests against it:
// "a badge appears when deliveries park for a workspace while NO TURN STARTS
// for more than N minutes — cause-agnostic — and it CLEARS when a turn starts."
//
// Three of these tests assert exactly that promise and nothing else:
//   • `badges once the threshold is crossed with work parked`   (it appears)
//   • `a turn starting CLEARS the stall`                        (it clears)
//   • `a workspace that IS consuming turns never badges`        (negative arm)
//
// The rest guard the suppression rules that keep it from duplicating #69/#74.
// Every case pins BOTH the precondition (elapsed ms, parked count) and the
// verdict in the same assertion, so a test cannot pass because the clock
// drifted rather than because the policy is right.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideQueueStall,
  workspaceQueueStall,
  QUEUE_STALL_THRESHOLD_MS,
  type QueueStallInput,
} from './queue-stall.ts';
import type { Workspace } from './types.ts';

const NOW = 1_700_000_000_000;
const OVER = QUEUE_STALL_THRESHOLD_MS + 60_000; // comfortably past N
const UNDER = QUEUE_STALL_THRESHOLD_MS - 60_000; // comfortably inside N

/** A workspace that IS stalled. Each test mutates exactly one field away from
 *  this, so a failure names the single clause responsible — rather than a
 *  bespoke fixture per test, where a case can pass for a reason unrelated to
 *  the clause it claims to exercise. */
function stalled(over: Partial<QueueStallInput> = {}): QueueStallInput {
  return {
    status: 'idle',
    lastStopReason: undefined,
    queuedCount: 0,
    parkedInboxCount: 2,
    lastTurnStartAt: NOW - OVER,
    createdAt: NOW - OVER * 10,
    hibernated: false,
    // Long before any fixture's turn start, so it is NOT the binding
    // constraint by default — each test that cares about R1 sets it
    // explicitly. A default that silently floored every age would make the
    // whole suite pass for the wrong reason.
    observableSince: NOW - OVER * 100,
    now: NOW,
    ...over,
  };
}

// ── The positive control: the baseline fixture must actually be stalled ──────
// Without this, every "returns null" test below could be passing because the
// fixture was never stalled to begin with — a suite of negative assertions
// with no positive control is unfalsifiable by construction.
test('CONTROL: the baseline fixture is stalled (2 parked, 16min idle)', () => {
  const v = decideQueueStall(stalled());
  assert.ok(v, 'baseline must be stalled or every negative case below is vacuous');
  assert.equal(v.parkedCount, 2);
  assert.equal(v.stalledForMs, OVER);
});

// ── THE TICKET'S PROMISE ────────────────────────────────────────────────────

test('PROMISE 1/3: badges once the threshold is crossed with work parked', () => {
  // Precondition asserted alongside the verdict at BOTH sample points, and the
  // two points BRACKET the boundary rather than probing one side of it.
  const just_under = decideQueueStall(stalled({ lastTurnStartAt: NOW - UNDER }));
  assert.equal(just_under, null, `parked=2 elapsed=${UNDER}ms must NOT badge`);

  const just_over = decideQueueStall(stalled({ lastTurnStartAt: NOW - OVER }));
  assert.ok(just_over, `parked=2 elapsed=${OVER}ms must badge`);
  assert.equal(just_over.stalledForMs, OVER);
  assert.equal(just_over.parkedCount, 2);
});

test('PROMISE 2/3: a turn starting CLEARS the stall', () => {
  const before = decideQueueStall(stalled());
  assert.ok(before, 'precondition: stalled before the turn starts');
  assert.equal(before.stalledForMs, OVER);

  // The ONLY thing that changes is the turn-start stamp — the parked work is
  // still parked, the status has not moved. This isolates the clause: a test
  // that also drained the queue would pass via rule 1 and prove nothing about
  // turn-start clearing.
  const after = decideQueueStall(stalled({ lastTurnStartAt: NOW }));
  assert.equal(after, null, 'a turn starting must clear the badge with work still parked');
});

test('PROMISE 3/3: a workspace that IS consuming turns never badges', () => {
  // The negative arm the ledger demands verbatim: parked deliveries on a
  // workspace that is taking turns must NOT badge. Note the turn-start stamp
  // is left OLD — a long single turn is exactly the case that would false-
  // positive if `running` were not a hard guard, and this fixture reproduces
  // it: 16 minutes since the turn STARTED, and it is still going.
  const v = decideQueueStall(stalled({ status: 'running' }));
  assert.equal(v, null, 'running with 2 parked and a 16min-old turn start must not badge');
});

// ── Suppression: composing with #69 / #74 rather than duplicating them ──────

for (const reason of ['max_turns', 'usage_limit', 'error'] as const) {
  test(`stands down when #69 already explains the cause (${reason})`, () => {
    const v = decideQueueStall(stalled({ lastStopReason: reason }));
    assert.equal(v, null, `${reason} has its own glyph; a second badge would duplicate it`);
  });
}

for (const reason of ['end_turn', 'interrupted'] as const) {
  test(`still badges for a NON-actionable stop reason (${reason})`, () => {
    // The complement of the rule above, and the one that makes it a rule
    // rather than a blanket mute: a clean finish explains nothing about why
    // work is piling up afterwards, so the stall is still the human's only
    // signal. Without this case, `causeAlreadyExplained` returning true
    // unconditionally would pass the whole suppression suite.
    const v = decideQueueStall(stalled({ lastStopReason: reason }));
    assert.ok(v, `${reason} is not an actionable reason, so the stall must still show`);
    assert.equal(v.parkedCount, 2);
  });
}

// ── The other guards ────────────────────────────────────────────────────────

test('nothing parked is not a stall, however long it has been idle', () => {
  const v = decideQueueStall(stalled({ parkedInboxCount: 0, queuedCount: 0, lastTurnStartAt: NOW - OVER * 100 }));
  assert.equal(v, null, 'an idle workspace with an empty queue is just idle');
});

test('a hibernated workspace is stopped on purpose, not stalled', () => {
  const v = decideQueueStall(stalled({ hibernated: true }));
  assert.equal(v, null);
});

test('counts BOTH sources into one number, and reports the split', () => {
  const v = decideQueueStall(stalled({ queuedCount: 3, parkedInboxCount: 2 }));
  assert.ok(v);
  assert.equal(v.parkedCount, 5, 'the badge number is the total');
  assert.equal(v.queuedCount, 3, 'the split survives for the tooltip');
  assert.equal(v.parkedInboxCount, 2);
});

test('either source ALONE is enough to stall', () => {
  const inboxOnly = decideQueueStall(stalled({ queuedCount: 0, parkedInboxCount: 1 }));
  assert.ok(inboxOnly, 'a parked peer message alone is waiting work');
  assert.equal(inboxOnly.parkedCount, 1);

  const queueOnly = decideQueueStall(stalled({ queuedCount: 1, parkedInboxCount: 0 }));
  assert.ok(queueOnly, 'a queued prompt alone is waiting work');
  assert.equal(queueOnly.parkedCount, 1);
});

test('a workspace that has NEVER taken a turn ages from createdAt', () => {
  // A spawned agent whose session never came up has no turn start at all. That
  // is a real stall — arguably the worst kind, since nothing ever worked — so
  // it must badge, but only after the SAME grace period as everyone else
  // rather than the instant a message lands on it.
  const fresh = decideQueueStall(stalled({ lastTurnStartAt: undefined, createdAt: NOW - UNDER }));
  assert.equal(fresh, null, `never-ran + created ${UNDER}ms ago must not badge yet`);

  const old = decideQueueStall(stalled({ lastTurnStartAt: undefined, createdAt: NOW - OVER }));
  assert.ok(old, `never-ran + created ${OVER}ms ago must badge`);
  assert.equal(old.stalledForMs, OVER);
});

// ── The record adapter ──────────────────────────────────────────────────────

function ws(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'w1',
    name: 'w1',
    worktreePath: '/tmp/w1',
    branch: 'b',
    baseBranch: 'master',
    createdAt: NOW - OVER * 10,
    status: 'idle',
    agent: 'claude',
    lastTurnStartAt: NOW - OVER,
    parkedInboxCount: 2,
    ...over,
  } as Workspace;
}

test('workspaceQueueStall reads the real record shape', () => {
  const v = workspaceQueueStall(ws(), NOW, NOW - OVER * 100);
  assert.ok(v, 'precondition: the record fixture is stalled');
  assert.equal(v.parkedCount, 2);
  assert.equal(v.stalledForMs, OVER);
});

test('workspaceQueueStall sums queuedPrompts with the inbox count', () => {
  const v = workspaceQueueStall(
    ws({
      queuedPrompts: [
        { id: 'p1', text: 'a', queuedAt: NOW - OVER },
        { id: 'p2', text: 'b', queuedAt: NOW - OVER },
      ],
    }),
    NOW,
    NOW - OVER * 100,
  );
  assert.ok(v);
  assert.equal(v.parkedCount, 4, '2 queued + 2 parked');
});

test('workspaceQueueStall treats an absent parkedInboxCount as zero', () => {
  const v = workspaceQueueStall(ws({ parkedInboxCount: undefined }), NOW, NOW - OVER * 100);
  assert.equal(v, null, 'absent means no parked mail, not "unknown"');
});

test('workspaceQueueStall never badges an ARCHIVED workspace', () => {
  // An archived record's status is a frozen leftover with no live agent behind
  // it, so every liveness claim about it is unsupported — the same exclusion
  // WorkspaceStatusGlyph makes.
  const v = workspaceQueueStall(ws({ archived: true }), NOW, NOW - OVER * 100);
  assert.equal(v, null);
});

test('workspaceQueueStall respects hibernatedAt', () => {
  const v = workspaceQueueStall(ws({ hibernatedAt: NOW - 1000 }), NOW, NOW - OVER * 100);
  assert.equal(v, null);
});


// ── review-88 R1: the age must not span app downtime ────────────────────────
//
// The defect these guard: `lastTurnStartAt` persists across a restart while
// the `running` status it pairs with is floored to `idle` by `store.load()`.
// So a HEALTHY agent's age included the whole time the app was closed, and
// every other guard passed — measured on this machine as 3-5 real workspaces
// holding parked mail while idle and healthy, the wave's own coordinator
// among them. They would all have badged "stalled 14h" on the first restart.

test('R1: a HEALTHY workspace does not badge just because the app was closed', () => {
  // The exact field shape: turn started 14h ago (before the quit), app has been
  // up 1 minute, mail parked during the downtime by reconcileParkedCounts.
  const appUpFor = 60_000;
  const v = decideQueueStall(
    stalled({
      lastTurnStartAt: NOW - 14 * 60 * 60 * 1000,
      observableSince: NOW - appUpFor,
    }),
  );
  assert.equal(
    v,
    null,
    'app up 60s, 2 parked, last turn 14h ago (BEFORE the quit) -> must NOT badge',
  );
});

test('R1: after a restart the age is earned from app start, not from the stamp', () => {
  const old = NOW - 14 * 60 * 60 * 1000;
  // Just under the threshold measured from APP START — still silent.
  const under = decideQueueStall(
    stalled({ lastTurnStartAt: old, observableSince: NOW - UNDER }),
  );
  assert.equal(under, null, `app up ${UNDER}ms with a 14h-old stamp -> no badge`);

  // Past it — now the silence is real, observed silence.
  const over = decideQueueStall(
    stalled({ lastTurnStartAt: old, observableSince: NOW - OVER }),
  );
  assert.ok(over, `app up ${OVER}ms with nothing observed -> badge`);
  assert.equal(
    over.stalledForMs,
    OVER,
    'the age is measured from app start, NOT from the 14h-old stamp',
  );
});

test('R1: observableSince is a FLOOR, never a ceiling', () => {
  // A turn that started AFTER the app came up must still win — otherwise a
  // long-running app would report every workspace as stalled since boot.
  const v = decideQueueStall(
    stalled({ lastTurnStartAt: NOW - UNDER, observableSince: NOW - OVER * 5 }),
  );
  assert.equal(v, null, 'a recent REAL turn start beats an old app start');
});

test('R1: the never-ran fallback is floored too', () => {
  // createdAt long ago + app just up: a workspace created days ago and never
  // run must not badge the instant the app opens.
  const v = decideQueueStall(
    stalled({
      lastTurnStartAt: undefined,
      createdAt: NOW - OVER * 100,
      observableSince: NOW - 60_000,
    }),
  );
  assert.equal(v, null, 'never-ran + app up 60s -> the grace period restarts with the app');
});
