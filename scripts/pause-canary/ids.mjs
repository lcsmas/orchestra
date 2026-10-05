// Pause canary (#258, wave F ledger #281) — fleet topology shared by lib.mjs / bus-tool.mjs / fleet.mjs / drive.mjs (pure, no I/O).
// Fleet = LEAD (mission run) ⊃ OPS (vague run) ⊃ w1..wN (workers: no run of their own). Branch of workspace <k> = `pc-<k>`.

/** Worker kinds, assigned round-robin so ANY member count keeps the interesting shapes (3 = obey + blocked + quota; 6 = obey + blocked + bg + 3 quota — one quota member per cycle; 10 = 5 obey, bg, blocked, 3 quota). */
export const KIND_ORDER = ['obey', 'blocked', 'quota', 'bg', 'quota', 'quota', 'obey', 'obey', 'obey', 'obey'];
/**  obey    works command-by-command (a tool-result boundary every ~1 s) and obeys a Pause douce order (commit + push + accusé)
 *   blocked sits in ONE long foreground command (+ a bg task): never reaches a boundary, only the deadline / hard trap takes it
 *   bg      like obey, plus a BACKGROUND task that survives an interrupt (only the trap kills it)
 *   quota   idle after its setup turn (dirty tree, no process); the auto-Pause exercise puts it on a simulated usage limit */

/** A PER-RIG random 8-hex prefix. Workspace ids must be unique across every rig on the host: `keeperSocketPath` falls back to `/tmp/okeeper-<sha256(wsId)>.sock` when `<home>/keepers/<id>.sock` exceeds 100 chars
 *  (a rig path always does) and that hash does NOT contain ORCHESTRA_HOME — two concurrent rigs with the same ids would share keeper sockets (verifier n°2, ledger #281). */
export const randomPrefix = () => Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
export const uid = (n, prefix) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const MAX_WORKERS = 10;

export function fleetSpec(nWorkers, prefix = randomPrefix()) {
  if (!Number.isInteger(nWorkers) || nWorkers < 1 || nWorkers > MAX_WORKERS) throw new Error(`members must be 1..${MAX_WORKERS}, got ${nWorkers}`);
  const workers = Array.from({ length: nWorkers }, (_, i) => ({ k: `w${i + 1}`, kind: KIND_ORDER[i % KIND_ORDER.length], id: uid(10 + i + 1, prefix) }));
  return { prefix, lead: uid(1, prefix), ops: uid(2, prefix), workers };
}

export const branchOf = (k) => `pc-${k}`;
/** every workspace id → short name (`pc-w3`), for logs */
export function namesOf(spec) {
  const o = { [spec.lead]: 'pc-lead', [spec.ops]: 'pc-ops' };
  for (const w of spec.workers) o[w.id] = `pc-${w.k}`;
  return o;
}
