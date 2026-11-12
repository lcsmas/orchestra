#!/usr/bin/env node
// #436 self-gate — IN-PLACE mutation sweep of "mail between agents with no common ancestry". Each mutant removes ONE guard in the real source and must
// turn its NAMED test file(s) red. Byte-exact backup + `cmp` restore after every mutant; run it on a COMMITTED tree. CONTROL first: every named test file
// must be GREEN unmutated. CLI mutants rebuild dist-electron/cli.js (the tests drive the BUILT bundle); rebuilt again after.
// Run: node scripts/mail-strangers-mutants.mjs [--only M01,M07] [--check-anchors]   (pnpm run test:mail-strangers-mutants)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;

const VERBS = 'src/cli/bus-verbs.ts', CLIX = 'src/cli/index.ts', WAKE = 'src/main/bus-wake.ts';
const T = { asks: 'src/main/bus-asks-gates.test.ts', strangers: 'src/main/mail-between-strangers.test.ts', verbs: 'src/cli/bus-verbs.test.ts' };

/** One mutant = exact-once edits [file, find, replacement]. `tests` must go red; `cli` = rebuild the CLI bundle first. */
const MUTANTS = [
  { id: 'M01', name: 'a cross-run status/ask is filed in the SENDER\'s run (the recipient never sees or wakes)', cli: true, edits: [[VERBS, 'return { ...ctx, id: { ...ctx.id, runId: recipientRun }, generation: null, fencingOn: false };', 'return ctx;']], tests: [T.strangers, T.verbs] },
  { id: 'M02', name: 'a dispatch crosses unrelated runs', cli: true, edits: [[VERBS, "export const CROSS_RUN_KINDS: readonly string[] = ['status', 'question'];", "export const CROSS_RUN_KINDS: readonly string[] = ['status', 'question', 'dispatch'];"]], tests: [T.strangers, T.verbs] },
  { id: 'M03', name: 'a decision gate to an unrelated agent is no longer judged', cli: true, edits: [[VERBS, "if (to.value?.trim()) routeMail(ctx, 'gate open', 'decision_gate', to.value.trim(), toRunId);", '']], tests: [T.strangers, T.verbs] },
  { id: 'M04', name: 'any other kind (escalation) crosses unrelated runs', cli: true, edits: [[VERBS, "export const CROSS_RUN_KINDS: readonly string[] = ['status', 'question'];", "export const CROSS_RUN_KINDS: readonly string[] = ['status', 'question', 'escalation'];"]], tests: [T.strangers, T.verbs] },
  { id: 'M05', name: 'a recipient whose run has no row is no longer refused (a row nobody reads)', cli: true, edits: [[VERBS, 'if (!ctx.bus.getRun(ctx.db, recipientRun)) {', 'if (false as boolean) {']], tests: [T.strangers, T.verbs] },
  { id: 'M06', name: 'a recipient in a RELATED run is treated as unrelated (in-fleet mail changes run, in-fleet dispatch refused)', cli: true, edits: [[VERBS, 'if (ctx.bus.getRelatedRunIds(ctx.db, recipientRun).ids.includes(own)) return ctx;', '']], tests: [T.strangers, T.verbs] },
  { id: 'M07', name: 'an ask is filed in the sender\'s run (verbAsk ignores the route)', cli: true, edits: [[VERBS, "const wctx = routeMail(ctx, 'ask', 'question', to!.trim(), toRunId);", "routeMail(ctx, 'ask', 'question', to!.trim(), toRunId);\n  const wctx = ctx;"]], tests: [T.strangers, T.verbs] },
  { id: 'M08', name: 'a cross-run answer no longer clears the ask (the recipient is re-woken forever)', edits: [[WAKE, "export const ANSWER_RUN_SQL = '(r.run_id = q.run_id OR r.run_id NOT IN (SELECT value FROM json_each(?)))';", "export const ANSWER_RUN_SQL = '(r.run_id = q.run_id AND (SELECT COUNT(*) FROM json_each(?)) >= 0)';"]], tests: [T.strangers] },
  { id: 'M09', name: 'the cross-run answer arm admits EVERY run (an in-fleet answer filed in the wrong related run would clear too)', edits: [[WAKE, "export const ANSWER_RUN_SQL = '(r.run_id = q.run_id OR r.run_id NOT IN (SELECT value FROM json_each(?)))';", "export const ANSWER_RUN_SQL = '(1 = 1 OR (SELECT COUNT(*) FROM json_each(?)) >= 0)';"]], tests: [T.strangers] },
  { id: 'M10', name: 'a cross-run asker is not "waiting" (the asker-side answered arm is gone: liveness / Vague endormie misjudge it)', edits: [[WAKE, "WHERE (q.run_id = ? OR q.run_id NOT IN (SELECT value FROM json_each(?)))", "WHERE (q.run_id = ? AND (SELECT COUNT(*) FROM json_each(?)) >= 0)"]], tests: [T.asks] },
  { id: 'M11', name: 'routeMail judges the overridable --run instead of the sender\'s own run (a stranger claims the recipient\'s run and dispatches)', cli: true, edits: [[VERBS, 'const own = ctx.ownRunId ?? ctx.id.runId;', 'const own = ctx.id.runId;']], tests: [T.strangers] },
  { id: 'M12', name: 'the CLI never hands the sender\'s own run to the verbs', cli: true, edits: [[CLIX, "ownRunId: resolveRunId(undefined, liveEnv()) ?? undefined,", 'ownRunId: undefined,']], tests: [T.strangers] },
];

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f))).digest('hex');
const count = (src, s) => src.split(s).length - 1;
function anchorsOk() {
  let bad = 0, total = 0;
  for (const m of MUTANTS) for (const [f, find] of m.edits) {
    total++;
    const n = count(fs.readFileSync(path.join(REPO, f), 'utf8'), find);
    if (n !== 1) { bad++; console.log(`ANCHOR-BAD ${m.id}: ${f} matches ${n}× (need exactly 1): ${JSON.stringify(find.slice(0, 80))}`); }
  }
  console.log(`ANCHORS: ${total - bad}/${total} resolve exactly once`);
  return bad === 0;
}
if (args.includes('--check-anchors')) process.exit(anchorsOk() ? 0 : 1);
if (!anchorsOk()) process.exit(2);
const touched = [...new Set(MUTANTS.flatMap((m) => m.edits.map(([f]) => f)))];
if (spawnSync('git', ['-C', REPO, 'diff', '--quiet', '--', ...touched]).status !== 0) { console.error('ABORT: a file a mutant edits has uncommitted changes — commit first (the restore proof is `git diff` empty)'); process.exit(2); }

const BACKUP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'mailstr436-mutants-'));
const unit = (files) => spawnSync(process.execPath, ['--test', '--experimental-strip-types', ...files], { cwd: REPO, encoding: 'utf8', timeout: 600000 });
const failedNames = (out) => [...out.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1]);
const buildCli = () => execFileSync('pnpm', ['run', 'build:cli'], { cwd: REPO, stdio: 'ignore', timeout: 300000 });

{
  buildCli();
  const files = [...new Set(MUTANTS.flatMap((m) => m.tests))];
  const u = unit(files); const red = failedNames(u.stdout);
  const skipped = /^# skipped (\d+)/m.exec(u.stdout)?.[1];
  console.log(`CONTROL unmutated unit files (${files.length}): ${u.status === 0 && red.length === 0 && skipped === '0' ? 'GREEN, skipped 0 (instrument can pass)' : `RED ${JSON.stringify(red)} skipped=${skipped} — INSTRUMENT BROKEN`}`);
  if (u.status !== 0 || skipped !== '0') process.exit(4);
}

const results = [];
let cliDirty = false;
for (const m of MUTANTS) {
  if (only && !only.has(m.id)) continue;
  const files = [...new Set(m.edits.map(([f]) => f))];
  const before = Object.fromEntries(files.map((f) => [f, sha(f)]));
  files.forEach((f, i) => fs.copyFileSync(path.join(REPO, f), path.join(BACKUP, `${m.id}-${i}.bak`)));
  let killedBy = [];
  let restored = false;
  try {
    for (const [f, find, to] of m.edits) {
      const p = path.join(REPO, f);
      const src = fs.readFileSync(p, 'utf8');
      if (count(src, find) !== 1) throw new Error(`PATTERN-GONE ${m.id} ${f}`);
      fs.writeFileSync(p, src.replace(find, () => to));
    }
    if (m.cli) { buildCli(); cliDirty = true; }
    const u = unit(m.tests);
    const red = failedNames(u.stdout);
    if (u.status !== 0 || red.length) killedBy.push(`unit: ${red.length ? red.slice(0, 2).join(' | ') : `rc=${u.status}`}`);
  } finally {
    files.forEach((f, i) => fs.copyFileSync(path.join(BACKUP, `${m.id}-${i}.bak`), path.join(REPO, f)));
    restored = files.every((f, i) => sha(f) === before[f] && spawnSync('cmp', ['-s', path.join(BACKUP, `${m.id}-${i}.bak`), path.join(REPO, f)]).status === 0);
  }
  results.push({ id: m.id, name: m.name, killed: killedBy.length > 0, killedBy, restored });
  console.log(`${killedBy.length ? 'KILLED ' : 'SURVIVED'} ${m.id} ${m.name}${killedBy.length ? `\n         ← ${killedBy.join('\n         ← ')}` : ''}${restored ? '' : '\n         !! RESTORE FAILED'}`);
}
if (cliDirty) buildCli();
const survivors = results.filter((r) => !r.killed);
const unrestored = results.filter((r) => !r.restored);
const diff = spawnSync('git', ['-C', REPO, 'diff', '--stat', '--', ...touched], { encoding: 'utf8' }).stdout.trim();
console.log(`\nMUTANTS: ${results.length - survivors.length}/${results.length} killed; survivors: ${survivors.map((s) => s.id).join(', ') || 'none'}; restore: ${unrestored.length ? 'FAILED ' + unrestored.map((s) => s.id).join(',') : 'all byte-exact'}; git diff on touched files: ${diff || 'empty'}`);
process.exit(survivors.length === 0 && unrestored.length === 0 && !diff ? 0 : 1);
