import React from 'react';
import type { AgentRewindPreview } from '../../../shared/types';

/** The rewind wiring a user bubble needs. Provided once by StructuredView. */
export interface RewindApi {
  /** SDK dry run — what would be restored on disk. */
  onPreview: (rewindId: string) => Promise<AgentRewindPreview>;
  /** Commit: restore files, truncate the session, prefill the composer. */
  onConfirm: (rewindId: string) => Promise<void>;
  /** True while a turn is in flight — the control disables rather than racing
   *  the session teardown against a stream still writing rows. */
  busy: boolean;
}

/**
 * Rewind wiring, passed by CONTEXT rather than threaded as a prop.
 *
 * The bubble is 4 memo boundaries below StructuredView (ItemSlot → AgentMessage
 * → MessageBubble), and every one of them is deliberately memoized to keep the
 * streaming hot path render-free. Passing this as a prop would mean widening
 * three comparators and re-rendering every row whenever `busy` flips; context
 * lets ONLY the user bubbles that actually read it re-render.
 *
 * `null` (the default) means rewind is unavailable — the SSR smoke harness and
 * any read-only render get no affordance, with no wiring required.
 */
export const RewindContext = React.createContext<RewindApi | null>(null);

/** Read the rewind wiring; `null` when no provider is mounted. */
export function useRewind(): RewindApi | null {
  return React.useContext(RewindContext);
}
