// In-place one-clause mutants of the Vague endormie (#428): each must turn the unit suites RED; the unmutated tree must be GREEN first (positive control) and every file is restored byte-exact (sha check).
//   node scripts/vague-mutants.mjs [--only <id>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SUITES = ['src/shared/vague-endormie.test.ts', 'src/main/vague-endormie.test.ts', 'src/main/vague-roster.test.ts', 'src/main/vague-endormie-wiring.test.ts'];
const S = 'src/shared/vague-endormie.ts';
const M = 'src/main/vague-endormie.ts';
const R = 'src/main/vague-roster.ts';
const H = 'src/main/vague-endormie-host.ts';
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
  ['blk-dormant', S, "  if (!people(f).some((p) => p.seenThisRun)) return 'dormant';\n", ''],
  ['blk-dormant-coordinator-only', S, "if (!people(f).some((p) => p.seenThisRun)) return 'dormant';", "if (!f.coordinator.seenThisRun) return 'dormant';"],
  ['blk-dormant-all-must-be-seen', S, "if (!people(f).some((p) => p.seenThisRun)) return 'dormant';", "if (!people(f).every((p) => p.seenThisRun)) return 'dormant';"],
  // ── quiet clock + delay
  ['quiet-ignores-active', S, 'p.active || p.waiting || p.heldStart ? now : p.lastActivityAt', 'p.lastActivityAt'],
  ['quiet-members-only', S, 'const quietSince = quietSinceOf(f, now);', 'const quietSince = Math.max(...f.members.map((m) => m.lastActivityAt));'],
  ['quiet-no-floor', S, 'since = Math.max(quietSince, prev?.protectedAt ?? -Infinity);', 'since = quietSince;'],
  ['quiet-short', S, 'if (now < since + bounds.quietMs)', 'if (now < since + bounds.quietMs - 60_000)'],
  ['quiet-long', S, 'if (now < since + bounds.quietMs)', 'if (now < since + bounds.quietMs + 60_000)'],
  ['blk-no-protected-mark', S, 'if (block) return { state: { protectedAt: now },', 'if (block) return { state: {},'],
  // ── processes
  ['proc-ignored', S, '  if (procs.length > 0) {\n', '  if (false) {\n'],
  ['proc-protects-forever', S, 'if (now < lapse) return', 'if (true) return'],
  ['proc-lapse-from-zero', S, 'const lapse = quietSince + bounds.processMs;', 'const lapse = quietSince;'],
  ['proc-unknown-as-none', S, "if (got === 'unknown') out.push({ owner: p.label, cmd: null, pid: null });", "if (got === 'unknown') continue;"],
  ['proc-children-named', S, 'for (const r of rootsOf(got))', 'for (const r of got)'],
  ['proc-coordinator-ignored', S, 'for (const p of people(f)) {\n    const got', 'for (const p of f.members) {\n    const got'],
  ['proc-lapse-ignores-blocked', S, '    const floor = (prev?.blockedAt ?? -Infinity) + bounds.quietMs;\n', '    const floor = -Infinity;\n'],
  ['proc-protection-marks-blocked', S, "return { state: { ...prev, protectedAt: now }, verdict: { kind: 'awake', why: 'process', dueAt: lapse } };", "return { state: { ...prev, protectedAt: now, blockedAt: now }, verdict: { kind: 'awake', why: 'process', dueAt: lapse } };"],
  ['proc-since-is-quiet', S, '    since = lapse;', '    since = quietSince;'],
  // ── the episode
  ['ep-redeclares', S, "declared: false, nudge: owed ? 'owed' : 'done'", "declared: true, nudge: owed ? 'owed' : 'done'"],
  ['ep-always-owed', S, 'const owed = ep.nudgedAt === undefined;', 'const owed = true;'],
  ['ep-never-ends', S, '    if (!end) {\n', '    if (true) {\n'],
  ['ep-coordinator-resumes', S, "if (f.members.some((m) => m.active || m.waiting || m.heldStart || m.lastActivityAt > ep.declaredAt)) return 'resumed';", "if ([f.coordinator, ...f.members].some((m) => m.active || m.waiting || m.heldStart || m.lastActivityAt > ep.declaredAt)) return 'resumed';"],
  ['ep-resume-needs-active', S, 'm.active || m.waiting || m.heldStart || m.lastActivityAt > ep.declaredAt)) return', 'm.active)) return'],
  ['ep-resume-ignores-activity', S, 'm.active || m.waiting || m.heldStart || m.lastActivityAt > ep.declaredAt)) return', 'm.active || m.waiting || m.heldStart)) return'],
  ['ep-no-task-ignored', S, "function episodeEnd(f: VagueFacts, ep: VagueEpisode): VagueAwakeWhy | null {\n  if (!f.members.some((m) => m.unfinished)) return 'no-task';\n", 'function episodeEnd(f: VagueFacts, ep: VagueEpisode): VagueAwakeWhy | null {\n'],
  ['ep-paused-ignored', S, `${BLOCK}  if (f.members.some((m) => m.active`, "  if (f.runHeld) return 'run-held';\n  if (f.members.some((m) => m.active"],
  ['ep-held-ignored', S, "  if (f.runHeld) return 'run-held';\n  if (f.members.some((m) => m.active", '  if (f.members.some((m) => m.active'],
  ['ep-protected-not-marked', S, "return { state: { protectedAt: now }, verdict: { kind: 'awake', why: end } };", "return { state: {}, verdict: { kind: 'awake', why: end } };"],
  // ── the text
  ['txt-no-since', S, 'has been asleep since ${clock(since)} UTC', 'has been asleep'],
  ['txt-no-task', S, '${oneLine(m.label)} — ${task(m.task)} — last activity', '${oneLine(m.label)} — last activity'],
  ['txt-no-last-activity', S, '${task(m.task)} — last activity ${clock(m.lastActivityAt)} UTC`', '${task(m.task)}`'],
  ['txt-no-processes', S, "'Processes still alive:'", "'Done.'"],
  ['txt-not-a-relance', S, 'return buildRelance(`your vague is asleep:', 'return (`your vague is asleep:'],
  ['txt-no-strip', S, "const task = (t: string): string => { const s = oneLine(t);", 'const task = (t: string): string => { const s = t;'],
  // ── the sweep
  ['sweep-redelivers', M, "if (verdict.nudge === 'done' || (retryAt.get(f.runId) ?? 0) > now) continue;", 'if ((retryAt.get(f.runId) ?? 0) > now) continue;'],
  ['sweep-lose-on-failure', M, "if (cur?.episode) states.set(f.runId, { ...cur, episode: { ...cur.episode, nudgedAt: undefined } });", ''],
  ['sweep-no-backoff', M, 'retryAt.set(f.runId, deps.now() + RELANCE_RETRY_MS);', ''],
  ['sweep-no-fresh', M, 'const fresh = deps.vague?.(f.runId) ?? f;', 'const fresh = f;'],
  ['sweep-coordinator-busy-ignored', M, 'if (fresh.coordinator.active || fresh.coordinator.waiting || fresh.paused || fresh.runHeld) continue;', ''],
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
  ['roster-no-task-vague', R, 'for (const [rid, g] of out) if (!g.members.some((m) => !!m.lastTask)) out.delete(rid);', ''],
  ['roster-own-run-member', R, 'if (rid === ws.id) continue;', ''],
  // ── the host
  ['host-kill-switch-bypassed', H, 'if (!relanceEnabled(process.env)) {', 'if (false) {'],
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
      const n = src.split(from).length - 1;
      if (n !== 1) { bad++; console.log(`${id}: PATTERN-GONE (${n} matches in ${file})`); continue; }
      fs.writeFileSync(abs, src.replace(from, () => to));
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
