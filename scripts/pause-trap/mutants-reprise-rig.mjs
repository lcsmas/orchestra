// Load-time MUTANTS for the structured-Reprise rig (#255, wave E ledger #276, E2) — the same mechanism as mutants.mjs (the source text is rewritten as node
// loads it; nothing on disk, nothing to restore; every anchor must match EXACTLY ONCE or the run throws PATTERN-GONE). They only reach the APP side (the
// stand-in loads src/ through the hook); the CLI runs from the BUILT bundle, whose clauses are covered by the in-place unit mutants (mutants-reprise.mjs, build:true).

/** name -> { file suffix, find (global regex), replace, mustRedden (the rig check that has to go red) } */
export const MUTANTS = {
  // A member RELEASED during the Reprise is gated like everyone else: the released coordinator can never start, so it can never release its workers.
  'reprise-gate-ignores-release': {
    file: '/src/main/bus-pause.ts',
    find: /if \(!opts\?\.includeReleased && row\.resumeStartedAt !== null && releasedWhileResuming\(db, id, row\.pausedAt, ws\.id\)\) continue;/g,
    replace: '',
    mustRedden: 'c0:ops_coordinator_may_start',
  },
  // Every roster member reads as released from the instant the Reprise starts: the mass wake the structured Reprise exists to prevent.
  'reprise-gate-releases-everyone': {
    file: '/src/main/pause-reprise.ts',
    find: /memberMayStart\('resuming', row \? \{ releasedAt: n\(row\.released_at\) \} : null\)/g,
    replace: 'true',
    mustRedden: 'c0:workers_blocked_no_mass_wake',
  },
};

let active = null;
export async function initialize(data) {
  active = data?.mutant ?? null;
  if (active && !MUTANTS[active]) throw new Error(`unknown mutant: ${active}`);
}
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!active || !url.endsWith(MUTANTS[active].file)) return result;
  const m = MUTANTS[active];
  let src = String(result.source);
  const edits = m.edits ?? [{ find: m.find, replace: m.replace }];
  for (const e of edits) {
    const hits = [...src.matchAll(e.find)].length;
    if (hits !== 1) throw new Error(`mutant ${active}: PATTERN-GONE — anchor matched ${hits}× in ${m.file} (want exactly 1)`);
    src = src.replace(e.find, e.replace);
  }
  return { ...result, source: src };
}
