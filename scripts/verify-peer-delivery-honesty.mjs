#!/usr/bin/env node
// REPRO + REGRESSION GATE for issue #57 fault (b): 'Delivered (live)' reported
// for messages that are then silently discarded, or delivered twice.
//
// ══ WHY THIS FILE WAS REWRITTEN — read before changing it ════════════════════
//
// The FIRST version of this rig modelled `Session.send()` as
//     new Promise(resolve => this.watchers.set(uuid, resolve))
// registering the watcher DIRECTLY, SYNCHRONOUSLY, keyed to its own uuid.
//
// The real path does not do that. It routes the registrar through the call
// stack across `await ensureSession` — and the first implementation parked that
// registrar in a MODULE-LEVEL GLOBAL. So the model could not express the very
// defect that lived at the seam it certified: two concurrent senders aliasing
// each other's watcher. A §3b reviewer ran that rig against the candidate and
// got `all checks passed (fault eliminated)`, RC=0, WHILE THE HEADLINE FAULT
// WAS LIVE — a sender being told `Delivered (live)` for an Escaped message.
//
// The lesson is specific and worth more than the fix: a model that omits the
// SUSPENSION POINT cannot catch a concurrency bug, and it fails in the
// *passing* direction, which is the direction nobody investigates. So this rig
// now transcribes the real control flow including every await, and every
// scenario is driven CONCURRENTLY as well as sequentially.
//
// ── What it covers ───────────────────────────────────────────────────────────
//   F1  two concurrent senders must not alias watchers (the registrar is a
//       PARAMETER now, not a module global)
//   F2  multiplicity: N pending entries sharing a body are cancelled by at most
//       N transcript occurrences — never all-by-one (imports the REAL module)
//   F3  a timed-out turn must be WITHDRAWN from the queue, or the inbox
//       fallback double-delivers it
//   plus the original honest-status table (REAL src/shared/delivery-status.ts)
//
// ── Both arms ────────────────────────────────────────────────────────────────
//   node scripts/verify-peer-delivery-honesty.mjs                 # expect FIXED
//   node scripts/verify-peer-delivery-honesty.mjs --expect-broken # expect FAULT
// The broken arm re-creates the OLD module-global/no-withdraw behaviour and
// asserts each fault reproduces. Every fault below has been SEEN to fail there.

import { reportedDeliveryFor, requiresInboxFallback } from '../src/shared/delivery-status.ts';
import {
  countConsumedKeys,
  filterUnconsumedPrompts,
  pendingPromptKey,
} from '../src/shared/pending-prompts.ts';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const expectBroken = process.argv.includes('--expect-broken');
let fails = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ` — ${detail}`}`);
  if (!cond) fails++;
};

// ═════════════════════════════════════════════════════════════════════════════
// A transcription of the REAL control flow, including the suspension points.
// `legacy: true` reinstates the two defects the review found, so the repro arm
// exercises the actual historical behaviour rather than a caricature.
// ═════════════════════════════════════════════════════════════════════════════
class Manager {
  constructor({ legacy }) {
    this.legacy = legacy;
    this.queue = [];
    this.watchers = new Map();
    this.n = 0;
    /** The module-level singleton the FIRST implementation used (the F1 bug). */
    this.pendingWatcherResolve = null;
  }

  /** Mirrors agent-sdk.ts `sdkSend`. The `await` is the load-bearing detail:
   *  `ensureSession` suspends between the caller arming a watcher and this
   *  function minting the uuid that the watcher must be keyed to. */
  async sdkSend(onTurnQueued) {
    await new Promise((r) => setImmediate(r)); // <- await ensureSession
    const uuid = `turn-${++this.n}`;
    if (this.legacy) {
      // BUGGY: read the module global, which a concurrent send may have
      // overwritten while we were suspended above.
      this.pendingWatcherResolve?.(uuid);
    } else {
      // FIXED: our own caller's registrar, passed down the stack. No aliasing
      // is possible because nothing shared is read.
      onTurnQueued?.(uuid);
    }
    this.queue.push({ uuid });
    return uuid;
  }

  /** Mirrors `sdkSendAwaitingStart`. */
  async sendAwaitingStart(timeoutMs = 60) {
    let uuid;
    let settled = false;
    const outcome = new Promise((resolve) => {
      const register = (id) => {
        this.watchers.set(id, (ok) => {
          settled = true;
          resolve(ok ? 'started' : 'dropped');
        });
      };
      if (this.legacy) {
        this.pendingWatcherResolve = register; // the singleton write
        void this.sdkSend().then((id) => {
          uuid = id;
          this.pendingWatcherResolve = null; // the `finally` that nulls the slot
        });
      } else {
        void this.sdkSend(register).then((id) => {
          uuid = id;
        });
      }
    });
    const timed = new Promise((r) => setTimeout(() => r('timeout'), timeoutMs));
    const result = await Promise.race([outcome, timed]);
    if (result === 'timeout' && !settled && uuid) {
      this.watchers.delete(uuid);
      // FIXED: also WITHDRAW the turn, or it runs while the caller writes the
      // inbox — one live turn plus one inbox drain (F3). Legacy skips this.
      if (!this.legacy) this.dequeueUnstarted(uuid);
    }
    return result;
  }

  /** Mirrors `promptStream` shifting an entry and yielding it. */
  runNext() {
    const msg = this.queue.shift();
    if (msg) this.settle(msg.uuid, true);
    return msg ?? null;
  }

  /** Mirrors `dequeueUnstartedTurn`. */
  dequeueUnstarted(uuid) {
    const i = this.queue.findIndex((m) => m.uuid === uuid);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    return true;
  }

  settle(uuid, ok) {
    const w = this.watchers.get(uuid);
    if (!w) return;
    this.watchers.delete(uuid);
    w(ok);
  }

  /** Mirrors the four discard paths (Escape / session end / tray / stop). */
  wipeQueue() {
    for (const m of this.queue) this.settle(m.uuid, false);
    this.queue.length = 0;
  }
}

const mgr = () => new Manager({ legacy: expectBroken });
const report = (attempt) => reportedDeliveryFor(attempt);

// ═════════════════════════════════════════════════════════════════════════════
// SOURCE-BINDING GUARD — the fix for THIS RIG'S OWN historical defect.
//
// The previous version of this file modelled a control flow that had drifted
// from `agent-sdk.ts`, and therefore returned GREEN while the headline fault
// was live. A model is only evidence while it still matches the thing modelled,
// and nothing was checking that. So before asserting anything, verify the REAL
// source still has the structural properties this model assumes. If it stops
// matching, this rig must FAIL LOUDLY rather than keep certifying a fiction.
// ═════════════════════════════════════════════════════════════════════════════
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '../src/main/agent-sdk.ts'), 'utf8');
  // Strip comments so prose ABOUT the old design cannot satisfy a code check.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

  const props = [
    ['registrar is a PARAMETER of sdkSend', /onTurnQueued\?*:?\s*\(/.test(code)],
    ['sdkSend invokes the passed registrar', /onTurnQueued\?\.\(/.test(code)],
    ['NO module-global watcher registrar survives', !/^let pendingWatcherResolve/m.test(code)],
    ['a timed-out turn is withdrawn from the queue', /dequeueUnstartedTurn\(/.test(code)],
    ['consumption is counted as a multiset', /countConsumedKeys\(/.test(code)],
  ];
  let drift = 0;
  console.log('\n  source-binding guard (does the model still match agent-sdk.ts?)');
  for (const [label, ok] of props) {
    console.log(`    ${ok ? 'ok  ' : 'DRIFT'} ${label}`);
    if (!ok) drift++;
  }
  // Positive control: a string that MUST be present, proving we read real source.
  if (!/export async function sdkSend/.test(code)) {
    console.error('  rig-side: could not read agent-sdk.ts source — refusing a verdict');
    process.exit(2);
  }
  if (drift && !expectBroken) {
    console.error(`\n  MODEL DRIFT: ${drift} property/properties no longer hold in the real source.`);
    console.error('  This rig models control flow it no longer matches — fix the rig, do not trust this run.');
    process.exit(2);
  }
}

console.log('\nissue #57 fault (b) — honest delivery, driven CONCURRENTLY');
console.log(`  arm: ${expectBroken ? 'REPRO (expect the faults present)' : 'GATE (expect them fixed)'}\n`);

// ── CONTROL: sequential send still works (proves the rig discriminates) ──────
{
  const m = mgr();
  const p = m.sendAwaitingStart();
  await new Promise((r) => setTimeout(r, 5));
  m.runNext();
  const res = await p;
  console.log('  CONTROL sequential, turn runs');
  console.log(`    outcome: ${res} -> reported ${report(res)}`);
  check('CONTROL: a sequential started turn is reported live', report(res) === 'live', `got ${res}`);
}

// ── F1: two CONCURRENT senders — A runs, B is Escaped ────────────────────────
// This is the scenario the old rig structurally could not express.
{
  const m = mgr();
  const pa = m.sendAwaitingStart();
  const pb = m.sendAwaitingStart();
  await new Promise((r) => setTimeout(r, 5));
  m.settle(m.queue[0].uuid, true); // A's turn runs
  m.settle(m.queue[1].uuid, false); // B is Escaped -> dropped
  const [ra, rb] = await Promise.all([pa, pb]);
  console.log('\n  F1 CONCURRENT: A runs, B is Escaped');
  console.log(`    A: ${ra} -> ${report(ra)}    B: ${rb} -> ${report(rb)}`);
  const bLies = report(rb) === 'live';
  if (expectBroken) {
    check('REPRO F1: the dropped sender B is told "live"', bLies, `B reported ${report(rb)}`);
  } else {
    check('GATE F1: B was dropped and is NOT told live', !bLies, `B reported ${report(rb)}`);
    check('GATE F1: A actually started and IS told live', report(ra) === 'live', `A=${ra}`);
    check('GATE F1: watchers did not alias', ra === 'started' && rb === 'dropped', `${ra}/${rb}`);
  }
}

// ── F1b: two CONCURRENT senders, BOTH turns run ─────────────────────────────
// The aliasing also corrupts the happy path: one sender times out despite
// having run. Guards against a "fix" that merely reorders the corruption.
{
  const m = mgr();
  const pa = m.sendAwaitingStart();
  const pb = m.sendAwaitingStart();
  await new Promise((r) => setTimeout(r, 5));
  m.runNext();
  m.runNext();
  const [ra, rb] = await Promise.all([pa, pb]);
  console.log('\n  F1b CONCURRENT: both turns run');
  console.log(`    A: ${ra}    B: ${rb}`);
  if (expectBroken) {
    check('REPRO F1b: a sender whose turn RAN is not told live', ra !== 'started' || rb !== 'started', `${ra}/${rb}`);
  } else {
    check('GATE F1b: both senders are told live', report(ra) === 'live' && report(rb) === 'live', `${ra}/${rb}`);
  }
}

// ── F3: a timed-out turn must be WITHDRAWN, not left to run ─────────────────
{
  const m = mgr();
  const res = await m.sendAwaitingStart(20); // nobody runs it -> timeout
  const stillQueued = m.queue.length;
  const wouldWriteInbox = requiresInboxFallback(res);
  console.log('\n  F3 timeout: does the turn still run AND get an inbox copy?');
  console.log(`    outcome: ${res} | still queued: ${stillQueued} | inbox write: ${wouldWriteInbox}`);
  const doubleDelivers = stillQueued > 0 && wouldWriteInbox;
  if (expectBroken) {
    check('REPRO F3: turn stays queued AND the inbox is written (double delivery)', doubleDelivers);
  } else {
    check('GATE F3: the unstarted turn was withdrawn from the queue', stillQueued === 0);
    check('GATE F3: so the inbox copy is the ONLY delivery', wouldWriteInbox && stillQueued === 0);
    check('GATE F3: and it is not reported live', report(res) !== 'live');
  }
}

// ── F3b: a turn that ALREADY STARTED must never be withdrawn ────────────────
// The anti-control for F3: withdrawing indiscriminately would cancel real work.
{
  const m = new Manager({ legacy: false });
  const p = m.sendAwaitingStart();
  await new Promise((r) => setTimeout(r, 5));
  const ran = m.runNext();
  await p;
  check('ANTI-CONTROL: a started turn is not withdrawable', m.dequeueUnstarted(ran.uuid) === false);
}

// ── F2: multiplicity — REAL module, not a model ─────────────────────────────
{
  const body = 'ledger updated: please re-read the artifact';
  const key = pendingPromptKey({ text: body });
  const two = [
    { id: 'send-ops', key, text: body },
    { id: 'send-lead', key, text: body },
  ];
  // The transcript contains ONE occurrence: one of the two turns ran.
  const consumedOnce = countConsumedKeys([{ text: body }]);
  const recovered = expectBroken
    ? two.filter((p) => !new Set([key]).has(p.key)) // the old set-membership rule
    : filterUnconsumedPrompts(two, consumedOnce);
  console.log('\n  F2 multiplicity: 2 senders, same body, 1 turn ran');
  console.log(`    recovered: ${recovered.length} (1 = the other sender survives, 0 = LOST)`);
  if (expectBroken) {
    check('REPRO F2: one consumed occurrence suppresses BOTH entries', recovered.length === 0);
  } else {
    check('GATE F2: exactly one entry survives', recovered.length === 1, `got ${recovered.length}`);
    // CONTROLS, both directions.
    check(
      'CONTROL F2: both consumed -> nothing recovered',
      filterUnconsumedPrompts(two, countConsumedKeys([{ text: body }, { text: body }])).length === 0,
    );
    check(
      'CONTROL F2: neither consumed -> both recovered',
      filterUnconsumedPrompts(two, countConsumedKeys([])).length === 2,
    );
    check(
      'CONTROL F2: a Set still behaves as one occurrence (back-compat)',
      filterUnconsumedPrompts(two, new Set([key])).length === 1,
    );
  }
}

// ── The honest-status decision table (the REAL shipped module) ──────────────
{
  console.log('\n  decision table (src/shared/delivery-status.ts):');
  const table = { started: 'live', dropped: 'inbox', timeout: 'inbox', none: null };
  for (const [attempt, want] of Object.entries(table)) {
    const got = report(attempt);
    console.log(`    ${attempt.padEnd(8)} -> ${String(got)}`);
    check(`table: ${attempt} -> ${String(want)}`, got === want, `got ${String(got)}`);
  }
}

if (fails) {
  console.error(`\n${fails} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall checks passed (${expectBroken ? 'faults reproduced' : 'faults eliminated'})`);
