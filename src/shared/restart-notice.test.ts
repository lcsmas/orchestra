import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRestartNotice,
  restartTriggerLabel,
  classifyConsumeTermination,
  RESTART_NOTICE_TEXT,
  type RestartTrigger,
} from './restart-notice.ts';
import { foldEvent } from './agent-events.ts';
import type { NormalizeContext } from './agent-events.ts';
import { emptySession } from './agent-events.ts';

const ctx = (): NormalizeContext => ({ seq: 0, now: () => 1_700_000_000_000 });

test('makeRestartNotice builds a neutral `restarted` notice carrying the trigger', () => {
  const ev = makeRestartNotice(ctx(), 'cli');
  assert.equal(ev.type, 'notice');
  assert.equal(ev.kind, 'restarted');
  assert.equal(ev.restartTrigger, 'cli');
  assert.equal(ev.text, RESTART_NOTICE_TEXT);
  // NEVER an error level — the whole point of #148.
  assert.notEqual((ev as { type: string }).type, 'error');
});

test('the text is the exact French copy the human approved (pinned literal)', () => {
  // Pin the literal so a reword is a deliberate, reviewed change — the
  // render-smoke and the screenshot gate assert this same string.
  assert.equal(RESTART_NOTICE_TEXT, 'Session redémarrée — conversation préservée');
});

test('`at` override wins so a backfilled record renders at its historical instant', () => {
  const ev = makeRestartNotice(ctx(), 'toolbar', 42);
  assert.equal(ev.at, 42);
  // Without the override it takes the ctx clock.
  const live = makeRestartNotice(ctx(), 'toolbar');
  assert.equal(live.at, 1_700_000_000_000);
});

test('each of the three producers gets a distinct, non-empty detail label', () => {
  const triggers: RestartTrigger[] = ['cli', 'toolbar', 'reparent'];
  const labels = triggers.map(restartTriggerLabel);
  for (const l of labels) assert.ok(l.length > 0, 'label must be non-empty');
  // Distinct — the detail must actually distinguish the producers (#148 wants
  // "the trigger in the expandable detail").
  assert.equal(new Set(labels).size, 3);
});

// ── The FOLD: a `restarted` notice becomes a system row carrying the trigger ──
// This is the shared fold both live and backfill run through, so it must carry
// `restartTrigger` onto the RenderMessage the RestartRow keys on. A MUTANT that
// drops the field (see the guard below) reddens this.

test('folding a `restarted` notice yields a system row with noticeKind + trigger', () => {
  const ev = makeRestartNotice(ctx(), 'reparent');
  const session = foldEvent(emptySession('ws-1'), ev);
  const row = session.messages.at(-1);
  assert.ok(row, 'a row must be produced');
  assert.equal(row!.role, 'system');
  assert.equal(row!.noticeKind, 'restarted');
  assert.equal(row!.restartTrigger, 'reparent');
  // NOT an error row — no red box.
  assert.notEqual(row!.role, 'error');
});

// ── The DISCRIMINATOR (issue #148 acceptance arms) ───────────────────────────
// classifyConsumeTermination is the EXACT decision the agent-sdk consume-loop
// catch runs (extracted so this drives the shipped code, not a copy — #132).
// The two load-bearing arms are (A) intentional restart → neutral row, and
// (B) the LOOK-ALIKE crash (exit -1, NO marker) → error row. Both must be
// driven through the SAME classifier a `kill -9` and an `orchestra restart`
// reach in production.

test('ARM A — an intentional restart (marker set) → neutral restart row, NO error', () => {
  // `orchestra restart` set session.restartRequested before teardown; the
  // thrown message is the exact SDK exit string a keeper exit(-1) produces.
  const out = classifyConsumeTermination({
    cleared: false,
    interrupted: false,
    restartRequested: 'cli',
  });
  assert.equal(out.kind, 'restarted');
  assert.equal(out.kind === 'restarted' && out.trigger, 'cli');
});

test('ARM B (LOOK-ALIKE) — a crash: exit -1 but NO marker → error row, NOT prettified', () => {
  // A genuine `kill -9` of the claude process exits -1 with the SAME thrown
  // message an intentional restart produces — the ONLY difference is the absent
  // marker. Keying on the code would prettify this crash; keying on the marker
  // does not. This is the must-FAIL arm: it MUST classify as `error`.
  const out = classifyConsumeTermination({
    cleared: false,
    interrupted: false,
    restartRequested: undefined,
  });
  assert.equal(out.kind, 'error');
});

test('PRECEDENCE (D-H2) — restart marker WINS over interrupt-shaped teardown', () => {
  // A restart rides the SDK interrupt(), so the throw can look interrupt-shaped
  // (interrupted=true) even though the user asked for a restart. The label must
  // be deterministic — "Session redémarrée", never dependent on SDK timing.
  // Mutating the classifier order (interrupted before restartRequested) reddens
  // this arm; ARM B (crash, no marker) stays an error either way.
  const out = classifyConsumeTermination({
    cleared: false,
    interrupted: true,
    restartRequested: 'toolbar',
  });
  assert.equal(out.kind, 'restarted');
  assert.equal(out.kind === 'restarted' && out.trigger, 'toolbar');
});

test('a genuine standalone interrupt (NO restart marker) still renders interrupted', () => {
  // The precedence swap must NOT relabel a real user stop: with no restart
  // marker, an interrupt is still an interrupt (the plain-interrupt path is
  // untouched — sdkRestart is the only place the marker/flag-reset happens).
  const out = classifyConsumeTermination({
    cleared: false,
    interrupted: true,
    restartRequested: undefined,
  });
  assert.equal(out.kind, 'interrupted');
});

test('a cleared conversation suppresses everything, marker or not', () => {
  const out = classifyConsumeTermination({
    cleared: true,
    interrupted: false,
    restartRequested: 'reparent',
  });
  assert.equal(out.kind, 'suppress');
});

test('all three producers classify as `restarted` with their own trigger', () => {
  for (const trigger of ['cli', 'toolbar', 'reparent'] as RestartTrigger[]) {
    const out = classifyConsumeTermination({
      cleared: false,
      interrupted: false,
      restartRequested: trigger,
    });
    assert.equal(out.kind, 'restarted');
    assert.equal(out.kind === 'restarted' && out.trigger, trigger);
  }
});

// The END-TO-END equivalence live==backfill: the classifier + builder together
// produce the same folded row a restart surfaces LIVE and the row sdkHistory
// rebuilds from a persisted record. Same builder → same row (the #57 rule).
test('live and backfill rows are equal by construction (same builder)', () => {
  const trigger: RestartTrigger = 'toolbar';
  // LIVE: catch classifies then builds (clock time).
  const outcome = classifyConsumeTermination({
    cleared: false,
    interrupted: false,
    restartRequested: trigger,
  });
  assert.equal(outcome.kind, 'restarted');
  const liveEv = makeRestartNotice(ctx(), trigger);
  // BACKFILL: sdkHistory builds from a persisted record (historical `at`).
  const backfillEv = makeRestartNotice(ctx(), trigger, 999);
  // Same kind/text/trigger — only `at` differs (live=now, backfill=historical).
  assert.equal(liveEv.kind, backfillEv.kind);
  assert.equal(liveEv.text, backfillEv.text);
  assert.equal(liveEv.restartTrigger, backfillEv.restartTrigger);
  const liveRow = foldEvent(emptySession('ws'), liveEv).messages.at(-1);
  const backfillRow = foldEvent(emptySession('ws'), backfillEv).messages.at(-1);
  assert.equal(liveRow!.role, backfillRow!.role);
  assert.equal(liveRow!.noticeKind, backfillRow!.noticeKind);
  assert.equal(liveRow!.restartTrigger, backfillRow!.restartTrigger);
  assert.equal(liveRow!.text, backfillRow!.text);
});
