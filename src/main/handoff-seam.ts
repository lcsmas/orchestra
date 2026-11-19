// #466 — the turn-end seam. agent-sdk.ts (which handoff-host.ts imports) announces each ended turn here, so it needs no import back (the same
// cycle-break as sdk-delivery.ts). No listener registered (a rig, a test) ⇒ a no-op.

export interface TurnEndInfo {
  wsId: string;
  /** The SDK session id of the conversation that just ended a turn (changes on a clear / fresh restart). */
  sessionId?: string;
  /** Prompts still queued behind this turn (a clear would discard them). */
  queueLen: number;
}

let listener: ((info: TurnEndInfo) => void) | null = null;

export function setTurnEndListener(fn: ((info: TurnEndInfo) => void) | null): void {
  listener = fn;
}

/** Never throws: a listener bug must not break the consume loop. */
export function notifyTurnEnd(info: TurnEndInfo): void {
  try {
    listener?.(info);
  } catch {
    /* the consume loop outranks the handoff bookkeeping */
  }
}
