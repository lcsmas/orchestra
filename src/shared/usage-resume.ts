// Fleet auto-resume when the usage limit resets (#74).
//
// Field motivation: a coordinator died on "You've hit your session limit ·
// resets 6pm" and the whole fleet froze for 75 minutes until a human noticed.
// Nothing in the app watched for the reset, so nothing restarted.
//
// This module is the PURE half — every decision that can be made from plain
// data lives here so it is unit-testable without Electron (the repo's standing
// pattern: logic in src/shared/, wiring in src/main/). The impure half — the
// flusher tick that reads the usage caches and calls `wakeAgentWithPrompt` —
// lives in src/main/prompt-queue.ts and does nothing this file cannot decide.
//
// ── THE UNIT TRAP (measured, not assumed) ──
// Two reset timestamps flow through this feature and they are in DIFFERENT
// units. Getting this wrong is a bug that ships green, because both are
// plausible-looking positive integers:
//   • `AgentNoticeEvent.resetsAt` is epoch SECONDS — it is passed through
//     verbatim from the SDK's `rate_limit_event.rate_limit_info.resetsAt`
//     (src/shared/agent-events.ts, `case 'rate_limit_event'`), and typed as
//     "epoch seconds the limit resets" on AgentNoticeEvent in types.ts.
//   • `usageLimitedUntil()` returns epoch MILLISECONDS — it builds its value
//     with `Date.parse()` on an ISO string (src/shared/accounts.ts).
// Treating the seconds value as ms puts the reset in January 1970 (so a
// paused session resumes INSTANTLY, straight back into the limit); treating
// ms as seconds puts it ~50000 years out (so it never resumes at all). Both
// failure modes are silent. `resetsAtMsFromNotice` is the single conversion
// point, and it is unit-tested at the boundary in usage-resume.test.ts.

import type { Workspace, AgentStopReason } from './types.ts';
import { canOrchestrate } from './types.ts';

/** Epoch-seconds → epoch-ms for a rate-limit notice's `resetsAt`.
 *
 *  Returns null for anything that is not a usable forward-looking timestamp:
 *  absent, non-finite, or ≤ 0. A null means "limit reached, reset time
 *  unknown" — a real state, not an error: the 429-result detection path
 *  (`classifyTurnError` in agent-events.ts) carries NO reset time by design,
 *  because the turn result does not report one. Callers must treat null as
 *  "pause, and let the account poller decide when to resume" rather than
 *  substituting `now` (which would resume immediately, into the same wall).
 *
 *  The `< SECONDS_CEILING` guard is deliberate and load-bearing: a caller that
 *  mistakenly hands us a value ALREADY in ms would otherwise be multiplied
 *  again, yielding a date ~50 millennia out that silently never resumes. Any
 *  epoch-seconds value stays under the ceiling until the year 5138, while any
 *  epoch-ms value from this century is far above it — so the two are cleanly
 *  separable and a misuse is rejected loudly (null) instead of absorbed. */
const SECONDS_CEILING = 100_000_000_000; // ~year 5138 in seconds; any ms value this century exceeds it

export function resetsAtMsFromNotice(resetsAtSeconds: number | undefined | null): number | null {
  if (typeof resetsAtSeconds !== 'number') return null;
  if (!Number.isFinite(resetsAtSeconds)) return null;
  if (resetsAtSeconds <= 0) return null;
  // Already-in-ms misuse: refuse rather than silently produce a year-51000 date.
  if (resetsAtSeconds >= SECONDS_CEILING) return null;
  return Math.round(resetsAtSeconds * 1000);
}

/** The stop reasons that mean "this session stopped and will consume nothing
 *  until someone acts" — the ones the sidebar/inbox/palette/resources views
 *  must surface with a distinct glyph and tooltip.
 *
 *  This exists because FIVE renderer call sites had the allowlist hardcoded as
 *  `x === 'max_turns' || x === 'error'`, and adding `'usage_limit'` as a sixth
 *  copy would have guaranteed the next reason drifts across them again. Route
 *  every site through this predicate instead. Note the two sites that consume
 *  the RESULT of these call sites — WorkspaceStatusGlyph's `stopReason` prop
 *  type and status-glyph-title.ts's tooltip — are part of the same surface and
 *  must accept exactly this set; {@link ActionableStopReason} is what keeps
 *  them in step, so a new reason is a compile error at every site rather than
 *  a silent render gap.
 *
 *  `end_turn` and `interrupted` are deliberately EXCLUDED: a clean finish and a
 *  user-requested stop are not conditions a human must act on. */
export const ACTIONABLE_STOP_REASONS = ['max_turns', 'error', 'usage_limit'] as const;

/** A stop reason worth putting a marker on screen — the element type of
 *  {@link ACTIONABLE_STOP_REASONS}. Used as the `stopReason` prop type across
 *  the glyph surface so all sites share one definition. */
export type ActionableStopReason = (typeof ACTIONABLE_STOP_REASONS)[number];

/** Whether a stop reason is one the human must act on (see
 *  {@link ACTIONABLE_STOP_REASONS}). Narrows, so call sites can pass the result
 *  straight into a prop typed {@link ActionableStopReason}. */
export function isActionableStopReason(
  reason: AgentStopReason | undefined | null,
): reason is ActionableStopReason {
  return (
    reason === 'max_turns' || reason === 'error' || reason === 'usage_limit'
  );
}

/** The usage reading shape the flusher already computes per workspace
 *  (`usageForWorkspace` in src/main/prompt-queue.ts). Mirrored structurally
 *  rather than imported so this module stays free of main-process imports. */
export interface UsageReading {
  /** Epoch ms this snapshot was fetched. */
  fetchedAt: number;
  /** Null when the source has no data yet. */
  data: unknown;
}

/** What the resume driver should do with one usage-limited workspace on a tick.
 *
 *  - `wait`   — not yet; the reset has not passed, or the evidence is stale.
 *  - `queue`  — the workspace has banner-queued prompts; they carry real user
 *               intent and MUST win over a synthesized nudge, so the existing
 *               flusher delivers them and this feature stands down.
 *  - `nudge`  — resume it with the generic nudge.
 */
export type ResumeAction = 'wait' | 'queue' | 'nudge';

export interface ResumeDecisionInput {
  /** The workspace's recorded stop reason (only `'usage_limit'` is resumable). */
  lastStopReason?: AgentStopReason;
  /** Epoch MS the account's limit resets, or null when unknown. Already
   *  converted — see {@link resetsAtMsFromNotice}. */
  resetsAtMs: number | null;
  /** True when this workspace coordinates others (`kind: 'orchestrator'` or a
   *  promoted worktree) — see {@link canOrchestrate}. Coordinators resume AT
   *  the reset; everyone else additionally waits for fresh usage evidence, so
   *  the fleet does not stampede the API the same second. */
  isCoordinator: boolean;
  /** How many prompts are parked on the banner queue. */
  queuedCount: number;
  /** Whether a usage reading fetched AFTER the limit was hit shows the account
   *  usable again. This is the caller's application of `canAutoFlushQueue`'s
   *  fetchedAt-after-block rule; false when there is no such reading yet. */
  freshUsageSaysRecovered: boolean;
  /** Epoch ms now. */
  now: number;
}

/** Decide what to do with ONE usage-limited workspace on a resume tick.
 *
 *  Pure and total: every branch is reachable from plain data, which is the
 *  point — the wiring in prompt-queue.ts only gathers inputs and executes the
 *  verdict, so the whole policy is testable without Electron, a network, or a
 *  real usage limit.
 *
 *  Order of the guards matters and each is load-bearing:
 *   1. Only a session that actually DIED ON THE LIMIT is eligible. Never
 *      blanket-wake idle workspaces — that was the explicit non-goal in #74.
 *   2. The reset time must have PASSED. An unknown reset (`null`, the
 *      429-result path) is not treated as "now": without a reset time the only
 *      trustworthy evidence is a fresh usage reading, so such a workspace waits
 *      for one instead of resuming blind into the same wall.
 *   3. Banner-queued prompts WIN. They are user intent; the nudge is a
 *      synthesized guess. Returning `queue` lets the existing flusher own the
 *      delivery, so there is exactly one code path that sends a queue.
 *   4. Staggering: coordinators go at the reset, everyone else waits for a
 *      fresh reading. A coordinator's first act is to re-read its ledger and
 *      re-dispatch, so it must be up before its fleet asks it anything. */
export function decideResume(input: ResumeDecisionInput): ResumeAction {
  const { lastStopReason, resetsAtMs, isCoordinator, queuedCount, freshUsageSaysRecovered, now } =
    input;

  // 1. Only limit-killed sessions are eligible.
  if (lastStopReason !== 'usage_limit') return 'wait';

  // 2. The reset must have passed. An UNKNOWN reset time (null) can only be
  //    resolved by fresh usage evidence — never by assuming "now".
  if (resetsAtMs === null) {
    if (!freshUsageSaysRecovered) return 'wait';
  } else if (now < resetsAtMs) {
    return 'wait';
  }

  // 3. Real user intent beats a synthesized nudge.
  if (queuedCount > 0) return 'queue';

  // 4. Staggering. Coordinators resume at the reset; everyone else needs a
  //    usage reading fetched after the block that says the account recovered.
  if (isCoordinator) return 'nudge';
  return freshUsageSaysRecovered ? 'nudge' : 'wait';
}

/** Convenience: read the coordinator flag off a real workspace record. Kept
 *  next to {@link decideResume} so callers do not re-derive it (and so the
 *  "promoted worktree counts as a coordinator" rule is applied once). */
export function isCoordinatorWorkspace(ws: Pick<Workspace, 'kind' | 'canOrchestrate'>): boolean {
  return canOrchestrate(ws);
}

/** The GENERIC resume nudge.
 *
 *  Deliberately says nothing about what the agent was doing. #74 forbids
 *  replaying the interrupted input, and this is why: the killed turn may have
 *  half-executed (files written, a message sent, a branch pushed), so replaying
 *  it re-runs side effects — the #57 partial-execution family. Instead the
 *  agent is pointed at its OWN durable state, which is the only record that
 *  survived the death and the only one that reflects what actually happened.
 *
 *  `wakeAgentWithPrompt` is prompt-mandatory, so there must be SOME text; this
 *  is the smallest text that is safe. */
export const RESUME_NUDGE_TEXT =
  'The usage limit has reset and you were stopped mid-task by it. ' +
  'Do NOT assume your last action completed — re-read your durable state ' +
  '(your ledger/issue, the branch, the working tree) to establish where you ' +
  'actually got to, then continue from there.';

/** The sidebar's paused-state tooltip: '⏸ limit reached — resumes ~6pm'.
 *
 *  `resetsAtMs` null (the 429-result path, which reports no reset time) drops
 *  the ETA rather than inventing one — a made-up time is worse than none,
 *  because a human reads it as measured. `formatTime` is injected so the test
 *  is not hostage to the runner's timezone. */
export function usageLimitPausedText(
  resetsAtMs: number | null,
  formatTime: (ms: number) => string = defaultFormatTime,
): string {
  if (resetsAtMs === null) return '⏸ limit reached — waiting for the usage window to reset';
  return `⏸ limit reached — resumes ~${formatTime(resetsAtMs)}`;
}

function defaultFormatTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}
