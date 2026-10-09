// Pause canary 1b (#324) — the PURE shaping of the facts the PACKAGED-app exercise (drive.mjs `doMemhogApp`) reads off the real app into the metric `evaluateMemhogCycle` judges. Split out so the shapes are unit-tested against the REAL producers
// (the keeper's notice file, `sdkMemNotices` entries, bus rows) BEFORE the single run the LEAD's Q11 grants: a plumbing mistake must not cost that run.
import { hogMarker, parseSwarm, readByCoordinator } from './memhog-bars.mjs';

/** The keeper's durable notice file: one JSON record per line, each written behind a blank line (`appendMemNotice`); a torn or foreign line is skipped. */
export function parseNoticeFile(text) {
  return String(text ?? '').split('\n').filter((l) => l.trim()).map((l) => { try { const j = JSON.parse(l); return j && typeof j === 'object' ? j : null; } catch { return null; } }).filter(Boolean);
}

/**
 * One worker's metric for one cycle.
 *  w {k,id} · cycle · t0 (ms epoch the hogs were started) · opsId
 *  f: { up, scope, swarmText, oomKillDelta, noticeText, storeNotices (Workspace.sdkMemNotices), msgs (bus rows this worker SENT: sequence, kind, recipient, body, created_at), lots (the OPS's deliveries),
 *       idPre {claude, keeper, pid}, idPost {claude, keeper}, keeperAlive, cliAlive, probeAfter (the post-kill probe file exists), scopeActive, appLog }
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
      capState: new RegExp(`memory-cap\\[${w.id}\\]: ACTIVE`).test(f.appLog ?? '') ? 'active' : null,
    },
    memberKillRows: rows.map((e) => e.text),
    coordMsgs: msgs.map((x) => ({ kind: x.kind, recipient: x.recipient, body: x.body })),
    coordRead: readByCoordinator(esc.map((x) => x.sequence), f.lots ?? []),
    firstRowMs: rows.length ? Math.min(...rows.map((e) => e.at)) - t0 : null,
    firstEscMs: esc.length ? Math.min(...esc.map((x) => x.created_at)) - t0 : null,
  };
}
