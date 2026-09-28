// Boot-stall surface (2026-09-23): a sent turn with no proof of life from the
// CLI is shown, not silent. Main sets `Workspace.bootStallSince`; the sidebar
// badge and the composer row both read it and format through here.

/** Watchdog boot-wedge heal window, mirrored for the row copy (session-wedge.ts
 *  BOOT_SILENCE_MS — kept literal here so the renderer bundle stays main-free). */
export const BOOT_HEAL_AFTER_MS = 3 * 60 * 1000;

/** "45 s" / "1 min 12" — elapsed since the turn was sent. */
export function formatStallElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`;
}

/** Headline + detail for the composer row. */
export function bootStallCopy(sinceMs: number, now: number): { title: string; detail: string } {
  const elapsed = now - sinceMs;
  const title = `La CLI ne répond pas depuis ${formatStallElapsed(elapsed)}`;
  const detail =
    elapsed < BOOT_HEAL_AFTER_MS
      ? `Démarrage bloqué (réseau probable). Relance automatique vers ${formatStallElapsed(BOOT_HEAL_AFTER_MS)}.`
      : 'Démarrage bloqué (réseau probable). La relance automatique est en cours ou a échoué.';
  return { title, detail };
}

/** Headline + detail for the WEDGED surface (issue #197): the session failed to
 *  start after the bound of consecutive fresh restarts, so Orchestra STOPPED
 *  auto-restarting. Distinct from {@link bootStallCopy} — that one is a transient
 *  stall still auto-healing; this one is a terminal give-up that needs a human. */
export function bootWedgedCopy(): { title: string; detail: string } {
  return {
    title: 'Session bloquée — relances automatiques épuisées',
    detail:
      'La session a échoué à démarrer après plusieurs relances (issue #197). ' +
      'Orchestra a arrêté de relancer et a alerté le coordinateur. ' +
      'Relancez manuellement ou recréez le workspace.',
  };
}
