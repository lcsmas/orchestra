// What `orchestra bus-status` prints about a Reprise (#255, ledger #276 D3): "N/M repris — manquent : …". PURE — the CLI imports it statically
// (src/main/pause-reprise.ts pulls the native bus, which the CLI only loads behind its ABI gate), the bus half builds the view.

export interface RepriseStatusView {
  carrier: string;
  pausedAt: number;
  /** 'resuming' while the run is still blocked; 'active' = every member released, accusés still being collected. */
  phase: 'resuming' | 'active';
  total: number;
  released: number;
  /** Reprise accusés received. */
  done: number;
  /** ws ids with no reprise accusé yet, roster order. */
  missing: string[];
  /** ws ids not released yet (still BLOCKED). */
  blocked: string[];
}

/** Does the Pause roster line already printed for `pause` carry THIS view's count? Only the SAME carrier, RESUMING: a nearer carrier paused UNDER a resuming ancestor prints its own
 *  line, and the ancestor's "N/M repris — manquent" would then appear nowhere. */
export function pauseLineCoversReprise(v: RepriseStatusView, pause: { carrierRunId: string; phase: string } | null | undefined): boolean {
  return v.phase === 'resuming' && !!pause && pause.carrierRunId === v.carrier && pause.phase === 'resuming';
}

/** The `bus-status` line(s) for a view — ONE place so the CLI and its test cannot drift. `countShownAbove`: the caller already printed the Pause douce's roster line
 *  ("N/M repris — manquent : …", which reads the same accusés while RESUMING): this view then adds only what that line lacks (libérés, bloqués) — never the count twice. */
export function renderRepriseStatus(v: RepriseStatusView, opts?: { countShownAbove?: boolean }): string[] {
  const dup = v.phase === 'resuming' && opts?.countShownAbove === true;
  const head = v.phase === 'resuming' ? `reprise: RESUMING (carrier ${v.carrier}) — ${v.released}/${v.total} libérés${dup ? '' : ' — '}` : 'reprise: ';
  const lines = [dup ? head : `${head}${v.done}/${v.total} repris${v.missing.length ? ` — manquent : ${v.missing.join(', ')}` : ''}`];
  if (v.blocked.length) lines.push(`reprise: BLOQUÉS (pas encore libérés par leur coordinateur — orchestra run release) : ${v.blocked.join(', ')}`);
  return lines;
}
