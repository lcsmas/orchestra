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
 * The rewind target's PREDECESSOR prompt. Only a FALLBACK for main's cut: main
 * resumes at the undone prompt's `parentUuid` read off the transcript (the
 * previous turn's last entry); cutting at this prompt instead drops its reply
 * (see sdkRewind, docs/spikes/rewind-sdk-findings.md). `undefined` for the first
 * rewindable turn or an unknown id.
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
