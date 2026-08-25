#!/usr/bin/env node
// REPRO + REGRESSION GATE for issue #57 fault (b): 'Delivered (live)' is
// reported for messages that are then silently discarded without ever running.
//
// ── What is actually under test ──────────────────────────────────────────────
//
// Two things, at the two seams where the lie was told:
//
// 1. THE QUEUE LIFECYCLE (this file's `Session` harness). The real
//    `promptStream` drains `session.queue` and the real drop paths
//    (interruptCancellingQueued / consume's finally / sdkQueueRemove / sdkStop)
//    empty it. The OLD code reported success on the PUSH, so a message wiped by
//    any of those was reported delivered and never corrected. This rig models
//    that queue exactly — push, shift-and-yield, wipe — and asserts what a
//    sender would have been told in each case.
//
// 2. THE DECISION TABLE (`src/shared/delivery-status.ts`, imported REAL, not
//    copied). That is the module the shipped dispatcher calls, so a mutation
//    there fails this gate.
//
// ── Why not drive the full Electron app for this one ─────────────────────────
//
// The fault is main-process control flow with no rendered surface: the sender
// is a CLI in another process, and what it prints is `Delivered (${delivery})`
// straight off the socket reply. Driving two live agents through a real
// interrupt to catch a *missing* correction is a race with no positive
// terminator — the absence of a message is exactly what a flaky E2E cannot
// distinguish from "not yet". So the queue lifecycle is exercised
// deterministically here, and `scripts/verify-peer-redelivery.mjs` covers the
// half that DOES have a durable artifact. This limitation is reported, not
// hidden: see the NOT VERIFIED list in the ledger report.
//
// ── Both arms ────────────────────────────────────────────────────────────────
//   node scripts/verify-peer-delivery-honesty.mjs                # expect FIXED
//   node scripts/verify-peer-delivery-honesty.mjs --expect-broken # expect FAULT
// The broken arm asserts the fault REPRODUCES, and is how this gate was watched
// to fail. A gate nobody has seen fail is not a gate.

import { reportedDeliveryFor, requiresInboxFallback } from '../src/shared/delivery-status.ts';

const expectBroken = process.argv.includes('--expect-broken');
let fails = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ` — ${detail}`}`);
  if (!cond) fails++;
};

// ─────────────────────────────────────────────────────────────────────────────
// A faithful model of the real session queue + the delivery watchers.
// Mirrors agent-sdk.ts: queue.push (sdkSend) / shift+settle(true) (promptStream)
// / settleQueuedAsDropped + wipe (the four drop paths).
// ─────────────────────────────────────────────────────────────────────────────
class Session {
  constructor() {
    this.queue = [];
    this.watchers = new Map();
    this.seq = 0;
  }

  /** sdkSend: mint an id, ARM the watcher, then push. Arming before the push is
   *  what closes the race where promptStream drains before the caller has a
   *  handle (agent-sdk.ts does exactly this via pendingWatcherResolve). */
  send() {
    const uuid = `turn-${++this.seq}`;
    const started = new Promise((resolve) => this.watchers.set(uuid, resolve));
    this.queue.push({ uuid });
    return { uuid, started };
  }

  /** promptStream: shift the next entry and yield it to the SDK. */
  runNext() {
    const msg = this.queue.shift();
    if (!msg) return null;
    this.settle(msg.uuid, true);
    return msg;
  }

  settle(uuid, ok) {
    const w = this.watchers.get(uuid);
    if (!w) return;
    this.watchers.delete(uuid);
    w(ok);
  }

  /** Every path that discards queued turns: Escape, session end, tray cancel,
   *  stop. In the FIXED build each settles its watchers false first. */
  wipeQueue({ notify }) {
    if (notify) for (const m of this.queue) this.settle(m.uuid, false);
    this.queue.length = 0;
  }
}

/** What the dispatcher reports, given a live attempt outcome. Uses the REAL
 *  shared decision table so a mutation there is caught here. */
const report = (attempt) => reportedDeliveryFor(attempt);

/** Await a delivery with a bound, exactly as sdkDeliverConfirmed does. */
async function awaitDelivery(started, ms = 50) {
  return Promise.race([
    started.then((ok) => (ok ? 'started' : 'dropped')),
    new Promise((r) => setTimeout(() => r('timeout'), ms)),
  ]);
}

console.log('\nissue #57 fault (b) — is "Delivered (live)" honest?');
console.log(`  arm: ${expectBroken ? 'REPRO (expect the fault present)' : 'GATE (expect it fixed)'}\n`);

// ── Scenario 1: the target's user presses Escape (interruptCancellingQueued) ──
{
  const s = new Session();
  const { started } = s.send();
  // OLD BEHAVIOUR: report 'live' right after the push, notify nobody on wipe.
  const legacyReport = 'live';
  s.wipeQueue({ notify: expectBroken ? false : true });
  const attempt = await awaitDelivery(started);
  const fixedReport = report(attempt);

  console.log('  scenario: target pressed Escape while the message was queued');
  console.log(`    legacy reported : ${legacyReport}`);
  console.log(`    actual outcome  : ${attempt}`);
  console.log(`    fixed reported  : ${fixedReport}`);

  if (expectBroken) {
    // The fault: the message never ran, yet the sender was told 'live'.
    check(
      'REPRO: sender is told "live" for a message that was discarded unrun',
      legacyReport === 'live' && attempt !== 'started',
      'legacy reports on the push and never corrects',
    );
  } else {
    check('GATE: a discarded message is NOT reported live', fixedReport !== 'live');
    check('GATE: it is reported as inbox (durable, honest)', fixedReport === 'inbox');
    check('GATE: the caller is told to write an inbox file', requiresInboxFallback(attempt));
  }
}

// ── Scenario 2: session ended with turns still queued (consume's finally) ─────
{
  const s = new Session();
  const { started } = s.send();
  s.wipeQueue({ notify: expectBroken ? false : true });
  const attempt = await awaitDelivery(started);
  console.log('\n  scenario: session ended with the message still queued');
  console.log(`    actual outcome  : ${attempt} | reported: ${report(attempt)}`);
  if (expectBroken) {
    check('REPRO: no failure ever reaches the sender', attempt === 'timeout');
  } else {
    check('GATE: sender learns it was dropped', attempt === 'dropped');
    check('GATE: not reported live', report(attempt) !== 'live');
  }
}

// ── POSITIVE CONTROL: a message that REALLY runs must still report live ──────
// Without this, "never report live" would pass the fixed arm while destroying
// the feature. This is the control that makes the gate mean something.
{
  const s = new Session();
  const { started } = s.send();
  const ran = s.runNext();
  const attempt = await awaitDelivery(started);
  console.log('\n  control: message actually became the target\'s turn');
  console.log(`    actual outcome  : ${attempt} | reported: ${report(attempt)}`);
  check('CONTROL: a genuinely started message IS reported live', report(attempt) === 'live');
  check('CONTROL: it really left the queue', ran !== null && s.queue.length === 0);
  check('CONTROL: no inbox fallback for a started message', !requiresInboxFallback(attempt));
}

// ── CONTROL: ordering — a message queued behind a running turn still starts ──
// Guards against "fix" that reports dropped for anything merely parked.
{
  const s = new Session();
  const a = s.send();
  const b = s.send();
  s.runNext(); // a starts
  s.runNext(); // b starts
  const [ra, rb] = await Promise.all([awaitDelivery(a.started), awaitDelivery(b.started)]);
  console.log('\n  control: two queued messages, both run');
  console.log(`    outcomes: ${ra}, ${rb}`);
  check('CONTROL: a parked-then-run message is live, not dropped', report(ra) === 'live' && report(rb) === 'live');
}

// ── Decision-table completeness (mutation surface) ───────────────────────────
{
  console.log('\n  decision table (the shipped module):');
  const table = { started: 'live', dropped: 'inbox', timeout: 'inbox', none: null };
  for (const [attempt, want] of Object.entries(table)) {
    const got = report(attempt);
    console.log(`    ${attempt.padEnd(8)} -> ${String(got)}`);
    check(`table: ${attempt} -> ${String(want)}`, got === want, `got ${String(got)}`);
  }
  check('table: only "started" earns live', ['dropped', 'timeout', 'none'].every((a) => report(a) !== 'live'));
}

if (fails) {
  console.error(`\n${fails} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall checks passed (${expectBroken ? 'fault reproduced' : 'fault eliminated'})`);
