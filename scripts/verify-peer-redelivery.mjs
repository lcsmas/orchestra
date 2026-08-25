#!/usr/bin/env node
// REPRO + REGRESSION GATE for issue #57 fault (a): a peer message ALREADY
// CONSUMED by a session is re-enqueued on every app restart, forever.
//
// ── Why this rig exists at THIS seam ─────────────────────────────────────────
//
// The user observed the SAME message queued 3x. `recoverPendingPrompts`
// (agent-sdk.ts) already clears `ws.sdkPendingPrompts` BEFORE it resends, so it
// cannot accumulate WITHIN one pass. A 3x therefore requires its dedupe
// predicate to keep answering "missing" across REPEATED restarts. That
// predicate is the thing under test, and it is pure:
//
//     const missing = pending.filter((p) => !userTexts.some((t) => t.includes(p)));
//
// where `pending` holds what sdkSend persisted (the RAW peer envelope) and
// `userTexts` holds what the on-disk backfill produced. So this rig drives the
// REAL backfill (`transcriptToEvents`) over a REAL captured transcript line and
// applies the REAL predicate. No hand-built payloads (scripts/fixtures/README),
// no reimplementation of the fold: an assumption encoded twice proves nothing.
//
// ── The mechanism it pins ────────────────────────────────────────────────────
//
// sdkSend persists the full envelope:
//     [message from agent 'X' (id)]\n<body>\n\nReply with: orchestra message …
// The backfill's `pushUserText` runs `recognizeFormattedPeerMessage`, which
// STRIPS the header and the reply footer, storing only `<body>` as the
// user-message text (issue #56's collapsible peer rows).
// A stripped body is strictly SHORTER than the envelope it came from, so
// `body.includes(envelope)` is false BY CONSTRUCTION — not by accident of
// whitespace. The entry is therefore "missing" on every reopen, forever, and
// each reopen re-sends it. That is the observed 3x.
//
// ── Both arms, always ────────────────────────────────────────────────────────
//
// Run with no args it asserts the FIXED behaviour (exit 0 = fixed).
// Run with `--expect-broken` it asserts the fault REPRODUCES (exit 0 = the
// fault is present) — that is the prove-can-fail arm the ledger's G5 demands,
// and it is how this gate was watched to fail on the unfixed tree.
//
// A positive control runs in BOTH arms: an ordinary HUMAN prompt must round-trip
// through the same backfill and be recognized as consumed. Without it, a
// predicate that simply answered "nothing is ever missing" would pass the fixed
// arm while silently destroying the quit-window recovery this feature exists for.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { transcriptToEvents } from '../src/shared/agent-transcript.ts';
import { pendingPromptKey, filterUnconsumedPrompts } from '../src/shared/pending-prompts.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const payload = JSON.parse(
  fs.readFileSync(path.join(here, 'fixtures/payloads/peer-message.envelopes.json'), 'utf8'),
);

const expectBroken = process.argv.includes('--expect-broken');
const failures = [];
const notes = [];

function check(name, cond, detail) {
  if (cond) notes.push(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else failures.push(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Text of a captured transcript envelope, exactly as sdkSend would have had it. */
function envelopeText(entry) {
  const c = entry.message.content;
  if (typeof c === 'string') return c;
  return c
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('');
}

const ctx = () => ({ workspaceId: 'ws-repro', seq: 0 });

// ── The subject: a REAL peer envelope in the CURRENT format ──────────────────
const peerEntry = payload.currentFormat;
const peerEnvelope = envelopeText(peerEntry);
if (!peerEnvelope.startsWith("[message from agent '")) {
  console.error('rig-side: captured payload is not a peer envelope — refusing to report a verdict');
  process.exit(2);
}

// ── Drive the REAL backfill over the REAL captured line ──────────────────────
const jsonl = JSON.stringify(peerEntry);
const events = transcriptToEvents(jsonl, ctx(), null);
const userTexts = events.filter((e) => e.type === 'user-message').map((e) => e.text ?? '');

// Instrument audit: the backfill must actually have produced a user message,
// and it must have been recognized as a peer row. If either is false this rig
// is measuring nothing and must not return a verdict (an empty `userTexts`
// would make EVERY entry "missing" and fake a reproduction).
if (userTexts.length !== 1) {
  console.error(
    `rig-side: backfill produced ${userTexts.length} user-message events, expected 1 — no verdict`,
  );
  process.exit(2);
}
const peerRow = events.find((e) => e.type === 'user-message');
if (!(typeof peerRow.origin === 'string' && peerRow.origin.startsWith('peer: '))) {
  console.error(
    `rig-side: backfill did not tag the row as a peer message (origin=${JSON.stringify(peerRow.origin)}) — no verdict`,
  );
  process.exit(2);
}

const renderedText = userTexts[0];
const strippedByBackfill = renderedText !== peerEnvelope;
check(
  'backfill strips the peer envelope (the precondition of the fault)',
  strippedByBackfill,
  `envelope ${peerEnvelope.length} chars → rendered ${renderedText.length} chars`,
);

// ── FAULT (a): the legacy TEXT predicate, verbatim from the unfixed source ───
// Reproduced here (not imported) precisely because the fix DELETES it; this is
// the historical predicate the ledger asked to be measured, kept so the repro
// arm keeps meaning something after the fix lands.
const legacyMissing = [peerEnvelope].filter((p) => !userTexts.some((t) => t.includes(p)));
const legacyRedelivers = legacyMissing.length === 1;

// ── The FIXED predicate: identity-based, driven by the real shared module ────
// `pendingPromptKey` derives a stable key that survives the backfill's envelope
// stripping, so a consumed peer message is recognized as consumed.
const consumedKeys = new Set(events.filter((e) => e.type === 'user-message').map(pendingPromptKey));
const fixedMissing = filterUnconsumedPrompts([{ key: pendingPromptKey({ text: peerEnvelope }), text: peerEnvelope }], consumedKeys);
const fixedRedelivers = fixedMissing.length === 1;

// ── POSITIVE CONTROL: a genuinely lost prompt MUST still be recovered ────────
// Without this, "never redeliver anything" would pass the fixed arm and quietly
// destroy the quit-window recovery. The control prompt is absent from the
// transcript entirely, so both predicates must call it missing.
const lostPrompt = 'this prompt never reached the model — recover it';
const controlLegacy = [lostPrompt].filter((p) => !userTexts.some((t) => t.includes(p)));
const controlFixed = filterUnconsumedPrompts(
  [{ key: pendingPromptKey({ text: lostPrompt }), text: lostPrompt }],
  consumedKeys,
);
check('control: a genuinely lost prompt is still recovered (legacy)', controlLegacy.length === 1);
check('control: a genuinely lost prompt is still recovered (fixed)', controlFixed.length === 1);

// ── NEGATIVE CONTROL: an ordinary HUMAN prompt round-trips as consumed ───────
// Proves the fixed predicate discriminates rather than answering "consumed" to
// everything — the failure mode that would make the whole gate vacuous.
const humanEntry = {
  ...peerEntry,
  message: { role: 'user', content: 'plain human prompt, no envelope' },
};
const humanEvents = transcriptToEvents(JSON.stringify(humanEntry), ctx(), null);
const humanTexts = humanEvents.filter((e) => e.type === 'user-message').map((e) => e.text ?? '');
const humanKeys = new Set(
  humanEvents.filter((e) => e.type === 'user-message').map(pendingPromptKey),
);
const humanLegacy = ['plain human prompt, no envelope'].filter(
  (p) => !humanTexts.some((t) => t.includes(p)),
);
const humanFixed = filterUnconsumedPrompts(
  [
    {
      key: pendingPromptKey({ text: 'plain human prompt, no envelope' }),
      text: 'plain human prompt, no envelope',
    },
  ],
  humanKeys,
);
check('control: a consumed HUMAN prompt is not redelivered (legacy)', humanLegacy.length === 0);
check('control: a consumed HUMAN prompt is not redelivered (fixed)', humanFixed.length === 0);

// ── Verdict ──────────────────────────────────────────────────────────────────
console.log(`\nissue #57 fault (a) — peer-message redelivery`);
console.log(`  arm: ${expectBroken ? 'REPRO (expect the fault present)' : 'GATE (expect it fixed)'}`);
console.log(`  captured envelope : ${JSON.stringify(peerEnvelope.slice(0, 64))}…`);
console.log(`  backfill rendered : ${JSON.stringify(renderedText.slice(0, 64))}…`);
console.log(`  legacy text predicate redelivers a CONSUMED peer message : ${legacyRedelivers}`);
console.log(`  fixed  key predicate redelivers a CONSUMED peer message : ${fixedRedelivers}`);

if (expectBroken) {
  check(
    'REPRO: the legacy text predicate re-enqueues an already-consumed peer message',
    legacyRedelivers,
    'this is the fault — it recurs on EVERY reopen, which is the observed 3x',
  );
} else {
  check(
    'GATE: an already-consumed peer message is NOT re-enqueued',
    !fixedRedelivers,
    'identity key survives the backfill envelope stripping',
  );
}

console.log(notes.concat(failures).join('\n'));
if (failures.length) {
  console.error(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall checks passed (${expectBroken ? 'fault reproduced' : 'fault eliminated'})`);
