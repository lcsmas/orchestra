// The rewind target's neighbours in a folded conversation — pure, shared by the desktop's rewind (renderer rewind-util.ts) and the
// phone's (main acces-mobile-routes.ts), so both surfaces compute the SAME fallback cut and edit-and-retry text.

import type { RenderMessage } from './types.ts';

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
