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
//   (A) An EXECUTING reproduction of the failure. `agent-sdk.ts` cannot be
//       imported by this runner (it pulls in `platform`/`store`/`pty`, i.e.
//       Electron), so the queue pump is re-executed here in the shape the real
//       one has. That makes it a MODEL, and a model that was faithful when
//       written goes stale silently — so:
//
//   (B) SOURCE-BINDING GUARDS that read the real agent-sdk.ts and refuse a
//       verdict if the structural properties the model assumes stop holding.
//
// The mechanism reproduced here was MEASURED against the real SDK on
// 2026-08-25 (docs/research/issue-69-maxturns-findings.md, probes 4-6), NOT
// inferred from sdk.d.ts. An earlier draft of this file modelled `maxTurns` as
// a session-lifetime budget that starved the queue one entry per round-trip.
// Driving a real `query()` REFUTED that:
//
//   • The cap is PER-TURN. With maxTurns:1, prompt P1 returns
//     `error_max_turns` and P2 then runs with a FULL budget. A first
//     exhaustion is benign, self-recovering, and does NOT throw.
//   • The SECOND exhaustion is the failure: it THROWS ("Reached maximum
//     number of turns"), killing the query and discarding every prompt still
//     queued behind it. Measured twice, identically: 5 prompts yielded, 2
//     results seen, 3 never consumed.
//
// So #69's starved queue is a hard kill on the second exhaustion, not a slow
// drain — and the recovery belongs in consume()'s catch/finally (where the
// throw lands), not in its result branch.

const ROOT = process.cwd(); // pnpm test runs from the repo root
const AGENT_SDK = path.join(ROOT, 'src', 'main', 'agent-sdk.ts');

/** What a yielded turn did, per MEASURED SDK behaviour. */
type Outcome = 'ran' | 'exhausted';

interface RunResult {
  /** Entries that reached the model (including ones whose turn then exhausted). */
  ran: string[];
  /** Entries still queued when the query DIED — discarded by the throw. This is
   *  #69's starved queue. */
  discarded: string[];
  /** Terminal notices the human would see. */
  surfaced: string[];
  /** Number of times a replacement query was booted. */
  recycles: number;
  /** Did the query die (second-exhaustion throw, or a refused runaway)? */
  died: boolean;
}

/**
 * Re-execute the measured failure: per-TURN budget, first exhaustion benign,
 * SECOND exhaustion throws and takes the still-queued prompts with it.
 *
 * `exhausting` names the entries whose turn needs more round-trips than the
 * per-turn cap allows. Modelling that as a per-ENTRY fact rather than a running
 * counter is what keeps this faithful to a per-turn cap — the refuted model's
 * running counter is exactly what made it wrong.
 */
function runQueuePump(opts: {
  queue: string[];
  exhausting: string[];
  fixed: boolean;
  now?: number;
  priorRecycles?: number[];
}): RunResult {
  const queue = [...opts.queue];
  const exhausting = new Set(opts.exhausting);
  const ran: string[] = [];
  const surfaced: string[] = [];
  let recycles = 0;
  let history = opts.priorRecycles ? [...opts.priorRecycles] : [];
  const now = opts.now ?? 1_000_000;
  // Exhaustions seen by the CURRENT query. Reset by a recycle: a fresh query()
  // starts the count over, which is the whole point of resuming.
  let exhaustionsThisQuery = 0;
  let died = false;

  while (queue.length > 0) {
    const entry = queue.shift()!;
    const outcome: Outcome = exhausting.has(entry) ? 'exhausted' : 'ran';
    ran.push(entry);

    if (outcome === 'ran') continue;

    exhaustionsThisQuery += 1;
    // MEASURED: the FIRST exhaustion is a benign result — no throw, and the
    // next queued turn runs normally. There is nothing to recover.
    if (exhaustionsThisQuery < 2) continue;

    // MEASURED: the SECOND one throws and kills the query. Everything still
    // queued dies with it.
    if (!opts.fixed) {
      died = true;
      return { ran, discarded: queue, surfaced, recycles, died };
    }

    // FIXED: carry the queue to a resumed session, bounded by the guard.
    const decision = shouldRecycleForBudget(history, now);
    history = decision.history;
    surfaced.push(decision.reason);
    if (!decision.recycle) {
      died = true;
      return { ran, discarded: queue, surfaced, recycles, died };
    }
    recycles += 1;
    exhaustionsThisQuery = 0; // a fresh query() starts over
  }

  return { ran, discarded: queue, surfaced, recycles, died };
}

// ─── (A) The measurement: unfixed arm vs fixed arm, SAME rig ────────────────

// Fixture note: TWO exhausting entries, because the measured failure needs a
// SECOND exhaustion to fire. A fixture with only one would exercise the benign
// case and prove nothing — the trap of building a fixture from the defect's
// DESCRIPTION rather than its measured code path.
const QUEUE = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
const EXHAUSTING = ['m2', 'm4'];

test('#69 UNFIXED ARM: the second exhaustion kills the query and discards the queue', () => {
  const res = runQueuePump({ queue: QUEUE, exhausting: EXHAUSTING, fixed: false });

  // Positive control: the rig CAN run turns, so "the rest died" is a finding
  // rather than a dead harness. m3 running is the load-bearing one — it proves
  // the FIRST exhaustion (m2) was benign, the per-turn behaviour that refuted
  // the original model.
  assert.deepEqual(res.ran, ['m1', 'm2', 'm3', 'm4'], 'turns run until the second exhaustion');

  assert.ok(res.died, 'unfixed: the query dies on the second exhaustion');
  assert.deepEqual(res.discarded, ['m5', 'm6'], 'unfixed: the still-queued prompts are discarded');
  assert.deepEqual(res.surfaced, [], 'unfixed: nothing is surfaced to the human');
  assert.equal(res.recycles, 0, 'unfixed: no replacement query is booted');
});

test('#69 FIXED ARM: the same queue survives, and the recovery is announced', () => {
  const res = runQueuePump({ queue: QUEUE, exhausting: EXHAUSTING, fixed: true });

  assert.deepEqual(res.ran, QUEUE, 'fixed: every queued message reaches the model');
  assert.deepEqual(res.discarded, [], 'fixed: nothing is discarded');
  assert.ok(!res.died, 'fixed: the session is not left dead');
  assert.equal(res.recycles, 1, 'fixed: one resume, on the second exhaustion');
  assert.equal(res.surfaced.length, 1, 'fixed: the recovery is announced');
  assert.match(res.surfaced[0], /turn limit/i, 'the notice names the turn limit as the cause');
});

test('#69 a FIRST exhaustion alone is benign and needs no recovery (measured)', () => {
  // The property that refuted the original model, pinned so the fix cannot
  // become trigger-happy and tear down healthy sessions on a benign event.
  const res = runQueuePump({ queue: QUEUE, exhausting: ['m2'], fixed: true });
  assert.deepEqual(res.ran, QUEUE, 'every message still runs');
  assert.equal(res.recycles, 0, 'no query is recycled for a single exhaustion');
  assert.deepEqual(res.surfaced, [], 'and nothing is announced — there is nothing to announce');
});

test('#69 the runaway guard still stops a genuine loop — and says so', () => {
  const now = 5_000_000;
  const prior = [now - 1000, now - 2000, now - 3000]; // allowance already spent
  const res = runQueuePump({
    queue: QUEUE,
    exhausting: EXHAUSTING,
    fixed: true,
    now,
    priorRecycles: prior,
  });
  assert.equal(res.recycles, 0, 'a runaway must NOT be granted a fresh query');
  assert.ok(res.died, 'it stops');
  assert.deepEqual(res.discarded, ['m5', 'm6'], 'the remaining queue is reported, not eaten');
  assert.match(res.surfaced[0] ?? '', /runaway|Stopped/i, 'and the stop is explained');
});

// ─── The policy itself ──────────────────────────────────────────────────────

test('shouldRecycleForBudget prunes recycles outside the window', () => {
  const now = 10_000_000;
  const stale = [
    now - RECYCLE_WINDOW_MS - 1,
    now - RECYCLE_WINDOW_MS - 2,
    now - RECYCLE_WINDOW_MS - 3,
  ];
  const d = shouldRecycleForBudget(stale, now);
  assert.equal(d.recycle, true, 'stale recycles must not permanently wedge a workspace');
  assert.deepEqual(d.history, [now], 'stale entries are pruned, not accumulated');

  // CONTROL: the SAME count inside the window DOES block, proving the guard can
  // fire at all and that the difference above is the WINDOW, not the count.
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
 *  consume loop keeps delivering messages, so a SECOND budget death can land
 *  mid-teardown. The guard must therefore be set SYNCHRONOUSLY, before the
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
  await Promise.all([recycle(), recycle()]);
  return entries;
}

test('#69 the recycle guard is set before the first await (re-entry race)', async () => {
  assert.equal(
    await raceTwoExhaustions(true),
    1,
    'a second budget death arriving mid-teardown must NOT start a second recycle',
  );
  // CONTROL: the same rig with only the LATE flag (the first draft) lets both
  // in — proving this test can fail, and that the sync guard is what fixes it
  // rather than the rig being unable to express the race.
  assert.equal(
    await raceTwoExhaustions(false),
    2,
    'control: without the synchronous flag the race IS reachable (so the guard is load-bearing)',
  );
});

// ─── (B) Source-binding guards — refuse a verdict if the model went stale ───

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

/** consume()'s body, sliced out so assertions bind to it rather than to the
 *  whole file (where a policy function's own definition can satisfy a check the
 *  call site was supposed to). */
function consumeBody(code: string): string {
  const start = code.indexOf('async function consume(');
  assert.notEqual(start, -1, 'consume() not found in agent-sdk.ts — was it renamed?');
  const rest = code.slice(start);
  const end = rest.indexOf('\nasync function ');
  const body = end === -1 ? rest : rest.slice(0, end);
  // Positive control: the slice really is consume(), not an empty or misaligned
  // string that would make every assertion below pass for free.
  assert.ok(body.length > 1000, 'the consume() slice came back suspiciously short');
  assert.match(body, /session\.turnGate = null;/, 'the consume() slice lacks the turn gate');
  return body;
}

test('GUARD: session.recycling is set synchronously in the real source', () => {
  const code = agentSdkCode();
  const start = code.indexOf('async function recycleForBudget(');
  assert.notEqual(start, -1, 'recycleForBudget() not found — was it renamed?');
  const body = code.slice(start, start + 1600);
  assert.ok(body.length > 300, 'the recycleForBudget slice came back suspiciously short');
  const setAt = body.indexOf('session.recycling = true');
  const firstAwait = body.indexOf('await ');
  assert.notEqual(setAt, -1, 'recycleForBudget must set session.recycling');
  assert.notEqual(firstAwait, -1, 'recycleForBudget should contain an await');
  assert.ok(
    setAt < firstAwait,
    'session.recycling must be set BEFORE the first await — a guard set after a ' +
      'suspension point cannot stop the re-entry it exists to stop (#57 shape)',
  );
});

test('GUARD: maxTurns is still a single construction-time literal (#69 premise)', () => {
  const code = agentSdkCode();
  const hits = code.match(/maxTurns:/g) ?? [];
  assert.equal(
    hits.length,
    1,
    `expected exactly ONE maxTurns option site in agent-sdk.ts, found ${hits.length}. ` +
      'More than one means the budget shape changed and this model must be re-derived.',
  );
});

test('GUARD: the result branch is still what reopens the turn gate', () => {
  const code = agentSdkCode();
  assert.match(code, /msg\.type === 'result'/, "the `result` branch vanished from agent-sdk.ts");
  assert.match(code, /session\.turnGate = null;/, 'the turn-gate reset vanished');
});

test('GUARD: the recovery is wired where the throw LANDS (catch/finally), not the result branch', () => {
  const code = agentSdkCode();
  const body = consumeBody(code);

  // TWO lessons are baked into this guard, both learned the hard way:
  //  1. Asserting the mere PRESENCE of `shouldRecycleForBudget` in the file is
  //     VACUOUS — deleting the call site leaves the policy function's own
  //     definition, which contains the name, so it passed on an inert build.
  //  2. The first version pinned the wiring to consume()'s RESULT branch.
  //     Driving the real SDK showed the killing exhaustion arrives as a THROW,
  //     so the recovery moved to catch/finally — and this guard stayed GREEN
  //     through that relocation, i.e. it was not binding what it claimed to.
  assert.match(
    body,
    /recycleForBudget\(/,
    'consume() must call recycleForBudget() — without this the #69 fix is inert',
  );
  const catchAt = body.indexOf('} catch (err)');
  const callAt = body.indexOf('recycleForBudget(');
  assert.notEqual(catchAt, -1, 'consume() should still have a catch block');
  assert.ok(
    callAt > catchAt,
    'recycleForBudget() must be invoked from the catch/finally path — MEASURED: the ' +
      'killing exhaustion THROWS, so a result-branch-only hook never fires for it',
  );
  // The benign first exhaustion must still be NOTED in the result branch, or
  // the catch cannot tell a budget death from an unrelated crash.
  assert.match(body, /sawMaxTurns = true/, 'the result branch must record error_max_turns');
  assert.match(body, /error_max_turns/, 'consume() must branch on the error_max_turns subtype');
  assert.match(code, /shouldRecycleForBudget\(/, 'the runaway decision must go through the policy');
});

test('GUARD: consume() does not early-return from finally (it would swallow the error)', () => {
  const code = agentSdkCode();
  const body = consumeBody(code);
  const finallyAt = body.indexOf('} finally {');
  assert.notEqual(finallyAt, -1, 'consume() should still have a finally block');
  const tail = body.slice(finallyAt);
  // A bare `return;` inside finally swallows the in-flight exception AND skips
  // `sessions.delete(wsId)`, leaving a dead session in the map for
  // ensureSession to hand back as live. An earlier draft of this fix did
  // exactly that.
  assert.doesNotMatch(
    tail,
    /\n\s+return;/,
    "no bare `return;` inside consume()'s finally — it swallows the exception and " +
      'skips sessions.delete(), stranding a dead session in the map',
  );
  assert.match(tail, /sessions\.delete\(/, 'the finally must still drop the session');
});

test('GUARD: the terminal stop reason is persisted for the sidebar to render', () => {
  // #69's non-negotiable: the state must surface in the UI, not only the log.
  const types = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'types.ts'), 'utf8');
  assert.match(
    types,
    /lastStopReason\?:/,
    'Workspace must carry lastStopReason so the sidebar can show WHY a session stopped',
  );
});
