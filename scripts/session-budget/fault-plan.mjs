// The fake API's FAULT PLAN — the parameter the soak campaign (C5 #212) hands the API process and C6 #213 (network faults)
// extends. A plan is plain JSON so it crosses a process boundary:
//   { rules: [ { match: { session?: 's2', main?: true }, after?: N, action: { kind: 'hang' } } ] }
// A rule matches a MODEL request from session `match.session` (the soak's key tag `sN`; absent = any) that carries tools when
// `match.main` is true (absent = any model call). `after: N` lets the first N matching requests through, then the action applies
// to every later one. The first matching rule that fires wins.
//
// IMPLEMENTED: `hang` — the request is held open forever (a wedged upstream). It exists as the SEEDED WEDGE of the soak campaign's
// must-FAIL arm. RESERVED for C6: the kinds below throw at compile time so a plan naming one fails loudly instead of silently
// running fault-free (a plan that injects nothing would make a resilience campaign pass vacuously).
export const IMPLEMENTED_ACTIONS = Object.freeze(['hang']);
export const RESERVED_ACTIONS = Object.freeze(['delay', 'status', 'reset', 'truncate', 'blackhole']);

/** Compile a JSON plan to `(rec) => {kind}|null`. Throws on a malformed plan or an unimplemented action. Stateful (per-rule counters). */
export function compileFaultPlan(plan) {
  if (plan == null) return () => null;
  if (typeof plan !== 'object' || !Array.isArray(plan.rules)) throw new Error('fault plan: expected { rules: [...] }');
  const rules = plan.rules.map((r, i) => {
    const kind = r?.action?.kind;
    if (RESERVED_ACTIONS.includes(kind)) throw new Error(`fault plan: rule ${i}: action '${kind}' is reserved for C6 (#213) and not implemented here`);
    if (!IMPLEMENTED_ACTIONS.includes(kind)) throw new Error(`fault plan: rule ${i}: unknown action kind ${JSON.stringify(kind)} (have: ${IMPLEMENTED_ACTIONS.join(', ')})`);
    const after = r.after ?? 0;
    if (!Number.isInteger(after) || after < 0) throw new Error(`fault plan: rule ${i}: after must be a non-negative integer`);
    return { match: r.match ?? {}, after, action: { ...r.action }, seen: 0 };
  });
  return (rec) => {
    if (rec?.type !== 'model') return null;
    for (const r of rules) {
      if (r.match.session !== undefined && rec.sid !== r.match.session) continue;
      if (r.match.main === true && !((rec.tools ?? 0) > 0)) continue;
      if (r.match.main === false && (rec.tools ?? 0) > 0) continue;
      r.seen++;
      if (r.seen > r.after) return r.action;
    }
    return null;
  };
}
