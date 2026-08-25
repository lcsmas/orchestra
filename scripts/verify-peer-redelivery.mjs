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
import {
  countConsumedKeys,
  filterUnconsumedPrompts,
  pendingPromptKey,
} from '../src/shared/pending-prompts.ts';

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

// ── FIELD CAPTURE: the same predicates over REAL production data ────────────
// This is the strongest evidence in the ticket and it is not a model. These are
// REAL `ws.sdkPendingPrompts` entries lifted from the live store of workspace
// eadee48c (fix-wave-5-ops) while it ran the UNFIXED installed build v0.5.257 —
// the run that logged, verbatim:
//   2026-08-25T10:04:19.940Z [INFO] agent-sdk: re-sending 26 pending prompt(s)
//   lost to a quit for eadee48c-05dd-48b1-b9f6-21e45db5fdd8
// At capture the workspace held 17 pending entries, 17 of 17 peer envelopes
// (21 of 25 fleet-wide) — the accumulation signature of fault (a): peer
// messages that CAN NEVER match the legacy text predicate, so every reopen
// re-sends them.
{
  const field = JSON.parse(
    fs.readFileSync(path.join(here, 'fixtures/payloads/pending-prompts.field-capture.json'), 'utf8'),
  );
  const entries = field.entries;
  const lines = entries.map((t, i) =>
    JSON.stringify({
      type: 'user',
      uuid: `field-${i}`,
      timestamp: '2026-08-25T10:00:00Z',
      message: { role: 'user', content: t },
    }),
  );
  const fieldEvents = transcriptToEvents(lines.join('\n'), ctx(), null).filter(
    (e) => e.type === 'user-message',
  );
  // Instrument audit before any verdict.
  if (fieldEvents.length !== entries.length) {
    console.error('rig-side: field capture did not round-trip through the backfill — no verdict');
    process.exit(2);
  }
  const fieldTexts = fieldEvents.map((e) => e.text ?? '');
  const legacyResend = entries.filter((p) => !fieldTexts.some((t) => t.includes(p))).length;
  const fixedResend = filterUnconsumedPrompts(
    entries.map((t, i) => ({ id: `s${i}`, key: pendingPromptKey({ text: t }), text: t })),
    countConsumedKeys(fieldEvents),
  ).length;

  console.log(`\n  FIELD CAPTURE (real store, unfixed build v0.5.257)`);
  console.log(`    entries: ${entries.length} | all tagged peer by the backfill: ${fieldEvents.every((e) => String(e.origin ?? '').startsWith('peer: '))}`);
  console.log(`    LEGACY predicate would RE-SEND : ${legacyResend}/${entries.length}`);
  console.log(`    FIXED  predicate would re-send : ${fixedResend}/${entries.length}`);
  check(
    'FIELD: the legacy predicate re-sends EVERY consumed peer message',
    legacyResend === entries.length,
    'this is fault (a) observed on production data',
  );
  check(
    'FIELD: the fixed predicate re-sends NONE of them',
    fixedResend === 0,
    `got ${fixedResend}`,
  );
}

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
