// The status tooltip string, split out of WorkspaceStatusGlyph.tsx so it is
// unit-testable: node:test cannot import a .tsx (JSX doesn't parse under
// --experimental-strip-types), and this is the only logic in that component
// with branches worth guarding. The component re-exports it, so every existing
// import site is unchanged.

import type { Workspace } from '../shared/types.ts';
import { THINKING_TOOL_LABEL } from '../shared/types.ts';
import { usageLimitPausedText } from '../shared/usage-resume.ts';

/** Tooltip for a workspace's status marker, wherever agents are listed (sidebar
 *  rows, Inbox, jump palette, Resources table).
 *
 *  `tool` is the ephemeral `agent:tool` label: a real tool name (Bash, Edit, …)
 *  while one is running, or {@link THINKING_TOOL_LABEL} in the gap between
 *  tools where the model is generating. */
export function statusGlyphTitle(
  w: Pick<
    Workspace,
    | 'status'
    | 'markedUnread'
    | 'hibernatedAt'
    | 'autoUnread'
    | 'loopingSince'
    | 'lastStopReason'
    | 'usageLimitResetsAt'
  >,
  tool?: string,
): string {
  // The /loop badge's clause, APPENDED to whichever state phrase wins below —
  // looping is an orthogonal axis (the glyph overlays a badge, it doesn't
  // replace the shape), so the tooltip composes the same way. Hibernated is
  // the one state whose glyph suppresses the badge (a stopped process can't
  // wake), so its phrase stays bare.
  const loop = (base: string) =>
    w.loopingSince && w.hibernatedAt === undefined ? `${base} — looping` : base;
  if (w.markedUnread) return loop('Tagged unread — come back to this workspace');
  if (w.hibernatedAt !== undefined)
    return 'Agent is hibernated — process stopped to free memory, resumes on input';
  // The thinking sentinel is NOT a tool name — it marks the between-tools gap
  // (main sets it on submit/posttool). Render it as its own phrase rather than
  // "(thinking)", which would read like a tool called "thinking". Any other
  // label IS a real tool name and keeps the parenthesised form.
  if (w.status === 'running' && tool === THINKING_TOOL_LABEL) return loop('Agent is thinking…');
  if (w.status === 'running')
    return loop(tool ? `Agent is working… (${tool})` : 'Agent is working…');
  // Ordered to match the GLYPH's own precedence (see WorkspaceStatusGlyph): the
  // bell only wins on the quiet statuses, so `waiting`/`error` answer first.
  // `waiting` now means ONLY "blocked on your answer" — "finished but unseen"
  // is `idle` + `autoUnread`, which is the bell.
  if (w.status === 'waiting') return loop('Agent is blocked on your answer');
  if (w.status === 'error') return loop('Agent hit an error');
  // Why the last turn ended (#69), ranked above the bell for the same reason
  // the glyph ranks it there: "stopped and consuming nothing" outranks
  // "finished, unseen". Only the two reasons a human must act on are stored,
  // so any value here is worth saying.
  // #85: scoped to the TURN, deliberately. MEASURED 2026-08-25
  // (/tmp/t85probe/probe{1,2,3}.mjs, SDK 0.3.241, real query() with Orchestra's
  // `for(;;)` turn-gated generator): `maxTurns` resets on EVERY user turn —
  // probe 3 is the positive control, letting a CUMULATIVE 12 round-trips
  // through a cap of 5 with zero exhaustions. The old copy ("turn budget
  // exhausted") stated the refuted session-lifetime model, which reads as "this
  // workspace is spent" and invites abandoning a session whose next turn would
  // start from a full budget. Only that ONE turn died; the remedy is one more
  // message. See docs/research/issue-69-maxturns-findings.md (fourth section).
  if (w.lastStopReason === 'max_turns')
    return loop('Agent stopped — that turn hit the step limit; send a message to continue');
  // The usage-limit PAUSE (#74). Phrased differently from the two above on
  // purpose: those need a human, this one does not — the app resumes it by
  // itself at the reset, so the tooltip states the ETA rather than asking for
  // an action. When the reset time is unknown (the 429-turn-result detection
  // path reports none) the ETA is DROPPED rather than invented: a made-up time
  // is worse than no time, because a reader takes it as measured.
  if (w.lastStopReason === 'usage_limit')
    return loop(usageLimitPausedText(w.usageLimitResetsAt ?? null));
  if (w.lastStopReason === 'error') return loop('Agent stopped — its last turn ended on an error');
  if (w.autoUnread) return loop('Agent finished — you have not opened this yet');
  if (w.status === 'idle') return loop('Agent is idle');
  return loop(w.status);
}
