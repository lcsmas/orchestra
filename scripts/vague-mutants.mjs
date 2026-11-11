// In-place one-clause mutants of the Vague endormie (#428): each must turn the unit suites RED; the unmutated tree must be GREEN first (positive control) and every file is restored byte-exact (sha check).
//   node scripts/vague-mutants.mjs [--only <id>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SUITES = ['src/shared/vague-endormie.test.ts', 'src/main/vague-endormie.test.ts', 'src/main/vague-roster.test.ts', 'src/main/vague-endormie-wiring.test.ts', 'src/main/vague-endormie-store.test.ts'];
const S = 'src/shared/vague-endormie.ts';
const M = 'src/main/vague-endormie.ts';
const R = 'src/main/vague-roster.ts';
const H = 'src/main/vague-endormie-host.ts';
const F = 'src/main/vague-endormie-store.ts';
const BLOCK = "  if (f.paused) return 'paused';\n  if (f.runHeld) return 'run-held';\n";
const MUTANTS = [
  // ── the asleep definition (blockerOf): one arm per clause
  ['blk-no-task', S, "export function blockerOf(f: VagueFacts): VagueAwakeWhy | null {\n  if (!f.members.some((m) => m.unfinished)) return 'no-task';\n", 'export function blockerOf(f: VagueFacts): VagueAwakeWhy | null {\n'],
  ['blk-paused', S, `${BLOCK}  if (people(f).some((p) => p.active))`, "  if (f.runHeld) return 'run-held';\n  if (people(f).some((p) => p.active))"],
  ['blk-run-held', S, "  if (f.runHeld) return 'run-held';\n  if (people(f).some((p) => p.active))", '  if (people(f).some((p) => p.active))'],
  ['blk-active', S, "  if (people(f).some((p) => p.active)) return 'member-active';\n", ''],
  ['blk-waiting', S, "  if (people(f).some((p) => p.waiting)) return 'waiting';\n", ''],
  ['blk-held-start', S, "  if (people(f).some((p) => p.heldStart)) return 'held-start';\n", ''],
  ['blk-active-members-only', S, "if (people(f).some((p) => p.active)) return 'member-active';", "if (f.members.some((p) => p.active)) return 'member-active';"],
  ['blk-waiting-members-only', S, "if (people(f).some((p) => p.waiting)) return 'waiting';", "if (f.members.some((p) => p.waiting)) return 'waiting';"],
  ['blk-dormant', S, "  if (!everSeen) return { state: {}, verdict: { kind: 'awake', why: DORMANT } };\n", ''],
  ['blk-dormant-coordinator-only', S, 'const seen = people(f).some((p) => p.seenThisRun);', 'const seen = f.coordinator.seenThisRun;'],
  ['blk-dormant-all-must-be-seen', S, 'const seen = people(f).some((p) => p.seenThisRun);', 'const seen = people(f).every((p) => p.seenThisRun);'],
  ['ever-seen-not-kept', S, 'const everSeen = prev?.everSeen === true || seen;', 'const everSeen = seen;'],
  ['ever-seen-not-recorded', S, 'return everSeen && !r.state.everSeen ? { state: { ...r.state, everSeen }, verdict: r.verdict } : r;', 'return r;'],
  // ── quiet clock + delay
  ['quiet-ignores-active', S, 'p.active || p.waiting || p.heldStart ? now : p.seenThisRun || hint === undefined ? p.lastActivityAt : hint', 'p.seenThisRun || hint === undefined ? p.lastActivityAt : hint'],
  ['quiet-members-only', S, 'const quietSince = quietSinceOf(f, now, prev?.quietHint);', 'const quietSince = Math.max(...f.members.map((m) => m.lastActivityAt));'],
  ['quiet-no-floor', S, 'since = Math.max(quietSince, prev?.protectedAt ?? -Infinity);', 'since = quietSince;'],
  ['quiet-short', S, 'const due = Math.max(since + bounds.quietMs, prev?.notBefore ?? -Infinity);', 'const due = Math.max(since + bounds.quietMs - 60_000, prev?.notBefore ?? -Infinity);'],
  ['quiet-long', S, 'const due = Math.max(since + bounds.quietMs, prev?.notBefore ?? -Infinity);', 'const due = Math.max(since + bounds.quietMs + 60_000, prev?.notBefore ?? -Infinity);'],
  ['blk-no-protected-mark', S, 'if (block) return { state: { protectedAt: now, blockedAt: now },', 'if (block) return { state: { blockedAt: now },'],
  // ── processes
  ['proc-ignored', S, '  if (procs.length > 0) {\n', '  if (false) {\n'],
  ['proc-protects-forever', S, 'if (now < lapse) return', 'if (true) return'],
  ['proc-lapse-from-zero', S, 'const lapse = quietSince + bounds.processMs;', 'const lapse = quietSince;'],
  ['proc-unknown-as-none', S, "if (got === 'unknown') out.push({ owner: p.label, kind: 'unknown', cmd: null, pid: null });", "if (got === 'unknown') continue;"],
  ['proc-children-named', S, 'for (const r of rootsOf(got))', 'for (const r of got)'],
  ['proc-coordinator-ignored', S, 'for (const p of people(f)) {\n    const got', 'for (const p of f.members) {\n    const got'],
  ['proc-lapse-ignores-blocked', S, '    const floor = Math.max((prev?.blockedAt ?? -Infinity) + bounds.quietMs, prev?.notBefore ?? -Infinity);\n', '    const floor = prev?.notBefore ?? -Infinity;\n'],
  ['proc-protection-marks-blocked', S, "return { state: { ...prev, protectedAt: now, quietHint: quietSince }, verdict: { kind: 'awake', why: 'process', dueAt: lapse } };", "return { state: { ...prev, protectedAt: now, blockedAt: now, quietHint: quietSince }, verdict: { kind: 'awake', why: 'process', dueAt: lapse } };"],
  ['proc-since-is-quiet', S, '    since = Math.max(lapse, prev?.blockedAt ?? -Infinity);', '    since = quietSince;'],
  // ── the episode
  ['ep-redeclares', S, 'declared: false, nudge, unfinished', 'declared: true, nudge, unfinished'],
  ['ep-always-owed', S, "  if (ep.nudgedAt !== undefined) return 'done'; // a Relance that WAS sent stays reported as sent, whatever happens to the coordinator\'s parent afterwards\n", ''],
  ['ep-never-ends', S, '    if (!end) {\n', '    if (true) {\n'],
  ['ep-coordinator-resumes', S, "if (f.members.some((m) => m.active || m.waiting || m.heldStart || (m.lastTurnStartAt ?? -Infinity) > ep.declaredAt)) return 'resumed';", "if ([f.coordinator, ...f.members].some((m) => m.active || m.waiting || m.heldStart || (m.lastTurnStartAt ?? -Infinity) > ep.declaredAt)) return 'resumed';"],
  ['ep-resume-needs-active', S, 'm.active || m.waiting || m.heldStart || (m.lastTurnStartAt ?? -Infinity) > ep.declaredAt)) return', 'm.active)) return'],
  ['ep-resume-ignores-turn-start', S, 'm.active || m.waiting || m.heldStart || (m.lastTurnStartAt ?? -Infinity) > ep.declaredAt)) return', 'm.active || m.waiting || m.heldStart)) return'],
  ['ep-click-ends', S, '(m.lastTurnStartAt ?? -Infinity) > ep.declaredAt)) return', 'm.lastActivityAt > ep.declaredAt)) return'],
  ['ep-any-turn-start-ends', S, '(m.lastTurnStartAt ?? -Infinity) > ep.declaredAt)) return', '(m.lastTurnStartAt ?? -Infinity) > -Infinity)) return'],
  ['bg-task-ignored', S, '    if (p.backgroundTask) out.push(', '    if (false) out.push('],
  ['human-coordinator-nudged', S, "  if (!f.coordinatorHasParent) return 'no-parent';\n", ''],
  ['unwakeable-coordinator-owed', S, "return f.coordinatorWakeable ? 'owed' : 'not-wakeable';", "return 'owed';"],
  ['sent-reported-no-parent', S, "  if (ep.nudgedAt !== undefined) return 'done'; // a Relance that WAS sent stays reported as sent, whatever happens to the coordinator\'s parent afterwards\n  if (!f.coordinatorHasParent) return 'no-parent';", "  if (!f.coordinatorHasParent) return 'no-parent';\n  if (ep.nudgedAt !== undefined) return 'done';"],
  ['txt-background-not-named', S, "p.kind === 'background-task' ? `a background task of ${oneLine(p.owner)}, tracked by its session` :", ''],
  ['txt-claims-nothing-alive', S, "'no live process, no background task, no Pause'", "'no live process, no Pause'"],
  ['ep-no-task-ignored', S, "function episodeEnd(f: VagueFacts, ep: VagueEpisode): VagueAwakeWhy | null {\n  if (!f.members.some((m) => m.unfinished)) return 'no-task';\n", 'function episodeEnd(f: VagueFacts, ep: VagueEpisode): VagueAwakeWhy | null {\n'],
  ['ep-paused-ignored', S, `${BLOCK}  if (f.members.some((m) => m.active`, "  if (f.runHeld) return 'run-held';\n  if (f.members.some((m) => m.active"],
  ['ep-held-ignored', S, "  if (f.runHeld) return 'run-held';\n  if (f.members.some((m) => m.active", '  if (f.members.some((m) => m.active'],
  ['ep-protected-not-marked', S, "return { state: { protectedAt: now, blockedAt: now }, verdict: { kind: 'awake', why: end } };", "return { state: {}, verdict: { kind: 'awake', why: end } };"],
  // ── the text
  ['txt-no-since', S, 'has been asleep since ${clock(since)} UTC', 'has been asleep'],
  ['txt-no-task', S, '${oneLine(m.label)} — ${task(m.task)} — last activity', '${oneLine(m.label)} — last activity'],
  ['txt-no-last-activity', S, '${task(m.task)} — last activity ${clock(m.lastActivityAt)} UTC`', '${task(m.task)}`'],
  ['txt-no-processes', S, "'Processes still alive:'", "'Done.'"],
  ['txt-not-a-relance', S, 'return buildRelance(`your vague is asleep:', 'return (`your vague is asleep:'],
  ['txt-no-strip', S, "const task = (t: string): string => { const s = oneLine(t);", 'const task = (t: string): string => { const s = t;'],
  // ── the sweep
  ['sweep-redelivers', M, "if (verdict.nudge !== 'owed' ||", "if (verdict.nudge === 'no-parent' || verdict.nudge === 'not-wakeable' ||"],
  ['sweep-lose-on-failure', M, "if (cur?.episode) states.set(f.runId, { ...cur, episode: { ...cur.episode, nudgedAt: undefined } });", ''],
  ['sweep-no-fresh', M, 'const fresh = deps.vague?.(f.runId) ?? f;', 'const fresh = f;'],
  ['sweep-coordinator-busy-ignored', M, 'if (fresh.coordinator.active || fresh.coordinator.waiting || fresh.paused || fresh.runHeld || !fresh.coordinatorWakeable', 'if (!fresh.coordinatorWakeable'],
  ['sweep-hung-blocks', M, "const first = await Promise.race([delivery, new Promise<'slow'>((r) => { timer = setTimeout(() => r('slow'), waitMs); })]);", 'const first = await delivery;'],
  ['sweep-hung-repeats', M, 'if (slow.has(f.runId)) continue; // its delivery has not landed yet', ''],
  ['sweep-view-kept', M, '            counters.ended++;\n            views.delete(f.runId);\n', '            counters.ended++;\n'],
  ['sweep-bounds-ignored', M, 'const bounds: VagueBounds = { ...DEFAULT_VAGUE_BOUNDS, ...(deps.bounds?.() ?? {}) };', 'const bounds: VagueBounds = { ...DEFAULT_VAGUE_BOUNDS };'],
  ['sweep-census-throw-none', M, "m.set(p.wsId, 'unknown');", 'm.set(p.wsId, []);'],
  ['sweep-now-swallowed', M, 'while (sweeping) await (current ?? Promise.resolve([]))', 'if (sweeping) return [];\n  while (false) await (current ?? Promise.resolve([]))'],
  ['sweep-no-prune', M, 'if (live.has(id)) continue;', 'continue;'],
  ['sweep-since-lost', M, 'since: verdict.since,\n          declaredAt', 'since: now,\n          declaredAt'],
  ['sweep-view-without-unfinished', M, 'unfinished: verdict.unfinished.map((m) => ({ wsId: m.wsId, label: m.label })),', 'unfinished: [],'],
  // ── the roster
  ['roster-archived-member', R, '    if (ws.archived) continue;\n    const rid', '    const rid'],
  ['roster-archived-coordinator', R, 'if (!coordinator || coordinator.archived) continue;', 'if (!coordinator) continue;'],
  ['roster-released-empty', R, 'released: taskKeys.length === 0 ? new Set() : d.released(taskKeys),', 'released: new Set(),'],
  ['roster-waiting-bus-dropped', R, 'waiting: everyone.length === 0 ? new Set() : d.busWaiting(everyone),', 'waiting: new Set(),'],
  ['roster-held-runs-dropped', R, 'held: d.heldRuns(),', 'held: new Set<string>(),'],
  ['roster-paused-first-member-only', R, 'paused: [g.coordinator, ...g.members].some((w) => d.paused(w)),', 'paused: d.paused(g.members[0]),'],
  ['roster-queued-prompt-not-active', R, '(ws.sdkPendingPrompts?.length ?? 0) > 0,', 'false,'],
  ['roster-status-waiting-dropped', R, "waiting: ws.status === 'waiting' || waiting.has(ws.id),", 'waiting: waiting.has(ws.id),'],
  ['roster-release-ignored', R, 'unfinished: !!ws.lastTask && !released.has(ws.id),', 'unfinished: !!ws.lastTask,'],
  ['roster-untasked-unfinished', R, 'unfinished: !!ws.lastTask && !released.has(ws.id),', 'unfinished: !released.has(ws.id),'],
  ['roster-held-start-dropped', R, 'heldStart: d.heldStart(ws),', 'heldStart: false,'],
  ['roster-seen-this-run-dropped', R, 'seenThisRun: d.seenThisRun(ws),', 'seenThisRun: true,'],
  ['roster-parent-any', R, 'coordinatorHasParent: !!g.coordinator.parentId && !!d.getWorkspace(g.coordinator.parentId) && !d.getWorkspace(g.coordinator.parentId)?.archived,', 'coordinatorHasParent: !!g.coordinator.parentId,'],
  ['roster-parent-archived-ok', R, ' && !d.getWorkspace(g.coordinator.parentId)?.archived,', ','],
  ['roster-parent-always', R, 'coordinatorHasParent: !!g.coordinator.parentId && !!d.getWorkspace(g.coordinator.parentId) && !d.getWorkspace(g.coordinator.parentId)?.archived,', 'coordinatorHasParent: true,'],
  ['roster-wakeable-dropped', R, 'coordinatorWakeable: d.wakeable(g.coordinator),', 'coordinatorWakeable: true,'],
  ['roster-bg-dropped', R, 'backgroundTask: d.backgroundTask(ws),', 'backgroundTask: false,'],
  ['roster-turn-start-dropped', R, '    lastTurnStartAt: ws.lastTurnStartAt,\n', ''],
  ['roster-no-task-vague', R, 'for (const [rid, g] of out) if (!g.members.some((m) => !!m.lastTask)) out.delete(rid);', ''],
  ['roster-own-run-member', R, 'if (rid === ws.id) continue;', ''],
  // the verdict and the fresh re-read both guard a human-facing / unwakeable coordinator: each mutant removes BOTH
  ['sweep-human-delivered', M, ["if (verdict.nudge !== 'owed' ||", "if (verdict.nudge === 'not-wakeable' ||"], [' || !fresh.coordinatorHasParent) continue;', ') continue;']],
  ['sweep-unwakeable-delivered', M, ["if (verdict.nudge !== 'owed' ||", "if (verdict.nudge === 'no-parent' ||"], [' || !fresh.coordinatorWakeable || !fresh.coordinatorHasParent) continue;', ' || !fresh.coordinatorHasParent) continue;']],
  ['sweep-view-relance-sent', M, "state.episode?.nudgedAt !== undefined ? 'sent' : 'owed',", "'sent',"],
  ['persist-save-noop', M, '  if (!deps.persist) return;\n  const snap = snapshot();', '  return;\n  const snap = snapshot();'],
  ['persist-load-skipped', M, '  if (!deps.persist) return;\n  try {\n    const got', '  return;\n  try {\n    const got'],
  ['persist-before-delivery-dropped', M, '        save(deps); // at most once across a crash: what was marked is not sent again\n', ''],
  ['persist-trusts-garbage', M, "const okEp = ep && typeof ep.since === 'number' && typeof ep.declaredAt === 'number' && (ep.nudgedAt === undefined || typeof ep.nudgedAt === 'number');", 'const okEp = !!ep;'],
  ['persist-drops-nudge', M, '...(ep.nudgedAt !== undefined ? { nudgedAt: ep.nudgedAt } : {}) } } : {}) });', '} } : {}) });'],
  ['persist-only-ever-seen', M, '...(st.episode ? { episode: st.episode } : {}) };', '};'],
  ['persist-corrupt-crashes', M, "log.warn('vague-endormie: persisted state unreadable — starting from nothing', e);", 'throw e;'],
  ['store-no-atomic-rename', F, '      fs.renameSync(tmp, f);', '      fs.copyFileSync(tmp, f);'],
  ['store-enoent-throws', F, "if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};", 'if (false) return {};'],
  ['store-accepts-array', F, "|| Array.isArray(parsed)) throw", ") throw"],
  ['sweep-no-backoff', M, '            retryAt.set(f.runId, deps.now() + wait);\n', ''],
  ['sweep-backoff-linear', M, 'const wait = Math.min(RELANCE_RETRY_MS * 2 ** Math.min(n - 1, 10), VAGUE_MAX_BACKOFF_MS);', 'const wait = Math.min(RELANCE_RETRY_MS * n * n * n, 24 * 3_600_000);'],
  ['sweep-backoff-uncapped', M, 'const wait = Math.min(RELANCE_RETRY_MS * 2 ** Math.min(n - 1, 10), VAGUE_MAX_BACKOFF_MS);', 'const wait = RELANCE_RETRY_MS * 2 ** Math.min(n - 1, 10);'],
  ['sweep-backoff-flat', M, 'const wait = Math.min(RELANCE_RETRY_MS * 2 ** Math.min(n - 1, 10), VAGUE_MAX_BACKOFF_MS);', 'const wait = RELANCE_RETRY_MS;'],
  ['sweep-unwakeable-no-rearm', M, '          attempts.delete(f.runId);\n          retryAt.delete(f.runId);\n        }\n        if (verdict.nudge !== \'owed\'', '        }\n        if (verdict.nudge !== \'owed\''],
  ['sweep-untrusted-ignored', M, 'if (deps.rosterTrusted && !deps.rosterTrusted()) {', 'if (false) {'],
  ['hint-ignored', S, 'p.seenThisRun || hint === undefined ? p.lastActivityAt : hint', 'p.lastActivityAt'],
  ['hint-not-persisted', M, '...(st.quietHint !== undefined && !st.episode ? { quietHint: st.quietHint } : {}), ', ''],
  ['hint-not-loaded', M, '...(hint !== undefined ? { quietHint: hint, notBefore: now + quietMs } : {}), ', ''],
  ['hint-no-grace', M, '{ quietHint: hint, notBefore: now + quietMs }', '{ quietHint: hint }'],
  ['grace-ignored-quiet', S, 'const due = Math.max(since + bounds.quietMs, prev?.notBefore ?? -Infinity);', 'const due = since + bounds.quietMs;'],
  ['grace-ignored-lapse', S, 'const floor = Math.max((prev?.blockedAt ?? -Infinity) + bounds.quietMs, prev?.notBefore ?? -Infinity);', 'const floor = (prev?.blockedAt ?? -Infinity) + bounds.quietMs;'],
  ['hint-not-recorded', S, "return { state: { ...prev, quietHint: quietSince }, verdict: { kind: 'awake', why: 'quiet', dueAt: due } };", "return { state: { ...prev }, verdict: { kind: 'awake', why: 'quiet', dueAt: due } };"],
  // ── the host
  ['host-kill-switch-bypassed', H, 'if (!relanceEnabled(process.env)) {', 'if (false) {'],
  ['host-trusted-dropped', H, '  rosterTrusted: () => store.loadedFromDisk,\n', ''],
  ['host-persist-dropped', H, "  persist: createVagueFileStore(() => path.join(orchestraHome(), 'vague-endormie.json')),\n", ''],
  ['host-bg-dropped', H, '  backgroundTask: (ws) => sdkHasBackgroundTasks(ws.id),', '  backgroundTask: () => false,'],
  ['host-wakeable-dropped', H, '  wakeable: (ws) => wakeRosterEntry(ws).wakeable,', '  wakeable: () => true,'],
  ['host-no-fresh-vague', H, '  vague: (runId) => vagueFactsOf(roster, runId),\n', ''],
  ['host-shared-admission-site', H, "'relance-vague'", "'relance'"],
];

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const files = [...new Set(MUTANTS.map((m) => m[1]))];
const backup = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(repo, f))]));
const run = () => spawnSync('node', ['--test', '--experimental-strip-types', ...SUITES], { cwd: repo, encoding: 'utf8' });
const counts = (r) => ({ pass: Number(/# pass (\d+)/.exec(r.stdout)?.[1] ?? -1), fail: Number(/# fail (\d+)/.exec(r.stdout)?.[1] ?? -1), skipped: Number(/# skipped (\d+)/.exec(r.stdout)?.[1] ?? -1) });
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

let bad = 0;
try {
  const base = run();
  const bc = counts(base);
  const baseOk = base.status === 0 && bc.fail === 0 && bc.skipped === 0 && bc.pass > 0;
  console.log(`unmutated: ${baseOk ? 'GREEN' : 'NOT GREEN'} (pass ${bc.pass}, fail ${bc.fail}, skipped ${bc.skipped})`);
  if (!baseOk) { bad++; } else {
    for (const [id, file, from, to] of MUTANTS) {
      if (only && id !== only) continue;
      const abs = path.join(repo, file);
      const src = backup[file].toString('utf8');
      const edits = Array.isArray(from) ? [from, to] : [[from, to]];
      let mutated = src;
      let gone = false;
      for (const [a, b] of edits) {
        const n = mutated.split(a).length - 1;
        if (n !== 1) { bad++; gone = true; console.log(`${id}: PATTERN-GONE (${n} matches in ${file})`); break; }
        mutated = mutated.replace(a, () => b);
      }
      if (gone) continue;
      fs.writeFileSync(abs, mutated);
      const r = run();
      fs.writeFileSync(abs, backup[file]);
      const c = counts(r);
      const killed = r.status !== 0; // a red test OR a cancelled one (a mutant that hangs the sweep cancels the suite)
      if (!killed) bad++;
      console.log(`${id}: ${killed ? 'KILLED' : 'SURVIVED'} (fail ${c.fail}, rc ${r.status})`);
    }
  }
} finally {
  for (const f of files) fs.writeFileSync(path.join(repo, f), backup[f]);
  for (const f of files) if (sha(fs.readFileSync(path.join(repo, f))) !== sha(backup[f])) { bad++; console.log(`RESTORE FAILED: ${f}`); }
}
console.log(bad ? `vague-mutants: DIRTY (${bad})` : `vague-mutants: CLEAN (${MUTANTS.length} mutants, all killed)`);
process.exit(bad ? 1 : 0);
