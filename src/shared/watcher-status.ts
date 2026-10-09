// #330 (wave H, ledger #329) — what the app tells a human / an operator about its directory watchers. PURE: the registry (src/main/watchers.ts) hands a `WatchersStatus`; this file turns it into the `bus-status` lines
// and the app warning's words. One source for both so the CLI and the chip can never disagree about WHAT is degraded.
import { plainWatchError, type WatcherSnapshot } from './resilient-watch.ts';

/** The registry's reading: every ARMED watcher (a stopped one is gone). JSON-safe — it rides `/busStatus` and the `watchers:update` push. */
export interface WatchersStatus {
  at: number;
  watchers: WatcherSnapshot[];
}

export const degradedOf = (s: WatchersStatus | null | undefined): WatcherSnapshot[] => (s ? s.watchers.filter((w) => w.state === 'degraded') : []);

/** Edge identity of the degraded set: the push fires when THIS changes, never on an unchanged re-read. */
export const degradedKey = (s: WatchersStatus | null | undefined): string =>
  degradedOf(s)
    .map((w) => `${w.name}@${w.since}`)
    .sort()
    .join('|');

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

const clock = (at: number): string => new Date(at).toISOString().slice(11, 19) + 'Z';

/** The plain words of what is affected, deduplicated, in registry order: « Réveils, Pause view ». */
export function degradedLabels(s: WatchersStatus | null | undefined): string[] {
  return [...new Set(degradedOf(s).map((w) => w.label))];
}

/** The renderer keeps the NEWER of two readings (the boot PULL can be answered after a push that already carried a later state): by the registry's own clock. */
export const newerWatchers = (prev: WatchersStatus | null | undefined, next: WatchersStatus): WatchersStatus => (!prev || next.at >= prev.at ? next : prev);

export interface WatchersStripCopy {
  title: string;
  /** What lags (the plain labels) and the cause, in one sentence + the promise that it retries by itself. */
  body: string;
  /** The tooltip: one line per degraded watcher (what, since when, why, what keeps working meanwhile). */
  lines: string[];
}

/**
 * The sidebar strip's words (D-Q8 = A, French like the Pause rows): names what may lag in plain words and says the app retries by itself. null = nothing degraded ⇒ the strip is not rendered at all and
 * disappears on its own the moment the last watcher is back.
 */
export function watchersStripCopy(s: WatchersStatus | null | undefined, now: number): WatchersStripCopy | null {
  const d = degradedOf(s);
  if (d.length === 0) return null;
  const limit = d.some((w) => w.lastError?.code === 'EMFILE' || w.lastError?.code === 'ENOSPC');
  return {
    title: 'Mises à jour en retard',
    body: `${degradedLabels(s).join(', ')} — ${limit ? 'limite de surveillance de fichiers atteinte' : 'surveillance de fichiers interrompue'}. Nouvel essai automatique.`,
    lines: d.map((w) => `${w.label} · depuis ${clock(w.since)} (${fmtDuration(now - w.since)}) · ${w.lastError ? plainWatchError(w.lastError) : 'erreur inconnue'} · en attendant : ${w.fallback}`),
  };
}

/**
 * The `watchers:` block of `orchestra bus-status`: ONE summary line, then one line per degraded watcher (since when, last error, what keeps working meanwhile). Always at least the summary line when the app
 * answered — an operator reading it must tell « all ok » from « the app did not say ».
 */
export function formatWatchersLines(s: WatchersStatus, now: number): string[] {
  const total = s.watchers.length;
  const d = degradedOf(s);
  if (total === 0) return ['watchers: none armed'];
  if (d.length === 0) return [`watchers: ${total} ok`];
  const limit = d.some((w) => w.lastError?.code === 'EMFILE' || w.lastError?.code === 'ENOSPC');
  const lines = [`watchers: ${total - d.length}/${total} ok · ${d.length} DEGRADED — ${degradedLabels(s).join(', ')}${limit ? ' (system watch limit reached)' : ''}; the app re-arms by itself`];
  for (const w of d) {
    const err = w.lastError ? plainWatchError(w.lastError) : 'unknown error';
    const detail = w.lastError && w.lastError.message && !err.includes(w.lastError.message) ? ` · ${w.lastError.message}` : '';
    lines.push(`  ${w.name} DEGRADED since ${clock(w.since)} (${fmtDuration(now - w.since)}) — ${err}${detail} · ${w.attempts} attempt${w.attempts === 1 ? '' : 's'} · ${w.dir} · meanwhile: ${w.fallback}`);
  }
  return lines;
}
