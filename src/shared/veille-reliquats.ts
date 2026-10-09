// Veille and Reliquats (#326, wave H ledger #329; contract FI-1 v1.3/v1.4 + OPS ruling R10). Pure: no fs, no process table.
//
// A member idle past the Veille threshold but with LIVE Reliquats (processes of its kernel scope outside its session's tree — a background dev server, a rig browser — or, with no
// tracked scope, #331's orphaned headless browsers) is put in Veille only after the Reliquat delay (Garde mémoire setting, default 30 min); the Veille then STOPS them and tells
// the member at its next turn which were stopped. Fast Veille (#288, Admission held) skips the delay and stops + lists them the same way. The decision lives in
// `shouldHibernate` (shared/hibernation.ts); this file words the notice, reusing the Consigne's own item rendering (`reliquatKilledItemLines`).

import { formatIdleDuration } from './hibernation.ts';
import { reliquatKilledItemLines, type ReliquatReport } from './pause-reliquats.ts';

export interface VeilleNoticeContext {
  /** The member went early because Admission is held (fast Veille, #288), not because its idle time ran out. */
  fast: boolean;
  /** How long it had been idle (ms), for the sentence. */
  idleMs: number;
}

const LISTED = 12;

/** Is there anything to tell the member? (a stop, a survivor, a refusal, a sparing or an unreadable scope — all of them are facts it should know) */
export function veilleHasNews(r: ReliquatReport | null | undefined): r is ReliquatReport {
  return !!r && (r.killed.some((k) => k.outcome !== 'planned') || r.survivors.length > 0 || r.refused.length > 0 || r.spared.length > 0);
}

/**
 * The notice a member finds at its next turn: what the Veille stopped (LISTED, NEVER re-run — the member decides), what it could not stop, what it left on purpose.
 * Null when there is nothing to say. `strip` = the Consigne's control-character strip (a command line comes from any process of the member: it must never forge a line in its prompt).
 */
export function veilleReliquatNotice(r: ReliquatReport | null | undefined, ctx: VeilleNoticeContext, strip: (s: unknown) => string): string | null {
  if (!veilleHasNews(r)) return null;
  const done = r.killed.filter((k) => k.outcome !== 'planned');
  const lines: string[] = [];
  // worded so it stays TRUE whether or not the Veille itself went through (a wake, a delete or a freed Admission can still drop it after the stop)
  const why = ctx.fast ? 'early, to free memory (Admission is held)' : `because you had been idle for ${formatIdleDuration(ctx.idleMs)} (the Veille wait for members with leftover processes)`;
  if (done.length > 0) {
    const n = r.killedTotal ?? done.length;
    lines.push(`Orchestra stopped ${n} leftover process(es) of yours (Reliquats) ${why} — processes you started that had left your session's process tree (detached daemons, a dev server, orphaned headless browsers); LISTED, NOT re-run. Re-run one only if you still need it, after checking the tree:`);
    lines.push(...reliquatKilledItemLines(done, n, strip, 'see the Orchestra log'));
  } else {
    lines.push(`Orchestra looked at your leftover processes (Reliquats) ${why}; it stopped none of them:`);
  }
  const cut = (s: string, n: number): string => {
    const c = strip(s);
    return c.length > n ? `${c.slice(0, n - 1)}…` : c;
  };
  for (const s of r.survivors.slice(0, LISTED)) lines.push(`STILL ALIVE after the Veille (Reliquat): ${cut(s.cmd, 200)} (pid ${s.pid}: ${cut(s.reason, 80)})`);
  for (const s of r.refused.slice(0, LISTED)) lines.push(`Leftover process NOT stopped (identity not provable, pid ${s.pid}): ${cut(s.reason, 120)} — ${cut(s.cmd, 120)}`);
  if (r.spared.length > 0) lines.push(`Leftover processes left running on purpose (${r.spared.length}): ${r.spared.slice(0, 3).map((s) => `${cut(s.cmd, 60)} (pid ${s.pid})`).join('; ')}${r.spared.length > 3 ? '; …' : ''}`);
  return lines.join('\n');
}
