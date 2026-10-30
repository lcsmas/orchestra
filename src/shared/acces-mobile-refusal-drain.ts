// Accès mobile (#408): what the server does with a sender it just refused with a 413 while the sender is still pushing the body.
// Closing at once makes the kernel RST the sender; its write error then discards the unread 413 (client reads -1). So the 413 goes out whole,
// the rest is read and thrown away under these bounds, and the connection is held (not read) until the sender hangs up or the deadline cuts it.
import { MOBILE_SEND_MAX_BODY } from './acces-mobile-conversation.ts';

/** Bytes read-and-discarded after the 413; past this the socket is paused (the sender stalls on TCP backpressure, nothing more is buffered). */
export const REFUSED_DRAIN_MAX_BYTES = 8 * MOBILE_SEND_MAX_BODY;
/** Hard deadline after the 413: whatever the sender is doing, the connection is destroyed then. */
export const REFUSED_LINGER_MAX_MS = 10_000;

export type RefusedDrainStep =
  | 'drain' // keep reading and discarding
  | 'hold' // stop reading (pause); keep the connection so the sender can still read the 413
  | 'done' // the sender finished its body: end the response, a clean close
  | 'cut'; // deadline: destroy the connection

/** The only decision table of the post-413 close. `done` beats `cut` (a sender that finished is closed cleanly, never reset). */
export function refusedDrainStep(s: { discardedBytes: number; requestEnded: boolean; lingerExpired: boolean; maxBytes?: number }): RefusedDrainStep {
  if (s.requestEnded) return 'done';
  if (s.lingerExpired) return 'cut';
  if (s.discardedBytes >= (s.maxBytes ?? REFUSED_DRAIN_MAX_BYTES)) return 'hold';
  return 'drain';
}
