// Per-role handoff bound rig (#478): a COORDINATOR-named workspace (`ops-…`) crosses its built-in bound with NO env set, is nudged once, hands off, and its per-turn context is SMALLER afterwards;
// the fan-out state file (`orchestra fanout state show`, the REAL built CLI) is identical before/after and its refs reach the fresh context. Same fake-API / real-keeper / real-`claude` path as handoff-cache.mjs.
//   node scripts/session-budget/handoff-role.mjs [--turns N]      (N must exceed the coordinator bound + 2; default 36, heavy profile)
// Arms: coord-env0 (env 0 = off, the baseline) · coord-default (env unset ⇒ role default) · coord-file (fleet-roles.json bound 12) · impl-default (env unset, non-coordinator ⇒ must show NO drop)
// + must-FAIL mutants `handoff-role-ignored` (coordinator never nudged), `handoff-role-by-name` (role read from ws.name), `handoff-wipes-state` (the handoff deletes the fan-out state: ONLY stateIdentical may fail) and `handoff-role-all-on` (an implementer nudged).
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runHandoffCacheArm, ensureBuilt } from './harness.mjs';
import { judgeHandoffRole, weighted } from './handoff-cache-judge.mjs';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const argv = process.argv;
const turns = argv.includes('--turns') ? Number(argv[argv.indexOf('--turns') + 1]) || 36 : 36;
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null; // debug: the baseline + the arm whose label starts with this
const HEAVY = { fillerChars: 10000, replyChars: 6000 };

ensureBuilt(repo);
const cliBuild = spawnSync('pnpm', ['run', 'build:cli'], { cwd: repo, encoding: 'utf8' });
if (cliBuild.status !== 0) throw new Error(`build:cli failed: ${(cliBuild.stdout + cliBuild.stderr).slice(-400)}`);

const reports = {};
let bad = 0;
/** wantFail = the judgement keys that MUST be false for this arm (a must-FAIL arm names its clauses). */
async function arm(label, { wsName, envBound = null, roleFile = null, mutant = null, kind, minHandoffs = 1, wantFail = [] }) {
  if (only && label !== 'coord-env0' && !label.startsWith(only)) return null;
  const res = await runHandoffCacheArm({ repo, arm: label, mutant, turns, bound: 0, ...HEAVY, timeoutMs: 900_000, extra: { wsName, envBound, roleFile, withState: true } });
  const r = res.handoffCache;
  if (res.void || res.error || !r || r.error) {
    bad++;
    console.log(`${label}: BROKEN ${res.error ?? r?.error ?? 'no result'}${res.root ? ` (root ${res.root})` : ''}`);
    return null;
  }
  reports[label] = r;
  const v = judgeHandoffRole(kind, r, reports['coord-env0'], minHandoffs);
  const failed = Object.entries(v).filter(([, ok]) => !ok).map(([k]) => k);
  const ok = JSON.stringify([...failed].sort()) === JSON.stringify([...wantFail].sort());
  if (!ok) bad++;
  console.log(`${label}: ${failed.length ? `FAIL [${failed.join(', ')}]` : 'PASS'} (${ok ? 'expected' : `UNEXPECTED — wanted ${wantFail.length ? `FAIL [${wantFail.join(', ')}]` : 'PASS'}`})`
    + ` | ${wsName} requests ${r.mainRequests}, cache_read ${r.cacheReadTokens}, weighted ${weighted(r)}, last request ${r.lastRequestTokens} tok`
    + ` | nudges ${r.nudgeRequests}, handoffs ${r.handoffsDispatched}, ctx at nudge ${r.ctxAtNudge} -> at opening ${r.ctxAtOpening} tok, state identical ${r.stateIdentical}, opening carries refs ${r.openingCarriesRefs}`);
  return r;
}

const MUST_FAIL_ON = ['nudged', 'handedOff', 'opened', 'ctxDrops', 'openingRefs', 'drop'];
if (await arm('coord-env0', { wsName: 'ops-handoff-rig', envBound: '0', kind: 'off' })) {
  await arm('coord-default', { wsName: 'ops-handoff-rig', kind: 'on' });
  await arm('coord-file', { wsName: 'ops-handoff-rig', roleFile: { coordinator: { handoffBoundTurns: 12 } }, kind: 'on', minHandoffs: 2 });
  await arm('impl-default (must-FAIL: no bound ⇒ no drop)', { wsName: 'impl-handoff-rig', kind: 'on', wantFail: MUST_FAIL_ON });
  const impl = reports['impl-default (must-FAIL: no bound ⇒ no drop)'];
  if (impl) {
    const q = Object.entries(judgeHandoffRole('off', impl)).filter(([, ok]) => !ok).map(([k]) => k);
    if (q.length) bad++;
    console.log(`impl-default positive control (a non-coordinator is quiet): ${q.length ? `FAIL [${q.join(', ')}]` : 'PASS'}`);
  }
  await arm('mutant handoff-role-ignored (must-FAIL)', { wsName: 'ops-handoff-rig', mutant: 'handoff-role-ignored', kind: 'on', wantFail: MUST_FAIL_ON });
  await arm('mutant handoff-role-by-name (must-FAIL)', { wsName: 'ops-handoff-rig', mutant: 'handoff-role-by-name', kind: 'on', wantFail: MUST_FAIL_ON });
  await arm('mutant handoff-wipes-state (must-FAIL: only stateIdentical)', { wsName: 'ops-handoff-rig', mutant: 'handoff-wipes-state', kind: 'on', wantFail: ['stateIdentical'] });
  await arm('mutant handoff-role-all-on (must-FAIL)', { wsName: 'impl-handoff-rig', mutant: 'handoff-role-all-on', kind: 'off', wantFail: ['quiet'] });
  const b = reports['coord-env0'], d = reports['coord-default'];
  if (b && d) {
    const pct = (a, c) => `${(((c - a) / c) * 100).toFixed(1)}%`;
    console.log(`\ncoordinator, ${turns} user turns, heavy profile (one turn = ONE API request here), default bound`);
    console.log(`  cache_read ${b.cacheReadTokens} -> ${d.cacheReadTokens} (${pct(d.cacheReadTokens, b.cacheReadTokens)} lower) · WEIGHTED ${weighted(b)} -> ${weighted(d)} (${pct(weighted(d), weighted(b))} lower) · final context ${b.lastRequestTokens} -> ${d.lastRequestTokens} tok`);
  }
}
console.log(bad ? `handoff-role: DIRTY (${bad})` : 'handoff-role: CLEAN');
process.exit(bad ? 1 : 0);
