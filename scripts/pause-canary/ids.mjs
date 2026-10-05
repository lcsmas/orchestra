// Pause canary (#258, wave F ledger #281) — fleet topology shared by lib.mjs / bus-tool.mjs / fleet.mjs / drive.mjs (pure, no I/O).
// Fleet = LEAD (mission run) ⊃ OPS (vague run) ⊃ w1..wN (workers: no run of their own). Branch of workspace <k> = `pc-<k>`.

/** Worker kinds, assigned round-robin so ANY member count keeps the interesting shapes (3 = obey + blocked + quota; 10 = 5 obey, bg, blocked, 3 quota). */
export const KIND_ORDER = ['obey', 'blocked', 'quota', 'bg', 'obey', 'obey', 'obey', 'obey', 'quota', 'quota'];
/**  obey    works command-by-command (a tool-result boundary every ~1 s) and obeys a Pause douce order (commit + push + accusé)
 *   blocked sits in ONE long foreground command (+ a bg task): never reaches a boundary, only the deadline / hard trap takes it
 *   bg      like obey, plus a BACKGROUND task that survives an interrupt (only the trap kills it)
 *   quota   idle after its setup turn (dirty tree, no process); the auto-Pause exercise puts it on a simulated usage limit */

export const uid = (n) => `9c9c9c9c-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const MAX_WORKERS = 10;

export function fleetSpec(nWorkers) {
  if (!Number.isInteger(nWorkers) || nWorkers < 1 || nWorkers > MAX_WORKERS) throw new Error(`members must be 1..${MAX_WORKERS}, got ${nWorkers}`);
  const workers = Array.from({ length: nWorkers }, (_, i) => ({ k: `w${i + 1}`, kind: KIND_ORDER[i % KIND_ORDER.length], id: uid(10 + i + 1) }));
  return { lead: uid(1), ops: uid(2), workers };
}

export const branchOf = (k) => `pc-${k}`;
/** every workspace id → short name (`pc-w3`), for logs */
export function namesOf(spec) {
  const o = { [spec.lead]: 'pc-lead', [spec.ops]: 'pc-ops' };
  for (const w of spec.workers) o[w.id] = `pc-${w.k}`;
  return o;
}
