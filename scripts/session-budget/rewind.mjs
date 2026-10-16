// Rewind rig: Orchestra's real sdkSend ×3 → sdkRewind(turn 2) → sdkSend → sdkHistory, real keeper + real `claude`
// CLI against the fake API (zero tokens), inside the session-budget containment. Three clauses, judged on what the
// MODEL received and what a reopened pane backfills — the two surfaces the renderer's fold cannot show:
//   context — the new request keeps turn 1 WHOLE (prompt AND reply) and drops turns 2-3;
//   files   — the file turn 2 created is gone after the rewind;
//   history — sdkHistory shows turn 1 + the new prompt, never the rewound turns.
// `--proof` adds the must-FAIL mutant arms (each must fail exactly its clause).
//   node scripts/session-budget/rewind.mjs [--proof] [--runs N]
import path from 'node:path';
import { runRewindArm, ensureBuilt } from './harness.mjs';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const proof = process.argv.includes('--proof');
const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 1;

export function judgeRewind(r) {
  const c = r.context ?? {};
  return {
    context: !!(c.keptT1Prompt && c.keptT1Reply && c.droppedT2 && c.droppedT3 && c.hasNew && !c.newTurnError),
    files: r.fileAfterTurn2 === true && r.fileAfterRewind === false && (r.coldPreview === undefined || (r.coldPreview.canRewind === true && r.coldPreview.files > 0)),
    history: JSON.stringify((r.historyUserTexts ?? []).map((t) => t.split(' ')[0])) === JSON.stringify(['PROMPT-T1', 'PROMPT-NEW'])
      && JSON.stringify((r.historyBeforeSend ?? []).map((t) => t.split(' ')[0])) === JSON.stringify(['PROMPT-T1'])
      && r.cutPersisted === true,
    // ≥ 2 graceful stops (the rewind's + the teardown's) proves the log carried the events this clause reads.
    handoff: r.gracefulStops >= 2 && r.attachesToDyingCli === 0,
  };
}

ensureBuilt(repo);
let bad = 0;
async function arm(label, mutant, wantFail, exitDelayMs = 0, cold = false) {
  const res = await runRewindArm({ repo, arm: label, mutant, exitDelayMs, cold, timeoutMs: 120_000 });
  const r = res.rewind;
  if (res.void || res.error || !r || r.error) {
    bad++;
    console.log(`${label}: BROKEN ${res.error ?? r?.error ?? 'no result'}${res.root ? ` (root ${res.root})` : ''}`);
    return;
  }
  const v = judgeRewind(r);
  const failed = Object.entries(v).filter(([, ok]) => !ok).map(([k]) => k);
  const ok = JSON.stringify(failed) === JSON.stringify(wantFail);
  if (!ok) bad++;
  console.log(`${label}: ${failed.length ? `FAIL [${failed.join(', ')}]` : 'PASS'} (${ok ? 'expected' : `UNEXPECTED — wanted ${wantFail.length ? `FAIL [${wantFail.join(', ')}]` : 'PASS'}`})`);
  if (!ok || process.argv.includes('--verbose')) {
    console.log(`  model saw after the rewind:\n    ${(r.modelSaw ?? []).join('\n    ')}`);
    console.log(`  context ${JSON.stringify(r.context)} files ${r.fileAfterTurn2}→${r.fileAfterRewind} ${JSON.stringify(r.rewindEvent)}${r.coldPreview ? ` cold preview ${JSON.stringify(r.coldPreview)}` : ''}`);
    console.log(`  history ${JSON.stringify(r.historyUserTexts)} · before the next send ${JSON.stringify(r.historyBeforeSend)}`);
    console.log(`  handoff: graceful stops ${r.gracefulStops}, attaches to a dying CLI ${r.attachesToDyingCli}`);
  }
}
if (process.argv.includes('--race')) {
  // The keeper race is a few-ms window (the old CLI exits just after the next send attached to it), so it is
  // measured as a RATE: N fixed runs must all pass; N mutant runs (no wait for the old keeper) must lose ≥ 1.
  const n = Number(process.argv[process.argv.indexOf('--race') + 1]) || 40;
  const tally = async (mutant) => {
    let failed = 0, broken = 0;
    for (let i = 0; i < n; i++) {
      const res = await runRewindArm({ repo, arm: `race-${mutant ?? 'fixed'}-${i}`, mutant, timeoutMs: 120_000 });
      if (res.void || res.error || !res.rewind || res.rewind.error) broken++;
      else if (!judgeRewind(res.rewind).context) failed++;
    }
    return { failed, broken };
  };
  const fixed = await tally(null);
  const mut = await tally('rewind-no-keeper-wait');
  console.log(`race fixed: ${fixed.failed}/${n} lost (broken ${fixed.broken}) · mutant rewind-no-keeper-wait: ${mut.failed}/${n} lost (broken ${mut.broken})`);
  const clean = fixed.failed === 0 && fixed.broken === 0 && mut.failed > 0;
  console.log(clean ? 'rewind race: CLEAN' : 'rewind race: DIRTY');
  process.exit(clean ? 0 : 1);
}
for (let i = 0; i < runs; i++) {
  await arm(`rewind-${i}`, null, []);
  // The same, with a CLI that takes 1.5 s to exit after a graceful stop: the next send lands inside that window.
  await arm(`rewind-slow-exit-${i}`, null, [], 1500);
  // The session hibernated first: the file checkpoints are on disk, so preview and restore must still work.
  await arm(`rewind-cold-${i}`, null, [], 0, true);
  if (proof) {
    // The pre-fix cut: resumeSessionAt = the PREVIOUS USER PROMPT, which drops that prompt's own reply.
    await arm(`rewind-mutant-cut-at-prev-prompt-${i}`, 'rewind-cut-at-prev-prompt', ['context']);
    // The pre-fix backfill: every line of the file, the abandoned branch included.
    await arm(`rewind-mutant-history-keeps-dead-branch-${i}`, 'rewind-history-keeps-dead-branch', ['history']);
    await arm(`rewind-mutant-history-ignores-pending-cut-${i}`, 'rewind-history-ignores-pending-cut', ['history']);
    await arm(`rewind-mutant-no-wake-${i}`, 'rewind-no-wake', ['files'], 0, true);
    // The pre-fix teardown: with a CLI slow to exit, the send after the rewind attaches to it (the stale path then
    // recovers here; with a fast exit the prompt is lost ~5% of the time — `--race` measures that rate).
    await arm(`rewind-mutant-no-keeper-wait-${i}`, 'rewind-no-keeper-wait', ['handoff'], 1500);
  }
}
console.log(bad ? `rewind: DIRTY (${bad})` : 'rewind: CLEAN');
process.exit(bad ? 1 : 0);
