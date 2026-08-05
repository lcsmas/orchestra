import type { AgentRewindPreview, RenderMessage } from '../../../shared/types';

/**
 * Pure helpers behind the rewind affordance, kept React-free in a `.ts` file so
 * `node --test` can exercise them (the strip-types runner cannot parse JSX).
 */

/** Human summary of what a rewind would restore on disk, from the SDK dry run.
 *  `null` = the preview is still in flight. */
export function describeRewindPreview(p: AgentRewindPreview | null): string {
  if (!p) return 'Checking what can be restored…';
  if (!p.canRewind) {
    // Overwhelmingly this means the session predates file checkpointing, so
    // lead with what WILL happen — the conversation rewind still works — rather
    // than an error the user can do nothing about.
    return 'Files on disk will be left as they are (no snapshot for this message).';
  }
  const n = p.filesChanged?.length ?? 0;
  if (n === 0) return 'No file changes to undo.';
  const plural = n === 1 ? '1 file' : `${n} files`;
  return `Restores ${plural} (+${p.insertions ?? 0}/−${p.deletions ?? 0}).`;
}

/**
 * The rewind target's PREDECESSOR — the id the session must be truncated at.
 *
 * The two SDK primitives take different targets and conflating them is an
 * off-by-one that silently keeps or drops a whole turn:
 *   • `rewindFiles(rewindId)` restores files as of the message being undone;
 *   • `resumeSessionAt(uuid)` keeps turns 1..N **inclusive** of its target, so
 *     dropping message N means cutting at N−1 (measured — see
 *     docs/spikes/rewind-sdk-findings.md).
 *
 * Returns `undefined` when the target is the FIRST rewindable turn: there is
 * nothing to keep, so the caller starts a fresh session instead of resuming.
 * Also `undefined` when the id isn't in the transcript (nothing to do).
 */
export function previousRewindId(
  messages: readonly RenderMessage[],
  rewindId: string,
): string | undefined {
  const idx = messages.findIndex((m) => m.rewindId === rewindId);
  if (idx < 0) return undefined;
  // Walk back to the nearest EARLIER message carrying an id — assistant rows,
  // tool rows and un-idd turns (externally-originated, pre-feature history) sit
  // between user turns and are not valid cut points.
  for (let i = idx - 1; i >= 0; i--) {
    const id = messages[i].rewindId;
    if (id) return id;
  }
  return undefined;
}

/** The text to put back in the composer for edit-and-retry — the undone
 *  message's own prompt. Empty when the message has no text (an image-only
 *  turn) or isn't found. */
export function rewindPrefillText(
  messages: readonly RenderMessage[],
  rewindId: string,
): string {
  const m = messages.find((x) => x.rewindId === rewindId);
  return m?.text ?? '';
}
