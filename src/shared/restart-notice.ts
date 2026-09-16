// Intentional-restart neutral row — issue #148 (pure detection/build layer).
//
// WHY THIS EXISTS. An INTENTIONAL restart of a structured session (`orchestra
// restart`, the toolbar Restart button, or the #142 re-parent restart) tears the
// CLI down and relaunches it. The teardown makes the keeper synthesize an
// `exit(-1)`, which the SDK's `query()` iterator throws as
// `Claude Code process exited with code -1`; the consume loop's catch then
// painted a RED "ERROR — Claude Code process exited with code -1" box (agent-
// sdk.ts). But an intentional restart is not a failure — the user (2026-09-15,
// canary 3 screenshot) asked for a compact NEUTRAL row instead, in the #145
// "Variant A quiet-rows" idiom: `↻ Session redémarrée — conversation préservée`
// with the trigger in an expandable detail.
//
// THE DISCRIMINATOR IS AN EXPLICIT INTENT MARKER, never the exit code or timing:
// a genuine crash (`kill -9`) ALSO exits -1, so keying on the code would prettify
// crashes too. The restart PATH sets the marker (`session.restartRequested` live;
// a persisted `Workspace.sdkRestarts` record for backfill), and only a marked
// exit is rendered neutral. An unmarked -1 keeps the red error box (the #148
// look-alike must-FAIL arm).
//
// THIS MODULE IS THE SINGLE ROW BUILDER both paths converge on, so live ==
// backfill BY CONSTRUCTION (the #57 lesson, mirroring bus-rows.ts):
//   - LIVE: consume()'s catch, on a marked process-exit, calls
//     `makeRestartNotice` and emits the resulting event instead of the error.
//   - BACKFILL: `sdkHistory` reads the persisted `sdkRestarts` records and calls
//     the SAME `makeRestartNotice` for each, interleaved by timestamp.
// One function, one row — the detection SIDE differs (a session flag vs a
// persisted record, which is unavoidable since Orchestra never writes the CLI's
// transcript) but the RENDERED ROW is identical because both build it here.
//
// No renderer, no main, no Electron imports, so it runs under the strip-types
// test runner (the #132 dir-import trap).

import type { AgentNoticeEvent, RestartTrigger } from './types.ts';
import { stamp, type NormalizeContext } from './agent-events.ts';

export type { RestartTrigger, RestartRecord } from './types.ts';

/** The user-visible French copy for the row's headline (Bloc-2 language rule is
 *  project-scoped; this app's transcript UI is English elsewhere, but the ticket
 *  specifies the French string verbatim, and it is the one the human approved in
 *  the screenshot thread). Kept as a constant so the render-smoke and the
 *  screenshot gate assert the same literal. */
export const RESTART_NOTICE_TEXT = 'Session redémarrée — conversation préservée';

/** Human-readable label for the trigger, shown in the expandable detail. */
export function restartTriggerLabel(trigger: RestartTrigger): string {
  switch (trigger) {
    case 'cli':
      return 'Redémarrage via `orchestra restart`';
    case 'toolbar':
      return 'Redémarrage via le bouton Restart';
    case 'reparent':
      return 'Redémarrage après re-parentage (#142)';
    default: {
      // Exhaustiveness: an unknown trigger still renders a sane detail rather
      // than throwing on a value a future producer might add.
      const _never: never = trigger;
      return 'Redémarrage';
    }
  }
}

/** What a consume-loop termination should surface. The consume loop in
 *  agent-sdk.ts catches the thrown teardown error and must decide between four
 *  mutually-exclusive outcomes; extracting the DECISION here (pure) makes it
 *  unit-testable and mutation-provable without importing agent-sdk (the
 *  `./platform` dir-import trap, #132) and, critically, means the test drives
 *  the SAME code the shipped catch runs, not a re-implementation. */
export type ConsumeTermination =
  /** The user cleared the conversation — emit nothing (tail events would dirty
   *  the fresh transcript). */
  | { kind: 'suppress' }
  /** A user-requested interrupt — a quiet `interrupted` notice. */
  | { kind: 'interrupted' }
  /** An INTENTIONAL restart — the neutral restart row. */
  | { kind: 'restarted'; trigger: RestartTrigger }
  /** A genuine failure — the red error row. */
  | { kind: 'error' };

/** Classify a consume-loop teardown throw into the row it should surface.
 *
 *  Order and precedence (the #148 discriminator lives here):
 *   1. `cleared` → suppress everything (the /clear reset owns the surface).
 *   2. `restartRequested` set → the neutral restart row. **This WINS over
 *      `interrupted` deterministically (D-H2)**: the intentional-restart
 *      teardown rides the SDK's `interrupt()` (sdkStop calls it), which can make
 *      the thrown message match the EDE-diagnostic regex and/or leave
 *      `interruptRequested` set from a racing user interrupt — so keying the
 *      label on `interrupted` first made the rendered row depend on SDK interrupt
 *      TIMING. A restart raced by an interrupt is truthfully "Session
 *      redémarrée" — the restart IS happening — so the explicit marker decides.
 *      Belt-and-braces: `sdkRestart` also resets `interruptRequested` at teardown
 *      start (agent-sdk.ts), scoped to the restart path so a GENUINE standalone
 *      interrupt (which never sets `restartRequested`) is never relabeled and
 *      still reaches branch 3.
 *   3. `interrupted` (our own interrupt OR an EDE-diagnostic throw), with NO
 *      restart marker → the quiet `interrupted` notice. A plain user stop.
 *   4. `restartRequested` UNSET and not interrupted → the red error row. The
 *      marker is the whole discriminator: a `kill -9` crash also exits -1 but
 *      leaves it UNSET → falls through here (ARM B).
 *
 *  `restartRequested` is `undefined` for a crash and a `RestartTrigger` for an
 *  intentional restart; that is the whole discriminator. */
export function classifyConsumeTermination(input: {
  cleared: boolean;
  interrupted: boolean;
  restartRequested: RestartTrigger | undefined;
}): ConsumeTermination {
  if (input.cleared) return { kind: 'suppress' };
  // Restart marker WINS over `interrupted` (D-H2) — deterministic, timing-free.
  if (input.restartRequested) return { kind: 'restarted', trigger: input.restartRequested };
  if (input.interrupted) return { kind: 'interrupted' };
  return { kind: 'error' };
}

/** Build the neutral restart NOTICE event both the live catch and the backfill
 *  emit. `kind: 'restarted'` routes it to the dedicated expandable RestartRow
 *  (StructuredView), and `restartTrigger` carries the producer for the detail.
 *
 *  This is the ONE builder — calling it from both paths is what makes the live
 *  row and the reopened row byte-identical (#57). `at`, when provided, overrides
 *  the clock so a backfilled record renders at its historical instant rather than
 *  at reload time (mirroring transcriptToEvents' timestamp rewrite). */
export function makeRestartNotice(
  ctx: NormalizeContext,
  trigger: RestartTrigger,
  at?: number,
): AgentNoticeEvent & { seq: number; at: number } {
  const ev = stamp(ctx, {
    type: 'notice' as const,
    kind: 'restarted' as const,
    text: RESTART_NOTICE_TEXT,
    restartTrigger: trigger,
  });
  return at !== undefined ? { ...ev, at } : ev;
}
