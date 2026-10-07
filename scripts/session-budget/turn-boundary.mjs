// #317 turn-boundary gate: Orchestra's real session path, two turns, count_tokens SLOW after turn 1.
// A turn-end getContextUsage() bursts count_tokens and the CLI holds the next prompt behind it, so turn 2's
// model request waits ~countTokensDelayMs. PASS: turn 2 starts well before that. `--proof` adds the must-FAIL arm
// (mutant `turn-end-context-read` re-adds the call) and requires it to FAIL.
//   node scripts/session-budget/turn-boundary.mjs [--proof] [--runs N]
import path from 'node:path';
import { runSessionArm, ensureBuilt } from './harness.mjs';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const proof = process.argv.includes('--proof');
const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 1;
const DELAY = 20_000;
const BOUND = DELAY / 2;
const secondTurn = { countTokensDelayMs: DELAY, gapMs: 300, timeoutMs: DELAY * 3 };

ensureBuilt(repo);
let bad = 0;
async function arm(label, mutant, wantPass) {
  const r = await runSessionArm({ repo, arm: label, mutant, secondTurn, timeoutMs: 90_000 + DELAY * 3 });
  const st = r.report?.secondTurn;
  if (r.void || r.error || !st?.sent || st.sendToModelRequestMs == null) {
    bad++;
    console.log(`${label}: BROKEN ${r.error ?? JSON.stringify(st)}${r.root ? ` (root ${r.root})` : ''}`);
    return;
  }
  const pass = st.sendToModelRequestMs < BOUND;
  const verdict = pass === wantPass ? 'OK' : 'UNEXPECTED';
  if (pass !== wantPass) bad++;
  console.log(`${label}: ${pass ? 'PASS' : 'FAIL'} (${verdict}) turn2 send→model ${st.sendToModelRequestMs} ms (bound ${BOUND}), count_tokens turn1-end→turn2 ${st.countTokensTurn1EndToTurn2}`);
  // The gauge's remaining source must still carry a reading, or dropping the live read blanked it.
  const g = st.lastTurnEndGauge;
  if (!(g?.contextUsedTokens > 0 && g?.contextWindow > 0)) { bad++; console.log(`${label}: GAUGE-EMPTY turn-end carries ${JSON.stringify(g)}`); }
}
for (let i = 0; i < runs; i++) {
  await arm(`turn-boundary-${i}`, null, true);
  if (proof) await arm(`turn-boundary-mutant-${i}`, 'turn-end-context-read', false);
}
console.log(bad ? `turn-boundary: DIRTY (${bad})` : 'turn-boundary: CLEAN');
process.exit(bad ? 1 : 0);
