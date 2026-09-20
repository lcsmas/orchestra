// #162 — coalesce UNSTARTED queued wake-order turns.
//
// During a long turn an ack mid-turn re-arms the ack-based re-wake (T117.2);
// new mail meanwhile fires a fresh wake order that parks behind the running
// turn, so identical orders pile up ('2 queued', canary-5 screenshot). The fix
// coalesces at DELIVERY time in the queue: a fresh wake order MERGES into an
// UNSTARTED wake-order turn already queued (union of named runs) instead of
// appending a second turn; a STARTED turn is never touched.
//
// The decision `sdkSend` makes is the pure `coalesceWakeOrderInto` (agent-sdk.ts
// is un-importable under the strip-types runner — its `./platform` dir-import
// throws ERR_UNSUPPORTED_DIR_IMPORT, so importing the shipped SEAM directly is
// impossible). This drives THAT shipped symbol — the same one sdkSend calls —
// through a queue model that replays sdkSend's exact apply (find→setText, else
// push), and a source-pin asserts sdkSend still routes through it so the test
// cannot drift onto a copy. Each arm is mutation-proven: the disproof lives in
// the arm comments (which mutation of the shipped decision reddens it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  coalesceWakeOrderInto,
  buildWakeOrder,
  wakeOrderRuns,
  isWakeOrder,
} from './bus-wake.ts';

// ── A faithful model of the session prompt queue, enqueuing EXACTLY as sdkSend
//    does: consult the shipped `coalesceWakeOrderInto`; on a hit, rewrite the
//    target entry's text IN PLACE (no push, no new turn); otherwise push a fresh
//    turn. `started` marks the running turn — which sdkSend has ALREADY shifted
//    off `session.queue`, so the model only ever exposes UNSTARTED entries to the
//    decision (the running turn is held separately). This mirrors the invariant
//    that makes "never touch a started turn" true by construction. ──
interface Entry {
  uuid: string;
  text: string;
}
class QueueModel {
  /** Entries still queued (all UNSTARTED). */
  queue: Entry[] = [];
  /** The turn that has STARTED (shifted off the queue), if any — never a merge
   *  target, exactly as in promptStream. */
  started: Entry | null = null;
  private n = 0;

  /** Replays sdkSend's enqueue decision+apply for a wake/ordinary send. Returns
   *  the uuid of the turn this send became (a fresh one, or the coalesced one). */
  enqueue(text: string): string {
    const decision = coalesceWakeOrderInto(
      text,
      this.queue.map((e) => e.text),
    );
    if (decision) {
      const target = this.queue[decision.mergeIndex];
      target.text = decision.mergedText; // setQueueEntryText, in place
      return target.uuid;
    }
    const uuid = `u${this.n++}`;
    this.queue.push({ uuid, text }); // session.queue.push(msg)
    return uuid;
  }

  /** Start the head of the queue — promptStream's `session.queue.shift()`. */
  startHead(): void {
    const head = this.queue.shift();
    if (head) this.started = head;
  }
}

const wake = (...runs: string[]) => buildWakeOrder(runs);

// ─── Arm 1 (CORE): the live repro — reader mid-long-turn, ack + new mail x2 →
//     exactly ONE unstarted wake-order turn, naming the UNION of runs.
//     Pre-fix (mutation: coalesceWakeOrderInto returns null) → TWO queued turns.
//     Disproof: if the decision did not union, the single turn would name only
//     one run's set; the union assertion below would fail. ───
test('#162 arm1: two wake orders mid-long-turn coalesce into ONE turn naming the union', () => {
  const s = new QueueModel();
  // A long turn is running: it was shifted off the queue and is now `started`.
  s.enqueue('do a lot of work'); // the human's long prompt…
  s.startHead(); //               …now the running turn (unstarted queue is empty)
  assert.equal(s.queue.length, 0, 'precondition: nothing queued behind the running turn');

  // First wake order parks behind the running turn (run A pending).
  s.enqueue(wake('run-A'));
  // A second wake order arrives while the first is still UNSTARTED (run B now
  // pending too). Pre-fix this appended a 2nd turn → the '2 queued' screenshot.
  s.enqueue(wake('run-B'));

  assert.equal(s.queue.length, 1, 'exactly ONE unstarted wake-order turn is queued');
  const only = s.queue[0];
  assert.ok(isWakeOrder(only.text), 'the surviving turn is still a wake order');
  assert.deepEqual(
    wakeOrderRuns(only.text),
    ['run-A', 'run-B'],
    'the surviving turn names the UNION of both orders (sorted, deduped)',
  );
  // The running turn is untouched (arm 2 spot-check under load).
  assert.equal(s.started?.text, 'do a lot of work');
});

// A third wake order folds into the SAME single turn — the queue never grows to
// two while a wake order is already parked unstarted.
test('#162 arm1b: a run of wake orders collapses to one turn, not a pair', () => {
  const s = new QueueModel();
  s.enqueue('long prompt');
  s.startHead();
  s.enqueue(wake('run-A'));
  s.enqueue(wake('run-B'));
  s.enqueue(wake('run-C', 'run-A')); // overlapping + new run
  assert.equal(s.queue.length, 1);
  assert.deepEqual(wakeOrderRuns(s.queue[0].text), ['run-A', 'run-B', 'run-C']);
});

// ─── Arm 2: a STARTED wake turn is NEVER mutated; a wake arriving after it
//     starts queues a FRESH one (level-trigger preserved).
//     Disproof: if the decision could see the started turn (mutation: model
//     exposes `started` to coalesceWakeOrderInto, i.e. the running turn were left
//     ON the queue), it would merge into it and the "fresh turn queued" assertion
//     would fail. sdkSend is immune because promptStream shifts the turn off the
//     queue BEFORE it starts — the queue only ever holds unstarted entries. ───
test('#162 arm2: a started wake turn is not mutated; a later wake queues fresh', () => {
  const s = new QueueModel();
  s.enqueue(wake('run-A')); // a lone wake order…
  s.startHead(); //            …starts running (shifted off the queue)
  const startedTextBefore = s.started!.text;
  assert.equal(s.queue.length, 0);

  // A new wake order arrives AFTER the first started. It must NOT touch the
  // running turn — it queues fresh (level-trigger: a wake after the check began
  // is a distinct check the reader must still run).
  s.enqueue(wake('run-B'));
  assert.equal(s.started!.text, startedTextBefore, 'the started turn is byte-identical — never mutated');
  assert.equal(s.queue.length, 1, 'the post-start wake queued a FRESH turn');
  assert.deepEqual(wakeOrderRuns(s.queue[0].text), ['run-B'], 'the fresh turn names only its own run');
});

// ─── Arm 3: wake orders and ORDINARY prompts never coalesce with each other;
//     #112's duplicate-prompt guard is unaffected.
//     Disproof: if the guard keyed on only ONE side (mutation: drop the incoming
//     `isWakeOrder` check, or match a non-wake queued entry), an ordinary prompt
//     would merge into a wake order (or vice-versa) and the counts below break. ───
test('#162 arm3: a wake order never coalesces with an ordinary prompt (either direction)', () => {
  // Wake queued, ordinary prompt arrives → prompt does NOT fold into the wake.
  {
    const s = new QueueModel();
    s.enqueue('long prompt');
    s.startHead();
    s.enqueue(wake('run-A'));
    s.enqueue('please also do X'); // ordinary — must NOT merge
    assert.equal(s.queue.length, 2, 'ordinary prompt stays a separate turn');
    assert.ok(isWakeOrder(s.queue[0].text));
    assert.equal(s.queue[1].text, 'please also do X');
  }
  // Ordinary prompt queued, wake order arrives → wake does NOT fold into the
  // ordinary prompt (no wake-order entry to merge into) → fresh turn.
  {
    const s = new QueueModel();
    s.enqueue('long prompt');
    s.startHead();
    s.enqueue('please do X');
    s.enqueue(wake('run-A')); // wake — must NOT merge into the ordinary prompt
    assert.equal(s.queue.length, 2, 'wake order stays a separate turn');
    assert.equal(s.queue[0].text, 'please do X');
    assert.ok(isWakeOrder(s.queue[1].text));
  }
  // Two identical ordinary prompts never coalesce here (#112 owns that path).
  {
    const s = new QueueModel();
    s.enqueue('long prompt');
    s.startHead();
    s.enqueue('same body');
    s.enqueue('same body');
    assert.equal(s.queue.length, 2, '#162 does not touch ordinary-prompt queueing');
  }
});

// The pure decision itself: null for non-wake incoming and for an empty/wake-less
// queue; a hit only when BOTH sides are wake orders.
test('#162 decision: coalesceWakeOrderInto is keyed on isWakeOrder on both sides', () => {
  assert.equal(coalesceWakeOrderInto('hello', [wake('r1')]), null, 'non-wake incoming → null');
  assert.equal(coalesceWakeOrderInto(wake('r1'), []), null, 'empty queue → null');
  assert.equal(coalesceWakeOrderInto(wake('r1'), ['ordinary', 'text']), null, 'no queued wake → null');
  const hit = coalesceWakeOrderInto(wake('r2'), ['ordinary', wake('r1'), 'more']);
  assert.deepEqual(hit, { mergeIndex: 1, mergedText: wake('r1', 'r2') }, 'merges into the queued wake, union of runs');
});

// ─── Arm 4: latency for the idle-reader path is untouched — a lone wake order to
//     an EMPTY unstarted queue still queues normally (returns null → push), so a
//     nominal sub-second wake is not delayed or dropped by coalescing. ───
test('#162 arm4: a lone wake to an idle reader queues normally (no coalescing)', () => {
  const s = new QueueModel();
  const uuid = s.enqueue(wake('run-A')); // idle: no running turn, empty queue
  assert.equal(s.queue.length, 1, 'the lone wake queued a turn as before');
  assert.equal(s.queue[0].uuid, uuid, 'a FRESH turn (its own uuid), not a coalesced one');
  assert.deepEqual(wakeOrderRuns(s.queue[0].text), ['run-A']);
});

// ─── Source-pin: sdkSend routes its enqueue decision through the shipped
//     `coalesceWakeOrderInto`, so this test drives the SAME symbol production
//     does — not a look-alike (LESSONS #132: a test that proves a neighbour). ───
test('#162 source-pin: sdkSend calls coalesceWakeOrderInto', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, '../main/agent-sdk.ts'), 'utf8');
  assert.match(
    src,
    /coalesceWakeOrderInto\(\s*sendText\s*,/,
    'sdkSend must consult coalesceWakeOrderInto on the send text',
  );
  assert.match(src, /import \{ coalesceWakeOrderInto[^}]*\} from '\.\.\/shared\/bus-wake\.ts'/);
});
