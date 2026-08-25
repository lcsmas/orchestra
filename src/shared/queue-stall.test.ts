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
  const v = workspaceQueueStall(ws(), NOW);
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
  );
  assert.ok(v);
  assert.equal(v.parkedCount, 4, '2 queued + 2 parked');
});

test('workspaceQueueStall treats an absent parkedInboxCount as zero', () => {
  const v = workspaceQueueStall(ws({ parkedInboxCount: undefined }), NOW);
  assert.equal(v, null, 'absent means no parked mail, not "unknown"');
});

test('workspaceQueueStall never badges an ARCHIVED workspace', () => {
  // An archived record's status is a frozen leftover with no live agent behind
  // it, so every liveness claim about it is unsupported — the same exclusion
  // WorkspaceStatusGlyph makes.
  const v = workspaceQueueStall(ws({ archived: true }), NOW);
  assert.equal(v, null);
});

test('workspaceQueueStall respects hibernatedAt', () => {
  const v = workspaceQueueStall(ws({ hibernatedAt: NOW - 1000 }), NOW);
  assert.equal(v, null);
});
