/**
 * Navigation of a Bloc HTML frame (ADR 0011): index.ts's `will-frame-navigate` listener has ALREADY called `preventDefault()` on a sub-frame
 * navigation; this is the one seam #416 turns into a confirmation showing the full URL. Since D5 (network allowed over https) it is a UX guard — the user sees a URL before anything opens — not a leak guard.
 */
export interface BlocFrameInfo {
  processId: number;
  routingId: number;
}

/** Returns the log line for a refused attempt (#416 replaces the body: surface the URL to the renderer, never navigate). */
export function onBlocNavigationAttempt(url: string, frameInfo: BlocFrameInfo): string {
  return `bloc-html: refused a frame navigation (process ${frameInfo.processId}, frame ${frameInfo.routingId}) to ${url.slice(0, 200)}`;
}
