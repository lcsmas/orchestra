import type { RenderMessage } from './types.ts';

/**
 * Pure logic behind **"Resume from here"** (#18) — forking a conversation at a
 * chosen user message into a NEW Orchestra workspace, leaving the original
 * workspace intact and still running.
 *
 * Kept React-free and Electron-free in `src/shared/` so `node --test` can
 * exercise it (the strip-types runner cannot parse JSX, and main-process code
 * drags in Electron).
 *
 * ## The measured SDK contract this encodes
 *
 * `forkSession(sessionId, {upToMessageId})` copies the transcript up to and
 * **INCLUDING** the targeted message, remapping every uuid. Measured against
 * the real binary on 2026-08-25 (rig + controls in
 * `docs/spikes/fork-session-findings.md`): a 3-turn session whose replies were
 * ALPHA/BETA/GAMMA, forked at each ASSISTANT uuid and asked to list every
 * codeword it had said, recalled `ALPHA` / `ALPHA, BETA` / `ALPHA, BETA, GAMMA`
 * respectively. Strictly increasing across all three sample points, so the
 * boundary is bracketed rather than interpolated.
 *
 * The consequence that drives {@link forkTargetId}: because the cut is
 * inclusive, forking at a **user** message's own id yields a transcript ending
 * with that user message and **no assistant reply** — measured, the resumed
 * fork then answers that dangling message as its first act.
 *
 * ## What the fork actually contains (measured in the built app, not inferred)
 *
 * Only USER messages carry an Orchestra-minted `rewindId` (assistant uuids
 * exist on disk but are never surfaced to the renderer — verified in the e2e
 * rig), so the cut point is ALWAYS a user message and the fork therefore always
 * ends on one, WITHOUT its reply. Forking from message N yields turns 1..N-2
 * complete, plus user message N-1 unanswered; the resumed fork re-answers that
 * prompt as its first act.
 *
 * That is the intended "resume from here" behaviour — the user branches off
 * *before* the message they clicked and the agent re-attempts the previous
 * prompt — but it is NOT "the transcript ends on a complete exchange", which an
 * earlier version of this comment claimed. Cutting at the target itself would
 * be strictly worse: it re-answers the very message the user is trying to move
 * PAST, so the fork would be indistinguishable from the original.
 */

/**
 * The id to pass as `forkSession`'s `upToMessageId` for a "resume from here"
 * on the message `rewindId`.
 *
 * Returns the **predecessor** user message's id. The forked transcript then
 * holds every complete exchange before that predecessor, plus the predecessor's
 * own prompt unanswered — which the resumed fork re-answers as its first act
 * (measured; see the class comment above for why it can never end on a complete
 * exchange).
 *
 * `undefined` means "there is nothing to fork": either the target is the FIRST
 * rewindable turn (the fork would be empty, and the SDK throws
 * `Session <id> has no messages to fork` on an empty slice — measured), or the
 * id is not in the transcript at all. Callers must treat `undefined` as
 * "offer no affordance", never as "fork the whole session" — omitting
 * `upToMessageId` is a FULL copy in the SDK, which is the opposite of the
 * user's intent and would silently fork the entire conversation.
 *
 * Deliberately mirrors `previousRewindId` in the renderer's `rewind-util.ts`:
 * both encode "walk back to the nearest earlier id-carrying message", because
 * assistant rows, tool rows and un-idd turns (externally-originated or
 * pre-feature history) sit between user turns and are not valid cut points.
 * They are kept separate rather than shared because they answer different
 * questions against different SDK primitives (`resumeSessionAt` vs
 * `forkSession`) and a future divergence in either must not silently move the
 * other's boundary.
 */
export function forkTargetId(
  messages: readonly RenderMessage[],
  rewindId: string,
): string | undefined {
  const idx = messages.findIndex((m) => m.rewindId === rewindId);
  // NOT load-bearing, and deliberately kept anyway: with `idx === -1` the walk
  // below starts at -2 and falls straight through to the same `undefined`, so
  // deleting this line is a SURVIVING MUTANT (measured 2026-08-25 — 12/12 still
  // pass without it). It stays as an explicit statement of the not-found case
  // rather than leaving it to an arithmetic accident, but no test can pin it:
  // there is no input on which the two behaviours differ.
  if (idx < 0) return undefined;
  for (let i = idx - 1; i >= 0; i--) {
    const id = messages[i].rewindId;
    if (id) return id;
  }
  return undefined;
}

/**
 * Whether the "Resume from here" affordance should be offered on a message.
 *
 * False for the first rewindable turn: forking before it produces an EMPTY
 * transcript, which the SDK rejects outright (`has no messages to fork`).
 * Showing a control that can only fail is worse than showing none.
 */
export function canForkFrom(
  messages: readonly RenderMessage[],
  rewindId: string,
): boolean {
  return forkTargetId(messages, rewindId) !== undefined;
}

/** Max length of the slug taken from a message for the fork's branch name —
 *  long enough to stay recognisable in the sidebar, short enough that the
 *  worktree directory name stays manageable. */
const SLUG_MAX = 32;

/**
 * Branch name for the forked workspace, derived from the message the user
 * resumed from so the sidebar row is self-describing rather than a random
 * adjective-noun.
 *
 * Always prefixed `fork-`, so a forked workspace is identifiable at a glance
 * and never collides with the hand-created naming space. The slug is sanitized
 * to the same character class `createWorkspace` enforces; a message with no
 * usable characters (image-only turn, punctuation only) falls back to the bare
 * prefix, and `createWorkspace`'s `freeBranchName` dedupes collisions by
 * suffixing — so repeated forks of the same message are safe.
 */
export function forkBranchName(messageText: string | undefined): string {
  const slug = (messageText ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    // A trailing hyphen can reappear after slicing mid-word.
    .replace(/-+$/, '');
  return slug ? `fork-${slug}` : 'fork';
}
