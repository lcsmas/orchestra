// Pause canary 1b (#324) — the PURE shaping of the facts the PACKAGED-app exercise (drive.mjs `doMemhogApp`) reads off the real app into the metric `evaluateMemhogCycle` judges. Split out so the shapes are unit-tested against the REAL producers
// (the keeper's notice file, `sdkMemNotices` entries, bus rows) BEFORE the single run the LEAD's Q11 grants: a plumbing mistake must not cost that run.
import { hogMarker, parseSwarm, readByCoordinator } from './memhog-bars.mjs';

/** The keeper's durable notice file: one JSON record per line, each written behind a blank line (`appendMemNotice`); a torn or foreign line is skipped. */
export function parseNoticeFile(text) {
  return String(text ?? '').split('\n').filter((l) => l.trim()).map((l) => { try { const j = JSON.parse(l); return j && typeof j === 'object' ? j : null; } catch { return null; } }).filter(Boolean);
}

/** The memory-guard settings the PACKAGED rig seeds (#324 review 2): the app under test runs its own guard on the REAL host reading, and under the defaults (Admission 6 GB, memory Pause 3 GB) the hogs of 6 members could hold the OPS's wake
 *  (bar:coordinator_told RED on a correct product) or Pause the run. Admission OFF + a critical level at the floor (0.5 GB) leave the CAP as the only memory mechanism under test; the report says so. */
export function appMemoryGuardSeed(capSoftGb, capHardGb) {
  return { capSoftGb, capHardGb, admissionGb: 1.5, criticalGb: 0.5, admissionEnabled: false };
}

/** The keeper's own summary line `memory cap: <STATE> unit=… memory.max=… cgroup=…` (`klog`, src/keeper/index.ts) → the `cap.state` vocabulary of its status probe (active | unprotected | not-applied | no-scope); the LAST one wins, none → null.
 *  (#324 review 2: the packaged app's own log has no such line, and the keeper log is the only place the state is written.) */
export function capStateFromKeeperLog(text) {
  let state = null;
  for (const m of String(text ?? '').matchAll(/memory cap: ([A-Z]+(?:-[A-Z]+)*) unit=\S+ memory\.max=/g)) state = m[1].toLowerCase();
  return state;
}

/**
 * One worker's metric for one cycle.
 *  w {k,id} · cycle · t0 (ms epoch the hogs were started) · opsId
 *  f: { up, scope, swarmText, oomKillDelta, noticeText, storeNotices (Workspace.sdkMemNotices), msgs (bus rows this worker SENT: sequence, kind, recipient, body, created_at), lots (the OPS's deliveries),
 *       idPre {claude, keeper, pid}, idPost {claude, keeper}, keeperAlive, cliAlive, probeAfter (the post-kill probe file exists), scopeActive, keeperLog (the worker's keepers/<ws>.log text) }
 */
export function workerFromAppFacts(w, cycle, t0, opsId, f) {
  const msgs = f.msgs ?? [];
  const esc = msgs.filter((x) => x.kind === 'escalation' && x.recipient === opsId);
  const rows = (f.storeNotices ?? []).filter((e) => e.level !== 'soft' && e.at >= t0 - 1000);
  const records = parseNoticeFile(f.noticeText).filter((r) => r.kind !== 'soft' && r.at >= t0 - 1000).map((r) => ({ level: r.level, command: r.command ?? null, pid: r.pid, source: r.source }));
  const idPre = f.idPre ?? {};
  const idPost = f.idPost ?? {};
  return {
    k: w.k, id: w.id, up: f.up === true, marker: hogMarker(w.k, cycle),
    scope: f.scope,
    swarm: parseSwarm(f.swarmText),
    oomKillDelta: typeof f.oomKillDelta === 'number' ? f.oomKillDelta : null,
    records,
    session: {
      keeperAlive: f.keeperAlive === true, cliAlive: f.cliAlive === true,
      keeperSame: !!idPre.keeper && idPre.keeper === idPost.keeper,
      cliSame: !!idPre.claude && idPre.claude === idPost.claude,
      answered: f.probeAfter === true,
      scopeActive: f.scopeActive === true,
      capState: capStateFromKeeperLog(f.keeperLog),
    },
    memberKillRows: rows.map((e) => e.text),
    coordMsgs: msgs.map((x) => ({ kind: x.kind, recipient: x.recipient, body: x.body })),
    coordRead: readByCoordinator(esc.map((x) => x.sequence), f.lots ?? []),
    firstRowMs: rows.length ? Math.min(...rows.map((e) => e.at)) - t0 : null,
    firstEscMs: esc.length ? Math.min(...esc.map((x) => x.created_at)) - t0 : null,
  };
}
