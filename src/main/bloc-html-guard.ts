/**
 * Navigation of a Bloc HTML frame (ADR 0011): index.ts's `will-frame-navigate` listener has ALREADY called `preventDefault()` on a sub-frame
 * navigation; this is the one seam #416 turns into a confirmation showing the full URL. Navigation is the leak channel the frame's policy does not close.
 */
export interface BlocFrameInfo {
  processId: number;
  routingId: number;
}

/** Returns the log line for a refused attempt (#416 replaces the body: surface the URL to the renderer, never navigate). */
export function onBlocNavigationAttempt(url: string, frameInfo: BlocFrameInfo): string {
  return `bloc-html: refused a frame navigation (process ${frameInfo.processId}, frame ${frameInfo.routingId}) to ${url.slice(0, 200)}`;
}

/** Every scheme goes to a closed port (127.0.0.1:9): a TURN/TCP or `turns:` connection from a frame fails instead of reaching its host. */
export const BLOC_BLACKHOLE_PROXY_RULES = 'http=127.0.0.1:9;https=127.0.0.1:9;ftp=127.0.0.1:9;socks=127.0.0.1:9';

/** `<-loopback>` makes loopback go through the proxy too (a local listener is exactly what a bloc would aim at); only the dev server's own origin is let through. */
export function blocProxyBypass(devServerUrl: string | undefined): string {
  if (!devServerUrl) return '<-loopback>';
  try { return `<-loopback>,${new URL(devServerUrl).host}`; } catch { return '<-loopback>'; }
}
