/**
 * Navigation of a Bloc HTML frame (ADR 0011): index.ts's `will-frame-navigate` listener has ALREADY called `preventDefault()` on a sub-frame
 * navigation; this is the one seam #416 turns into a confirmation showing the full URL. Since D5 (network allowed over https) it is a UX guard — the user sees a URL before anything opens — not a leak guard.
 */
import { randomUUID } from 'node:crypto';
import type { BlocNavigationRequest } from '../shared/bloc-html-navigation.ts';

export interface BlocFrameInfo {
  processId: number;
  routingId: number;
}

export const BLOC_NAV_PUSH_CHANNEL = 'blocNav:request';
export const BLOC_NAV_PULL_CHANNEL = 'blocNav:pending';
export const BLOC_NAV_ANSWER_CHANNEL = 'blocNav:answer';
/** A URL we could not show in full is not offered at all (nothing opens that the human could not read). */
export const BLOC_NAV_MAX_URL_CHARS = 32 * 1024;
/** One confirmation at a time; an unanswered one dismisses itself. */
export const BLOC_NAV_EXPIRY_MS = 120_000;
/** A frame is silent after an answer: 3 s after a confirm; after the Nth dismissal 5 s x 2^(N-1), capped (a looping script cannot spam). */
export const BLOC_NAV_MUTE_CONFIRM_MS = 3_000;
export const BLOC_NAV_MUTE_DISMISS_MS = 5_000;
export const BLOC_NAV_MUTE_MAX_MS = 300_000;

export type BlocNavigationVerdict = 'surfaced' | 'coalesced' | 'muted' | 'not-offered';

export interface BlocNavigationGateDeps {
  /** Show the confirmation (the ONLY outcome of an attempt that reaches the human). */
  showConfirmation: (req: BlocNavigationRequest) => void;
  /** Retract it (answered / expired). */
  clearConfirmation: () => void;
  /** Open the URL the way a link in a reply opens (api-handlers `openUrlExternally`). Reached ONLY from a `confirmed` answer. */
  open: (req: BlocNavigationRequest) => void;
  now?: () => number;
  /** Returns a cancel fn. Default: an unref'd `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => () => void;
  newId?: () => string;
}

export interface BlocNavigationGate {
  attempt(url: string, frame: BlocFrameInfo): BlocNavigationVerdict;
  /** `confirmed` true ⇒ opens; anything else (false, a stale/unknown id) opens nothing. */
  answer(id: string, confirmed: boolean): 'opened' | 'dismissed' | 'stale';
  pending(): BlocNavigationRequest | null;
}

const UNKNOWN_FRAME = '-1:-1';

const isWebUrl = (url: string): boolean => {
  try { const p = new URL(url).protocol; return p === 'http:' || p === 'https:'; } catch { return false; }
};

/** The state machine behind a Bloc HTML navigation (#416): one pending confirmation, per-frame silence after an answer, nothing opens but a confirmed id. */
export function createBlocNavigationGate(deps: BlocNavigationGateDeps): BlocNavigationGate {
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });
  const newId = deps.newId ?? randomUUID;
  let current: { req: BlocNavigationRequest; frameKey: string; cancel: () => void } | null = null;
  const muted = new Map<string, { until: number; dismissals: number }>();

  const settle = (id: string, confirmed: boolean): 'opened' | 'dismissed' | 'stale' => {
    if (!current || current.req.id !== id) return 'stale';
    const { req, frameKey, cancel } = current;
    current = null;
    cancel();
    // An attempt whose frame could not be identified (UNKNOWN_FRAME) shares the silence of every answer: a looping frame must not slip back in as "unknown".
    for (const k of new Set([frameKey, UNKNOWN_FRAME])) {
      const prev = muted.get(k)?.dismissals ?? 0;
      if (confirmed) muted.set(k, { until: now() + BLOC_NAV_MUTE_CONFIRM_MS, dismissals: 0 });
      else muted.set(k, { until: now() + Math.min(BLOC_NAV_MUTE_DISMISS_MS * 2 ** prev, BLOC_NAV_MUTE_MAX_MS), dismissals: prev + 1 });
    }
    if (muted.size > 256) muted.delete(muted.keys().next().value as string);
    deps.clearConfirmation();
    if (confirmed) deps.open(req);
    return confirmed ? 'opened' : 'dismissed';
  };

  return {
    attempt(url, frame) {
      if (!isWebUrl(url) || url.length > BLOC_NAV_MAX_URL_CHARS) return 'not-offered';
      const frameKey = frame.processId < 0 || frame.routingId < 0 ? UNKNOWN_FRAME : `${frame.processId}:${frame.routingId}`;
      if (current) return 'coalesced';
      const m = muted.get(frameKey);
      if (m && now() < m.until) return 'muted';
      const req: BlocNavigationRequest = { id: newId(), url };
      current = { req, frameKey, cancel: schedule(() => { settle(req.id, false); }, BLOC_NAV_EXPIRY_MS) };
      deps.showConfirmation(req);
      return 'surfaced';
    },
    answer: (id, confirmed) => settle(id, confirmed === true),
    pending: () => current?.req ?? null,
  };
}

let installed: BlocNavigationGate | null = null;
/** index.ts installs the real gate once; without one (unit tests) an attempt is only logged. */
export function installBlocNavigationGate(gate: BlocNavigationGate | null): void {
  installed = gate;
}

type FrameLike = { processId: number; routingId: number };
/** The frame a bloc navigation comes FROM: `event.initiator` (stable across repeats), else `event.frame`; (-1,-1) when neither reads. `event.frame` alone THROWS ("Render frame was disposed") from a frame's 2nd attempt on — rig N5/N10. */
export function blocFrameInfo(event: { initiator?: FrameLike | null; frame?: FrameLike | null }): BlocFrameInfo {
  for (const read of [() => event.initiator, () => event.frame]) {
    try {
      const f = read();
      if (f) return { processId: f.processId, routingId: f.routingId };
    } catch { /* this source is gone: try the next */ }
  }
  return { processId: -1, routingId: -1 };
}

/** Returns the log line for a refused attempt; a web URL is surfaced as a confirmation (never navigated). Never throws (the navigation is already refused). */
export function onBlocNavigationAttempt(url: string, frameInfo: BlocFrameInfo): string {
  let verdict: BlocNavigationVerdict | 'error' = 'not-offered';
  try { if (installed) verdict = installed.attempt(url, frameInfo); } catch { verdict = 'error'; }
  return `bloc-html: refused a frame navigation (process ${frameInfo.processId}, frame ${frameInfo.routingId}) to ${url.slice(0, 200)} → ${verdict}`;
}

/** The slice of Electron's `IpcMainInvokeEvent` the answer guard reads. */
export interface BlocNavIpcEvent {
  sender: { mainFrame?: unknown };
  senderFrame?: unknown | null;
}

/** The renderer's pull + answer. A sender that is not the app window's top frame is refused (fail closed); the answer carries an id, never a URL. */
export function registerBlocNavigationIpc(ipc: { handle(channel: string, fn: (e: BlocNavIpcEvent, ...args: any[]) => unknown): void }, gate: BlocNavigationGate): void {
  const fromTopFrame = (e: BlocNavIpcEvent) => e.senderFrame != null && e.senderFrame === e.sender?.mainFrame;
  ipc.handle(BLOC_NAV_PULL_CHANNEL, (e) => (fromTopFrame(e) ? gate.pending() : null));
  ipc.handle(BLOC_NAV_ANSWER_CHANNEL, (e, id: unknown, confirmed: unknown) =>
    fromTopFrame(e) && typeof id === 'string' ? gate.answer(id, confirmed === true) : 'stale');
}
