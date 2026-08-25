import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  shouldRecycleForBudget,
  stopReasonNote,
  MAX_RECYCLES_PER_WINDOW,
  RECYCLE_WINDOW_MS,
} from '../shared/turn-budget.ts';

// ─── Issue #69: a session silently stops consuming its queue ────────────────
//
// Two kinds of test live here, and the split is deliberate:
//
//   (A) An EXECUTING reproduction of the starvation mechanism. `agent-sdk.ts`
//       cannot be imported by this runner (it pulls in `platform`/`store`/
//       `pty`, i.e. Electron), so the queue-pump loop is re-executed here in
//       the shape the real one has. That makes it a MODEL, and a model that
//       was faithful when written goes stale silently — so:
//
//   (B) SOURCE-BINDING GUARDS that read the real agent-sdk.ts and refuse a
//       verdict if the structural properties the model assumes stop holding.
//       Without these, (A) would keep printing green about a program that no
//       longer exists.
//
// The mechanism being reproduced, verified against master 2ebd3fb:
// `error_max_turns` arrives as an ordinary `result` message, NOT as a throw.
// So consume()'s catch/finally — which drains the queue, settles delivery
// receipts and emits "N queued messages were not delivered" — never runs.
// The result branch opens the turn gate, promptStream yields the next queued
// entry, and it dies on the same exhausted budget. Repeat until the queue is
// empty. Nothing surfaces.

const ROOT = process.cwd(); // pnpm test runs from the repo root
const AGENT_SDK = path.join(ROOT, 'src', 'main', 'agent-sdk.ts');

/** One turn's outcome in the harness below. */
type Outcome = 'ran' | 'died-on-exhausted-budget';

interface RunResult {
  /** Entries that genuinely reached the model. */
  ran: string[];
  /** Entries shifted out of the queue that died without being processed —
   *  the starvation. */
  starved: string[];
  /** Entries still queued when the session came to rest. */
  leftQueued: string[];
  /** Terminal notices the human would see. */
  surfaced: string[];
  /** Number of times the query was recycled with a fresh budget. */
  recycles: number;
}

/**
 * Re-execute Orchestra's queue pump against a budget that can be exhausted.
 *
 * This mirrors the real control flow: a queue, a turn gate opened by the
 * `result` branch, and a generator that shifts the next entry once the gate
 * opens. `budget` is the session-lifetime `maxTurns`; each yielded turn spends
 * one. When it is spent, the SDK returns `error_max_turns` as a RESULT (not a
 * throw) — modelled by `outcomeFor` below.
 *
 * @param fixed  false = the unfixed build (the result branch just reopens the
 *               gate); true = the fix (exhaustion recycles the query).
 */
function runQueuePump(opts: {
  queue: string[];
  budget: number;
  fixed: boolean;
  /** Recycle timestamps, and a clock, so the runaway guard is exercised for
   *  real rather than assumed. */
  now?: number;
  priorRecycles?: number[];
}): RunResult {
  const queue = [...opts.queue];
  const ran: string[] = [];
  const starved: string[] = [];
  const surfaced: string[] = [];
  let spent = 0;
  let budget = opts.budget;
  let recycles = 0;
  let history = opts.priorRecycles ? [...opts.priorRecycles] : [];
  const now = opts.now ?? 1_000_000;
  let stopped = false;

  while (queue.length > 0 && !stopped) {
    const entry = queue.shift()!;

    // The turn is yielded to the SDK. Does it run, or is the budget gone?
    const outcome: Outcome = spent >= budget ? 'died-on-exhausted-budget' : 'ran';

    if (outcome === 'ran') {
      spent += 1;
      ran.push(entry);
      // `result` (success) → the gate reopens, loop continues. Nothing to do.
      continue;
    }

    // ── error_max_turns. This is a RESULT, not a throw. ──
    if (!opts.fixed) {
      // UNFIXED: the result branch opens the turn gate exactly as it does for a
      // successful turn (agent-sdk.ts:955 `session.turnGate = null; openNext?.()`).
      // The entry is already shifted out of the queue and is simply lost. The
      // loop comes straight back for the next one, which meets the same
      // exhausted budget. Nothing is emitted; the ONLY record is a [WARN] in
      // the app log, which is not modelled because it is not a UI surface.
      starved.push(entry);
      continue;
    }

    // FIXED: exhaustion is recognised as terminal-for-this-query. Decide
    // whether to recycle (fresh budget, same conversation via `resume`) or to
    // stop as a runaway. Either way the human is told.
    const decision = shouldRecycleForBudget(history, now);
    history = decision.history;
    surfaced.push(decision.reason);
    if (!decision.recycle) {
      // Runaway: stop, and put the entry BACK so it is reported as undelivered
      // rather than silently eaten.
      queue.unshift(entry);
      stopped = true;
      break;
    }
    recycles += 1;
    // A fresh query() means a fresh session-lifetime budget.
    spent = 0;
    budget = opts.budget;
    // The entry was never processed — it is re-queued and delivered by the
    // renewed session. THIS is the line that kills the starvation.
    queue.unshift(entry);
  }

  return { ran, starved, leftQueued: queue, surfaced, recycles };
}

// ─── (A) The measurement: unfixed arm vs fixed arm, SAME rig ────────────────

test('#69 UNFIXED ARM: an exhausted budget silently eats the whole queue', () => {
  // The field failure's shape: a coordinator with messages piled up. Budget 3
  // is already spent by the first 3 entries; the remaining 5 are the "43
  // messages with nothing consuming them".
  const res = runQueuePump({
    queue: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'],
    budget: 3,
    fixed: false,
  });

  // Positive control: the rig CAN run turns — otherwise "nothing ran" would be
  // a dead-harness artifact rather than a finding.
  assert.deepEqual(res.ran, ['m1', 'm2', 'm3'], 'the first 3 turns must genuinely run');

  // The defect, stated as an observation: five messages left the queue and
  // reached nobody.
  assert.deepEqual(
    res.starved,
    ['m4', 'm5', 'm6', 'm7', 'm8'],
    'unfixed: every post-exhaustion message is consumed from the queue and lost',
  );
  assert.equal(res.leftQueued.length, 0, 'unfixed: the queue is drained to empty');

  // And the non-negotiable half — NOTHING was surfaced to the human.
  assert.deepEqual(res.surfaced, [], 'unfixed: the human is told nothing (the bug)');
  assert.equal(res.recycles, 0, 'unfixed: the query is never recycled');
});

test('#69 FIXED ARM: the same starvation is eliminated AND surfaced', () => {
  const res = runQueuePump({
    queue: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'],
    budget: 3,
    fixed: true,
  });

  // Every message is delivered — nothing starves.
  assert.deepEqual(
    res.ran,
    ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'],
    'fixed: every queued message reaches the model',
  );
  assert.deepEqual(res.starved, [], 'fixed: nothing is eaten from the queue');
  assert.equal(res.leftQueued.length, 0, 'fixed: the queue is fully consumed');

  // Budget 3 over 8 messages = exhausted after m3 and again after m6.
  assert.equal(res.recycles, 2, 'fixed: the query is recycled once per exhaustion');

  // The surfacing is what #69 actually demands: not silent.
  assert.equal(res.surfaced.length, 2, 'fixed: every recycle is announced');
  for (const s of res.surfaced) {
    assert.match(s, /budget/i, 'the notice must name the budget as the cause');
  }
});

test('#69 the runaway guard still stops a genuine loop — and says so', () => {
  // A session that has ALREADY burned its allowance inside the window.
  const now = 5_000_000;
  const prior = [now - 1000, now - 2000, now - 3000]; // 3 recycles, all recent
  const res = runQueuePump({
    queue: ['m1', 'm2', 'm3'],
    budget: 0, // exhausted immediately
    fixed: true,
    now,
    priorRecycles: prior,
  });

  assert.equal(res.recycles, 0, 'a runaway must NOT be granted a fresh budget');
  assert.deepEqual(res.ran, [], 'no turn runs on an exhausted runaway');
  // Crucially the messages are NOT silently eaten — they stay queued so the
  // undelivered path can report them.
  assert.deepEqual(res.leftQueued, ['m1', 'm2', 'm3'], 'the queue survives for reporting');
  assert.equal(res.starved.length, 0, 'a stopped runaway eats nothing');
  assert.match(res.surfaced[0] ?? '', /runaway|Stopped/i, 'the stop must be explained');
});

// ─── The policy itself ──────────────────────────────────────────────────────

test('shouldRecycleForBudget prunes recycles outside the window', () => {
  const now = 10_000_000;
  // Three recycles, but all older than the window — must NOT hold the guard.
  const stale = [now - RECYCLE_WINDOW_MS - 1, now - RECYCLE_WINDOW_MS - 2, now - RECYCLE_WINDOW_MS - 3];
  const d = shouldRecycleForBudget(stale, now);
  assert.equal(d.recycle, true, 'stale recycles must not permanently wedge a workspace');
  assert.deepEqual(d.history, [now], 'stale entries are pruned, not accumulated');

  // Control: the SAME count inside the window does block, proving the guard
  // can fire at all and that the difference above is the WINDOW, not the count.
  const fresh = [now - 1, now - 2, now - 3];
  assert.equal(shouldRecycleForBudget(fresh, now).recycle, false, 'in-window recycles do block');
});

test('shouldRecycleForBudget allows exactly MAX_RECYCLES_PER_WINDOW', () => {
  const now = 10_000_000;
  let history: number[] = [];
  for (let i = 0; i < MAX_RECYCLES_PER_WINDOW; i++) {
    const d = shouldRecycleForBudget(history, now);
    assert.equal(d.recycle, true, `recycle ${i + 1} must be allowed`);
    history = d.history;
  }
  // The next one is the runaway.
  const denied = shouldRecycleForBudget(history, now);
  assert.equal(denied.recycle, false, 'the N+1th recycle in-window is refused');
  assert.match(denied.reason, /Stopped/, 'and the refusal is explained to the human');
});

test('stopReasonNote decorates only the reasons a human must act on', () => {
  assert.match(stopReasonNote('max_turns') ?? '', /budget/i);
  assert.match(stopReasonNote('error') ?? '', /error/i);
  // Controls: the non-failures must NOT decorate the row, or the sidebar cries
  // wolf on every clean turn and the signal is worthless.
  assert.equal(stopReasonNote('end_turn'), null, 'a clean finish is not a fault');
  assert.equal(stopReasonNote('interrupted'), null, "the user's own interrupt is not a fault");
  assert.equal(stopReasonNote(undefined), null, 'no opinion → no decoration');
});

// ─── The await-seam re-entry race (found by reviewing my own diff) ─────────

/** Re-execute the recycle's re-entry guard across a suspension point.
 *
 *  `recycleForBudget` awaits (persist, sdkStop, ensureSession) while the
 *  consume loop keeps delivering messages, so a SECOND `error_max_turns` can
 *  land mid-teardown. The guard must therefore be set SYNCHRONOUSLY, before the
 *  first await — the exact shape that bit issue #57 when a registrar was routed
 *  across an await. `syncGuard: false` models checking only a flag that is set
 *  later (by sdkStop), which is what the first draft of this fix did. */
async function raceTwoExhaustions(syncGuard: boolean): Promise<number> {
  const session = { stopping: false, recycling: false };
  let entries = 0;
  const recycle = async () => {
    if (session.stopping) return;
    if (syncGuard) {
      if (session.recycling) return;
      session.recycling = true; // set BEFORE any await
    }
    entries += 1;
    await Promise.resolve(); // the persist/sdkStop suspension point
    session.stopping = true; // what sdkStop eventually does
  };
  // Two results arrive back-to-back, as they do when queued turns each die
  // instantly on the same spent budget.
  await Promise.all([recycle(), recycle()]);
  return entries;
}

test('#69 the recycle guard is set before the first await (re-entry race)', async () => {
  assert.equal(
    await raceTwoExhaustions(true),
    1,
    'a second error_max_turns arriving mid-teardown must NOT start a second recycle',
  );
  // CONTROL: the same rig with only the LATE flag (the first draft) lets both
  // in — proving this test can fail and that the sync guard is what fixes it,
  // not the rig being unable to express the race.
  assert.equal(
    await raceTwoExhaustions(false),
    2,
    'control: without the synchronous flag the race IS reachable (so the guard is load-bearing)',
  );
});

test('GUARD: the recycle re-entry flag is set synchronously in the real source', () => {
  const code = agentSdkCode();
  const start = code.indexOf('async function recycleForBudget(');
  assert.notEqual(start, -1, 'recycleForBudget() not found — was it renamed?');
  const body = code.slice(start, start + 1200);
  assert.ok(body.length > 300, 'the recycleForBudget slice came back suspiciously short');
  // The assignment must appear BEFORE the first `await` in the function body,
  // or the race above is live in the real program.
  const setAt = body.indexOf('session.recycling = true');
  const firstAwait = body.indexOf('await ');
  assert.notEqual(setAt, -1, 'recycleForBudget must set session.recycling');
  assert.notEqual(firstAwait, -1, 'recycleForBudget should contain an await (it tears down + reboots)');
  assert.ok(
    setAt < firstAwait,
    'session.recycling must be set BEFORE the first await — a guard set after a ' +
      'suspension point cannot stop the re-entry it exists to stop (#57 shape)',
  );
});

// ─── (B) Source-binding guards — refuse a verdict if the model went stale ───
//
// Each of these names a structural property the harness above ASSUMES. If one
// stops holding, the harness is modelling a program that no longer exists and
// its green means nothing, so these fail loudly rather than letting it pass.

/** agent-sdk.ts with line comments stripped, so prose ABOUT the old design
 *  cannot satisfy a structural code check. */
function agentSdkCode(): string {
  const raw = fs.readFileSync(AGENT_SDK, 'utf8');
  const stripped = raw
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  // Positive control: stripping must not have eaten the file.
  assert.ok(stripped.length > 20_000, 'comment-stripping returned a suspiciously small file');
  return stripped;
}

test('GUARD: maxTurns is still a single construction-time literal (#69 premise)', () => {
  const code = agentSdkCode();
  const hits = code.match(/maxTurns:/g) ?? [];
  assert.equal(
    hits.length,
    1,
    `expected exactly ONE maxTurns option site in agent-sdk.ts, found ${hits.length}. ` +
      'The #69 model assumes one session-lifetime budget; more than one means the ' +
      'budget shape changed and the harness above must be re-derived.',
  );
});

test('GUARD: the result branch is still what reopens the turn gate', () => {
  const code = agentSdkCode();
  // The starvation depends on `result` reopening the gate so the next queued
  // entry is yielded. If this moves, the model is stale.
  assert.match(
    code,
    /session\.turnGate = null;/,
    'the turn-gate reset vanished from agent-sdk.ts — re-derive the #69 model',
  );
  assert.match(
    code,
    /msg\.type === 'result'/,
    "the `result` branch vanished — the #69 starvation path is no longer where the model thinks",
  );
});

test('GUARD: the fix is actually wired into consume()\'s result branch, not merely defined', () => {
  const code = agentSdkCode();

  // FOUND BY MUTATION (see this test's history): asserting the mere PRESENCE of
  // `shouldRecycleForBudget` in the file is VACUOUS — deleting the call site
  // from the consume loop leaves the policy function's own definition, which
  // still contains the name, so the check passed on a build where the fix was
  // inert and the queue starved exactly as before. Scope the assertion to the
  // CONSUME LOOP's slice, and assert on the CALL SITE, not the identifier.
  const start = code.indexOf('async function consume(');
  assert.notEqual(start, -1, 'consume() not found in agent-sdk.ts — was it renamed?');
  const rest = code.slice(start);
  const end = rest.indexOf('\nasync function ');
  const consumeBody = end === -1 ? rest : rest.slice(0, end);
  // Positive control: the slice is really consume(), not an empty/misaligned
  // string that would make every assertion below pass for free.
  assert.ok(consumeBody.length > 1000, 'the consume() slice came back suspiciously short');
  assert.match(consumeBody, /session\.turnGate = null;/, 'the consume() slice does not contain the turn gate');

  // The wiring itself: consume() must CALL the recycle on budget exhaustion.
  assert.match(
    consumeBody,
    /recycleForBudget\(/,
    'consume() must call recycleForBudget() when the budget is exhausted — ' +
      'without this call the #69 fix is inert and the queue still starves',
  );
  assert.match(
    consumeBody,
    /error_max_turns/,
    "consume() must branch on the `error_max_turns` result subtype — it arrives as a " +
      'RESULT, not a throw, which is the whole reason the queue starved',
  );
  // And the policy must be the thing deciding, not an inlined guess.
  assert.match(
    code,
    /shouldRecycleForBudget\(/,
    'the runaway decision must go through shouldRecycleForBudget()',
  );
});

test('GUARD: the terminal stop reason is persisted for the sidebar to render', () => {
  // #69's non-negotiable: the state must surface in the UI, not only the log.
  // A persisted field is what survives the session teardown the recycle does.
  const types = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'types.ts'), 'utf8');
  assert.match(
    types,
    /lastStopReason\?:/,
    'Workspace must carry lastStopReason so the sidebar can show WHY a session stopped',
  );
});
