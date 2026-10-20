import type { AgentRewindPreview } from '../../../shared/types';

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

// The pure turn lookups live in shared/ (the phone's rewind route in main computes the same cut — Accès mobile).
export { previousRewindId, rewindPrefillText } from '../../../shared/rewind-target.ts';
