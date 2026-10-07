// Memory banner (#289, epic #284 "Visibility", D5 ruling D-pick3 = option B: main column above the pane, 2 lines, French, global) — the PURE half: what the banner shows, in what words, and when a « Masquer » stops
// applying. Impure halves: src/main/memory-banner.ts (state from the guard + Admission + the bus) and src/main/memory-banner-host.ts (IPC + push); the component: src/renderer/components/MemoryBanner.tsx.
//
// Two states, one banner: Admission HELD (amber — starts held, idle members to Veille) and the memory Pause IN EFFECT (red — at least one run IS under the host's memory Pause; the guard's own `pause` flag alone is not
// that: nothing may be eligible to pause). It exists only while the guard HOLDS (`admissionEnabled` on) or a memory Pause is in effect; it vanishes by itself on recovery. « Masquer » hides it until the episode ends:
// it REAPPEARS on an escalation (held → Pause), on every new Pause cycle and on the next episode — and stays hidden if a Pause lifts back to held (a de-escalation is not news).

import { RELEASE_MARGIN_GB, GIB, isAdmissionHolding, type MemoryGuardSnapshot } from './memory-guard.ts';

export type MemoryBannerKind = 'none' | 'held' | 'pause';

export interface MemoryBannerState {
  kind: MemoryBannerKind;
  /** The guard's Admission episode / memory-Pause cycle (the dismiss key). */
  episode: number;
  pauseCycle: number;
  availBytes: number | null;
  admissionBytes: number;
  criticalBytes: number;
  releaseMarginBytes: number;
  /** Automatic fleet starts currently HELD by Admission. */
  heldStarts: number;
  /** The runs under the memory Pause, as the UI names them (labels, never raw ids when a label exists). */
  pausedRuns: string[];
  /** Strictly increasing per main process: the renderer drops an OLDER state (a pull racing a fresher push). */
  rev: number;
}

export const NO_MEMORY_BANNER: MemoryBannerState = { kind: 'none', episode: 0, pauseCycle: 0, availBytes: null, admissionBytes: 6 * GIB, criticalBytes: 3 * GIB, releaseMarginBytes: RELEASE_MARGIN_GB * GIB, heldStarts: 0, pausedRuns: [], rev: 0 };

/** The banner's state from the guard's snapshot + what the host actions look like now. Unknown ≠ held: an unmeasured meter shows nothing (unless a memory Pause is still in effect — its runs ARE paused).
 *  RED means runs ARE under the memory Pause (the bus says so), never merely "the guard is below critical": with every `pause` switch OFF, no fleet or only manually paused runs there is no Pause to announce. */
export function memoryBannerOf(s: MemoryGuardSnapshot, facts: { heldStarts: number; pausedRuns: readonly string[] }, rev = 0): MemoryBannerState {
  const pausedRuns = [...facts.pausedRuns];
  const inPause = pausedRuns.length > 0;
  const holding = s.measured && isAdmissionHolding(s);
  const kind: MemoryBannerKind = inPause ? 'pause' : holding ? 'held' : 'none';
  if (kind === 'none') return { ...NO_MEMORY_BANNER, rev }; // nothing to show: the figures of an idle guard are not a change worth pushing
  return {
    kind,
    episode: s.episode,
    pauseCycle: s.pauseCycle,
    availBytes: s.measured ? s.availBytes : null,
    admissionBytes: s.admissionBytes,
    criticalBytes: s.criticalBytes,
    releaseMarginBytes: s.releaseMarginBytes,
    heldStarts: facts.heldStarts,
    pausedRuns,
    rev,
  };
}

/** What counts as "the same banner" for the push: everything but the revision. */
export function bannerFingerprint(b: MemoryBannerState): string {
  return JSON.stringify({ ...b, rev: 0 });
}

/** The newer of two states by revision (a pull answered after a push must not roll the banner back). */
export function newerBanner(prev: MemoryBannerState | null, next: MemoryBannerState): MemoryBannerState {
  return prev && prev.rev > next.rev ? prev : next;
}

// ─── « Masquer » ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The identity of what the human dismissed: one banner kind of one episode — and, for the Pause, one Pause CYCLE. A different key ⇒ it shows again. */
export function bannerKey(b: Pick<MemoryBannerState, 'kind' | 'episode' | 'pauseCycle'>): string {
  return `${b.episode}:${b.kind}:${b.kind === 'pause' ? b.pauseCycle : 0}`;
}

/** Visible = something to show AND not a banner the human dismissed. The renderer keeps EVERY key dismissed since the last recovery (a Pause that lifts back to held shows the held banner already dismissed). */
export function bannerVisible(b: MemoryBannerState | null, dismissedKeys: readonly string[]): boolean {
  if (!b || b.kind === 'none') return false;
  return !dismissedKeys.includes(bannerKey(b));
}

/** The dismissed keys after a click on « Masquer » while `b` is up (idempotent). */
export function dismissedWith(dismissedKeys: readonly string[], b: MemoryBannerState | null): readonly string[] {
  if (!b || b.kind === 'none') return dismissedKeys;
  const k = bannerKey(b);
  return dismissedKeys.includes(k) ? dismissedKeys : [...dismissedKeys, k];
}

// ─── the words (French, like the Pause UI) ─────────────────────────────────────────────────────────────────────────────────────────────

/** « 5,4 Go » — one decimal, a comma, GiB; « 6 Go » when the figure is whole. */
export function frGo(bytes: number): string {
  const v = Math.round((bytes / GIB) * 10) / 10;
  return `${Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ',')} Go`;
}

export interface BannerCopy {
  tone: 'warn' | 'crit';
  /** First line (the headline sentence). */
  title: string;
  /** Second line (what the host does next). */
  sub: string;
}

const frList = (xs: readonly string[]): string => (xs.length <= 3 ? xs.join(', ') : `${xs.slice(0, 3).join(', ')} +${xs.length - 3}`);

/** The two lines of a visible banner; null for `none`. */
export function bannerCopy(b: MemoryBannerState): BannerCopy | null {
  if (b.kind === 'none') return null;
  const mem = b.availBytes === null ? 'mémoire illisible' : `${frGo(b.availBytes)} disponibles`;
  if (b.kind === 'pause') {
    const runs = `${b.pausedRuns.length} run${b.pausedRuns.length > 1 ? 's' : ''} en pause : ${frList(b.pausedRuns)}.`;
    return {
      tone: 'crit',
      title: `Pause mémoire — ${mem} (seuil critique ${frGo(b.criticalBytes)}). ${runs}`,
      sub: `Reprise automatique dès ${frGo(b.admissionBytes)} · une pause manuelle n'est jamais levée par la garde.`,
    };
  }
  const held = `${b.heldStarts} démarrage${b.heldStarts > 1 ? 's' : ''} retenu${b.heldStarts > 1 ? 's' : ''}`; // the drawn pattern, whatever N (0 included)
  return {
    tone: 'warn',
    title: `Mémoire basse — ${mem} (seuil ${frGo(b.admissionBytes)}). Les démarrages automatiques d'agents sont retenus ; les agents inactifs passent en Veille.`,
    sub: `${held} · relâchés dès ${frGo(b.admissionBytes + b.releaseMarginBytes)}, coordinateurs d'abord, un par un.`,
  };
}
