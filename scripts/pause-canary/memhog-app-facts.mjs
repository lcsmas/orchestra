// Pause canary 1b (#324) — the PURE shaping of the facts the PACKAGED-app exercise (drive.mjs `doMemhogApp`) reads off the real app into the metric `evaluateMemhogCycle` judges. Split out so the shapes are unit-tested against the REAL producers
// (the keeper's notice file, `sdkMemNotices` entries, bus rows) BEFORE the single run the LEAD's Q11 grants: a plumbing mistake must not cost that run.
import { hogMarker, parseSwarm, readByCoordinator } from './memhog-bars.mjs';

/** The keeper's durable notice file: one JSON record per line, each written behind a blank line (`appendMemNotice`); a torn or foreign line is skipped. */
export function parseNoticeFile(text) {
  return String(text ?? '').split('\n').filter((l) => l.trim()).map((l) => { try { const j = JSON.parse(l); return j && typeof j === 'object' ? j : null; } catch { return null; } }).filter(Boolean);
}

/** The memory-guard settings the PACKAGED rig seeds (#324 review 2+3): the app under test runs its own guard on the REAL host reading, and under the defaults (Admission 6 GB, memory Pause 3 GB) the hogs of 6 members could hold the OPS's wake,
 *  Pause the run, or send the #289 alert to the LEAD (an episode opens on the guard STATE `held`, toggle or not — bar:only_coordinator_told RED on a correct product). Admission OFF + the lowest levels the validator allows (critical 0.5 GB, level
 *  0.6 GB, reopen 1.6 GB) keep the guard open at every reading above 0.6 GB — far below the run's 2 GB floor, which voids the run first — so the CAP is the only memory mechanism under test; the report says so. */
export function appMemoryGuardSeed(capSoftGb, capHardGb) {
  return { capSoftGb, capHardGb, admissionGb: 0.6, criticalGb: 0.5, admissionEnabled: false };
}

/** The LEAD's Q11 envelope for the PACKAGED memory-hog run (ledger #329 D-Q11, #324 only), as one pure check: null = inside it, else why not. Every number must be FINITE (`Number('1GB')` is NaN and NaN fails every `>` test:
 *  the app would then run on its default 6 GiB cap). `capOn` = the frozen `memory_cap` switch ON (the cap-ON run); OFF = the must-FAIL control, whose hogs no scope bounds, so their TOTAL is bounded too. */
export function memhogAppEnvelope({ members, capGb, softGb, hogMb, capOn, waiver }) {
  if (![members, capGb, softGb, hogMb].every(Number.isFinite)) return 'an option that must be a number is not (members / cap-gb / soft-gb / hog-mb)';
  if (!(members >= 1 && members <= 6)) return `--members ${members} is outside 1..6`;
  if (!(capGb > 0 && capGb <= 1)) return `--cap-gb ${capGb} is above 1 (or not positive)`;
  if (!(hogMb > 0 && hogMb <= 1200)) return `--hog-mb ${hogMb} is above 1200 (or not positive)`;
  if (!capOn) return members * hogMb > 3600 ? `${members} hogs of ${hogMb} MB with NO scope to bound them is ${members * hogMb} MB (> 3600)` : null;
  if (!/Q11/.test(waiver ?? '')) return `--waiver must name Q11 (got ${waiver ?? 'none'})`;
  if (!(capGb >= 0.6)) return `--cap-gb ${capGb} is below 0.6 (a real claude is ~330 MB; D-Q11 grants 0.6..1)`;
  if (!(softGb > 0 && softGb <= 0.75 && softGb < capGb)) return `--soft-gb ${softGb} must be in (0, 0.75] and below the hard level ${capGb}`;
  return null;
}

/** D-Q15 (LEAD, ledger #329): the cap-ON packaged run takes BOTH heavy tokens (A and B) — no other heavy rig beside it — and starts from MemAvailable ≥ 11 GB (stricter than D-Q11's 9). Null = inside the rule, else why not. */
export const CAP_ON_START_GB = 11;
export function heavyTokensWhy({ heavy, capOn }) {
  if (!heavy) return 'no --heavy-token';
  if (!capOn) return null;
  const refs = String(heavy).split(',').map((x) => x.trim()).filter(Boolean);
  return refs.length === 2 && refs[0] !== refs[1] ? null : 'the cap-ON run takes BOTH heavy tokens, A and B (D-Q15): --heavy-token <A>,<B>';
}

/** The keeper's own summary line `memory cap: <STATE> unit=… memory.max=… cgroup=…` (`klog`, src/keeper/index.ts) → the `cap.state` vocabulary of its status probe (active | unprotected | not-applied | no-scope); the LAST one wins, none → null.
 *  (#324 review 2: the packaged app's own log has no such line, and the keeper log is the only place the state is written.) */
export function capStateFromKeeperLog(text) {
  let state = null;
  for (const m of String(text ?? '').matchAll(/memory cap: ([A-Z]+(?:-[A-Z]+)*) unit=\S+ memory\.max=/g)) state = m[1].toLowerCase();
  return state;
}

/** #332-fu (OPS 7283, D-Q14): a member's state can flip AFTER boot (placement tripwire → unprotected, a wrapper that cannot run, a leaf that cannot be built…) and the flip reaches ONLY `keepers/<ws>.log` — not the app, Resources or bus-status. Every `memory cap:` line of the keeper log
 *  that is not one of the known BENIGN ones (the boot summary, the DBUS note, "tripwire not armed / gave up", the notice-file budget) is a degradation — fail closed: an unknown new line is listed, never dropped. The boot summary's state alone would miss a later flip. */
const BENIGN_CAP_LINE = [/memory cap: [A-Z]+(?:-[A-Z]+)* unit=\S+ memory\.max=/, /memory cap: DBUS_SESSION_BUS_ADDRESS removed/, /memory cap: the placement tripwire (is NOT armed|gave up)/, /memory cap: notice file budget/];
export function capDegradationsFromKeeperLog(text) {
  return String(text ?? '').split('\n').filter((l) => /memory cap:/.test(l) && !BENIGN_CAP_LINE.some((re) => re.test(l))).map((l) => l.replace(/^\[keeper [^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 220));
}

/**
 * One worker's metric for one cycle.
 *  w {k,id} · cycle · t0 (ms epoch the hogs were started) · opsId
 *  f: { up, scope, swarmText, oomKillDelta, noticeText, storeNotices (Workspace.sdkMemNotices), msgs (bus rows this worker SENT: sequence, kind, recipient, body, created_at), lots (the OPS's deliveries),
 *       idPre {claude, keeper, pid}, idPost {claude, keeper}, keeperAlive, cliAlive, probeAfter (the post-kill probe file exists), scopeActive, keeperLog (the worker's keepers/<ws>.log text), backstop (#343: {kLeafKills, beyondWorkKills} or null) }
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
    backstop: f.backstop ?? null,   // {kLeafKills, beyondWorkKills} from `backstopDelta`, null = not measured (#343)
    records,
    session: {
      keeperAlive: f.keeperAlive === true, cliAlive: f.cliAlive === true,
      keeperSame: !!idPre.keeper && idPre.keeper === idPost.keeper,
      cliSame: !!idPre.claude && idPre.claude === idPost.claude,
      answered: f.probeAfter === true,
      scopeActive: f.scopeActive === true,
      capState: capStateFromKeeperLog(f.keeperLog),
      capDegradations: capDegradationsFromKeeperLog(f.keeperLog),
    },
    memberKillRows: rows.map((e) => e.text),
    coordMsgs: msgs.map((x) => ({ kind: x.kind, recipient: x.recipient, body: x.body })),
    coordRead: readByCoordinator(esc.map((x) => x.sequence), f.lots ?? []),
    firstRowMs: rows.length ? Math.min(...rows.map((e) => e.at)) - t0 : null,
    firstEscMs: esc.length ? Math.min(...esc.map((x) => x.created_at)) - t0 : null,
  };
}
