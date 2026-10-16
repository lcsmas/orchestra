// Session-identity rig driver (#379 / ADR 0008) — see README.md.
//   node scripts/session-identity/run.mjs [--arm same_turn|superseded|app_closed|attach_keeps_key|restart_window|all] [--repo <tree>]
//                                         [--proof | --mutant <name>] [--keep] [--verbose] [--selftest]
// Per arm: clause lines `  PASS|FAIL <id>` then `SESSION-IDENTITY <arm>: PASS|FAIL`; last line `SESSION-IDENTITY: PASS|FAIL`.
// `--proof` adds the must-FAIL mutant runs (mutants.mjs): each must red EXACTLY its named clauses.
// Exit 0 only when every requested arm/mutant and the hygiene checks pass; 3 when the host cannot contain the run (VOID).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { detectContainment, findOnPath } from '../session-budget/harness.mjs';
import { liveDirs } from '../session-budget/scratch-guard.mjs';
import { ensureBuilt, busAbiProbe, runIdentityArm } from './harness.mjs';
import { ARMS, judge, terminator } from './judge.mjs';
import { EXPECT } from './mutants.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const HERE = path.dirname(new URL(import.meta.url).pathname);

if (flag('--selftest')) {
  const { runSelftest } = await import('./selftest.mjs');
  process.exit(runSelftest() ? 0 : 1);
}

const repo = path.resolve(opt('--repo') ?? path.join(HERE, '..', '..'));
const armArg = opt('--arm');
const oneMutant = opt('--mutant');
if (oneMutant && !EXPECT[oneMutant]) { console.error(`unknown mutant ${oneMutant} (expected: ${Object.keys(EXPECT).join(', ')})`); process.exit(2); }
// `--mutant` alone runs only that mutant; otherwise the requested arms (default all), then `--proof` adds every mutant.
const arms = oneMutant && !armArg ? [] : armArg && armArg !== 'all' ? [armArg] : ARMS;
for (const a of arms) if (!ARMS.includes(a)) { console.error(`unknown arm ${a} (expected: ${ARMS.join(', ')}, all)`); process.exit(2); }
const mutants = oneMutant ? [oneMutant] : flag('--proof') ? Object.keys(EXPECT) : [];

const containment = detectContainment();
if (containment.name !== 'netns+pidns') {
  console.log(`SESSION-IDENTITY: VOID — containment is '${containment.name}', not 'netns+pidns' (bwrap --unshare-net --unshare-pid is unusable on this host); the rig refuses to run uncontained`);
  process.exit(3);
}
if (!findOnPath('claude')) { console.log('SESSION-IDENTITY: VOID — no `claude` CLI on PATH (the rig drives the real CLI)'); process.exit(3); }
ensureBuilt(repo);
const probe = busAbiProbe(repo);
if (!probe.ok) { console.log(`SESSION-IDENTITY: VOID — the bus cannot open under system node in ${repo}: ${probe.detail} (build/bus-abi/better_sqlite3-abi127.node missing? see scripts/build-bus-abi.mjs)`); process.exit(3); }

// ── the live Claude / Orchestra dirs must come out exactly as they went in (names at depth <= 1), and carry no trace of this run ──
const live = liveDirs(process.env).filter((d) => fs.existsSync(d));
const listing = () => {
  const out = [];
  const homeDir = os.homedir();
  for (const t of fs.readdirSync(homeDir).filter((n) => n.startsWith('.claude') || n.startsWith('.orchestra'))) {
    out.push(t);
    try { for (const c of fs.readdirSync(path.join(homeDir, t))) out.push(`${t}/${c}`); } catch { /* a file, or unreadable */ }
  }
  return out.sort();
};
const before = listing();

let bad = 0;
const tokens = [];
const t0 = Date.now();

/** Run one arm (optionally under a mutant): measure, judge, return `{clauses, res}`. */
async function runOne(arm, mutant) {
  const res = await runIdentityArm({ repo, arm, mutant, keep: flag('--keep') });
  if (res.root) tokens.push(path.basename(res.root).replace(/_/g, '-'));
  if (res.void) { console.log(`SESSION-IDENTITY ${arm}: VOID — ${res.error}`); process.exit(3); }
  if (res.error || !res.facts) {
    return { res, broke: true, clauses: [{ id: 'z_run_completed', ok: false, why: `the run broke: ${res.error ?? 'no facts'}${res.root ? ` (scratch kept at ${res.root})` : ''}` }] };
  }
  res.facts.hostSurvivors = res.hostSurvivors;
  if (flag('--verbose')) console.log(`  facts ${JSON.stringify(res.facts).slice(0, 4000)}`);
  return { res, broke: false, clauses: judge(arm, res.facts) };
}

for (const arm of arms) {
  const { clauses } = await runOne(arm, null);
  console.log(`── ${arm}`);
  for (const c of clauses) console.log(`  ${c.ok ? 'PASS' : 'FAIL'} ${c.id}${c.ok ? '' : ` — ${c.why}`}`);
  const line = terminator(arm, clauses);
  console.log(line);
  if (!line.endsWith('PASS')) bad++;
}

for (const name of mutants) {
  const { arm, red } = EXPECT[name];
  const { clauses, broke } = await runOne(arm, name);
  const failed = clauses.filter((c) => !c.ok).map((c) => c.id);
  const exact = !broke && JSON.stringify([...failed].sort()) === JSON.stringify([...red].sort());
  if (!exact) bad++;
  console.log(`MUTANT ${name} (${arm}): ${broke ? 'BROKEN' : failed.length ? `FAIL [${failed.join(', ')}]` : 'PASS'} (${exact ? 'expected' : `UNEXPECTED — wanted FAIL [${red.join(', ')}]`})`);
  if (!exact) for (const c of clauses.filter((x) => !x.ok)) console.log(`  FAIL ${c.id} — ${c.why}`);
}

const after = listing();
const added = after.filter((n) => !before.includes(n));
const removed = before.filter((n) => !after.includes(n));
const find = tokens.length
  ? spawnSync('find', [...live, '-maxdepth', '4', '(', ...tokens.flatMap((t, i) => [...(i ? ['-o'] : []), '-name', `*${t}*`]), ')'], { encoding: 'utf8' })
  : { stdout: '' };
const traces = (find.stdout ?? '').split('\n').filter(Boolean);
// A depth-1 listing of a dir shared with CONCURRENT live sessions is noisy (they add/remove their own telemetry): only an entry that carries this rig's own marks fails;
// any other diff is reported as a NOTE (home_no_trace_of_this_run + the scratch guard + bwrap are the attributable checks).
const RIG_MARKS = /session-keys\.json|keepers|bus\.sqlite|store\.json|orchestra-[0-9a-f]{12}\.sock|ws-(si|sup|att)-/;
const rigAdded = added.filter((n) => RIG_MARKS.test(n) || tokens.some((t) => n.includes(t)));
const homeOk = rigAdded.length === 0;
const traceOk = traces.length === 0;
console.log(`── hygiene\n  ${homeOk ? 'PASS' : 'FAIL'} home_listing_unchanged — ~/.claude* and ~/.orchestra* (depth <= 1, ${before.length} names)${!homeOk ? `: the rig left ${JSON.stringify(rigAdded)}` : added.length || removed.length ? ` — NOTE unrelated to the rig (a concurrent live session): +${JSON.stringify(added)} -${JSON.stringify(removed)}` : ''}`);
console.log(`  ${traceOk ? 'PASS' : 'FAIL'} home_no_trace_of_this_run — no entry named after this run's scratch root under the live dirs (depth <= 4)${traceOk ? '' : `: ${traces.join(', ')}`}`);
if (!homeOk || !traceOk) bad++;
console.log(`SESSION-IDENTITY: ${bad === 0 ? 'PASS' : 'FAIL'} (${arms.length} arm${arms.length === 1 ? '' : 's'}${mutants.length ? ` + ${mutants.length} mutant${mutants.length === 1 ? '' : 's'}` : ''}, ${((Date.now() - t0) / 1000).toFixed(0)} s, tree ${repo})`);
process.exit(bad === 0 ? 0 : 1);
