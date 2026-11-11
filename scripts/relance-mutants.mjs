// In-place one-clause mutants of the Relance (#427): each must turn the unit suites RED; the unmutated tree must be GREEN first (positive control) and every file is restored byte-exact (sha check).
//   node scripts/relance-mutants.mjs [--only <id>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SUITES = ['src/shared/relance.test.ts', 'src/main/relance.test.ts', 'src/main/relance-census.test.ts', 'src/main/relance-wiring.test.ts'];
const S = 'src/shared/relance.ts';
const M = 'src/main/relance.ts';
const C = 'src/main/relance-census.ts';
const K = 'src/main/pause-reliquats.ts';
const B = 'src/main/browser-reliquats.ts';
const MUTANTS = [
  ['obs-ignore-unknown', S, "if (census === 'unknown') return prev ?? { roots: new Map(), seen: new Map(), pending: [] };", "if (census === 'unknown') return { roots: new Map(), seen: new Map(), pending: [] };"],
  ['obs-children-count', S, 'const roots = new Map(rootsOf(census)', 'const roots = new Map(census'],
  ['obs-host-stop-ignored', S, 'if (alive.has(k) || stoppedByHost(k)) continue;', 'if (alive.has(k)) continue;'],
  ['obs-no-min-age', S, 'if (now - (prev?.seen.get(k) ?? now) < RELANCE_MIN_AGE_MS) continue;', ''],
  ['obs-reused-pid', S, "const procKey = (p: Pick<RelanceProc, 'pid' | 'startTicks'>): string => `${p.pid}:${p.startTicks}`;", "const procKey = (p: Pick<RelanceProc, 'pid' | 'startTicks'>): string => `${p.pid}`;"],
  ['dec-no-coordinator', S, "if (!m.hasCoordinator) return { kind: 'drop', why: 'no-coordinator', keep: [] };", ''],
  ['dec-no-task', S, "if (!m.hasTask) return { kind: 'drop', why: 'no-task', keep: [] };", ''],
  ['dec-released', S, "if (m.released) return { kind: 'drop', why: 'released', keep: [] };", ''],
  ['dec-paused', S, "if (m.paused) return { kind: 'drop', why: 'paused', keep: [] };", ''],
  ['dec-not-wakeable', S, "if (!m.wakeable) return { kind: 'drop', why: 'not-wakeable', keep: [] };", ''],
  ['dec-active', S, "if (m.active) return { kind: 'wait', why: 'active', keep: track.pending };", ''],
  ['dec-active-drops', S, "if (m.active) return { kind: 'wait', why: 'active', keep: track.pending };", "if (m.active) return { kind: 'drop', why: 'nothing-ended', keep: [] };"],
  ['dec-pending-unbounded', S, '.slice(-MAX_PENDING_ENDS) };', ' };'],
  ['dec-no-grouping', S, 'if (now - track.pending[0].at < RELANCE_GROUP_MS)', 'if (false)'],
  ['dec-group-from-last', S, 'if (now - track.pending[0].at < RELANCE_GROUP_MS)', 'if (now - track.pending[track.pending.length - 1].at < RELANCE_GROUP_MS - 20_000)'],
  ['dec-running-dropped', S, "return { kind: 'fire', ended: track.pending, running: [...track.roots.values()] };", "return { kind: 'fire', ended: track.pending, running: [] };"],
  ['txt-no-strip', S, "const t = s.replace(/[\\u0000-\\u001f\\u007f-\\u009f]/g, ' ').replace(/\\s+/g, ' ').trim();", 'const t = s;'],
  ['sweep-mark-after', M, "tracks.set(m.wsId, { ...track, pending: [] });\n        const delivery", "const delivery"],
  ['sweep-lose-on-failure', M, "tracks.set(m.wsId, { ...(cur ?? track), pending: [...v.ended, ...(cur?.pending ?? [])] });", ""],
  ['sweep-hung-blocks', M, "const first = await Promise.race([delivery, new Promise<'slow'>((r) => { timer = setTimeout(() => r('slow'), waitMs); })]);", "const first = await delivery;"],
  ['sweep-hung-repeats', M, "if (slow.has(m.wsId)) continue; // its delivery has not landed yet", ""],
  ['sweep-now-swallowed', M, "while (sweeping) await (current ?? Promise.resolve([]))", "if (sweeping) return [];\n  while (false) await (current ?? Promise.resolve([]))"],
  ['sweep-no-backoff', M, "retryAt.set(m.wsId, deps.now() + RELANCE_RETRY_MS);", ''],
  ['sweep-host-stop-ignored', M, '(k) => wasStoppedByHost(k, now)', '() => false'],
  ['sweep-keeps-stale-roster', M, 'if (ids.has(id)) continue;\n      tracks.delete(id);', 'continue;\n      tracks.delete(id);'],
  ['census-refused-as-gone', C, "return 'unknown'; // cannot prove what it is: its vanishing must not read as an end", "continue;"],
  ['census-keeper-unpublished', C, "if (f !== 'gone' && f !== 'unreadable' && isOwnKeeperProc(f, wsId)) return 'unknown';", ''],
  ['census-unreadable-as-empty', C, "if (listing === 'unreadable') return 'unknown';", "if (listing === 'unreadable') continue;"],
  ['browser-unregistered', B, 'noteHostStopped(order.filter((m) => m.startTicks !== null).map((m) => ({ pid: m.pid, startTicks: m.startTicks as number })));\n', ''],
  ['kill-unregistered', K, '    noteHostStopped(plan.targets);\n', ''],
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
console.log(bad ? `relance-mutants: DIRTY (${bad})` : `relance-mutants: CLEAN (${MUTANTS.length} mutants, all killed)`);
process.exit(bad ? 1 : 0);
