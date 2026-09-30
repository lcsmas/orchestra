#!/usr/bin/env node
// Soak campaign SELF-TEST (C5 #212):  pnpm run test:soak-campaign [-- --arm <name>]
// The real campaign (N real sessions vs the fake API, netns+pidns) run with SEEDS whose truth is known, so a detector that cannot fail is caught:
//   seeded         4 sessions: s1's MCP child leaks 60 MB/min forever, s2's API hangs after its 3rd main request; s0/s3 are the in-run controls.
//                  MUST FAIL naming soak.memory.slopeMBPerMin.s1 and soak.wedge.session.s2 — and NOT s0/s3, with no leftover process.
//   healthy        3 sessions, no seed: MUST PASS (a detector that flags everything is as useless as one that flags nothing).
//   abort-runner   the RUNNER's own per-sample cap check trips (D7): MUST be ABORTED naming high-load, torn down gracefully, 0 survivors.
//   abort-watchdog the PARENT's independent cap watchdog trips mid-run (a load spike it reads): MUST be ABORTED naming it.
//   abort-yield    the caller aborts mid-run (the app yielding to the user): MUST be ABORTED naming the caller's reason, 0 survivors.
// Exit 0 all arms as expected · 1 an arm broke expectation · 3 an arm was VOID/ABORTED unexpectedly (machine too busy — re-run when calm).
// ~13 min for all arms; each arm is ONE campaign, run one at a time (D7). Last line: `SOAK-SELFTEST: PASS|FAIL|VOID`.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCampaign, otherRunnerAlive, readMemAvailKB, readLoad1 } from './soak-lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const want = args.includes('--arm') ? args[args.indexOf('--arm') + 1] : 'all';
const outDir = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'session-budget', 'soak-selftest-'));
// `--duration <sec>` (≥ 180: a 60 s warm-up + the 120 s window the judge needs) shortens the seeded/healthy arms — the mutation gate uses 180.
const durationSec = args.includes('--duration') ? Number(args[args.indexOf('--duration') + 1]) : 240;
const base = { sessions: 3, durationSec, turnIntervalSec: 15, sampleSec: 10, turnDeadlineSec: 20, replyDelayMs: 500 };

// Each arm: a campaign spec + `check(res)` → list of [ok, message] assertions with LITERAL expectations.
const V = (res, id) => res.report.verdicts?.find((v) => v.id === id);
const ARMS = {
  seeded: {
    run: () => runCampaign({ repo: REPO, params: { ...base, sessions: 4 }, seedLeak: { session: 1, mbPerMin: 60 }, faultPlan: { rules: [{ match: { session: 's2', main: true }, after: 3, action: { kind: 'hang' } }] }, outDir, label: 'seeded' }),
    expect: 'FAIL',
    check: (r) => [
      [V(r, 'soak.memory.slopeMBPerMin.s1')?.ok === false && V(r, 'soak.memory.slopeMBPerMin.s1').actual >= 30, `the seeded leak (60 MB/min) is named on s1: ${V(r, 'soak.memory.slopeMBPerMin.s1')?.message}`],
      [V(r, 'soak.wedge.session.s2')?.ok === false, `the seeded wedge is named on s2: ${V(r, 'soak.wedge.session.s2')?.message}`],
      [V(r, 'soak.wedge.wedgedTurns')?.actual === 1 && V(r, 'soak.wedge.wedgedSessions')?.actual === 1, `exactly 1 wedged turn in 1 session (saw ${V(r, 'soak.wedge.wedgedTurns')?.actual}/${V(r, 'soak.wedge.wedgedSessions')?.actual})`],
      [['s0', 's3'].every((s) => V(r, `soak.memory.slopeMBPerMin.${s}`)?.ok === true), 'the control sessions s0 and s3 are NOT flagged for memory'],
      [['s0', 's1', 's3'].every((s) => V(r, `soak.wedge.session.${s}`)?.ok === true), 'the controls and the leaker are NOT flagged as wedged'],
      [(r.report.api?.sessions?.s2?.held ?? 0) >= 1, `the fake API HELD s2's request (positive control that the fault fired): held=${r.report.api?.sessions?.s2?.held}`],
      [(r.report.memory.sessions[1]?.growthMB ?? 0) >= 100, `s1's tree really grew (${r.report.memory.sessions[1]?.growthMB} MB in the window, want ≥ 100)`],
      [V(r, 'soak.processes.survivorsAfterDelete')?.ok === true && r.report.processes.survivorsAfterDelete.total === 0, 'nothing survives the delete, even the leaking and the wedged session'],
    ],
  },
  healthy: {
    run: () => runCampaign({ repo: REPO, params: base, outDir, label: 'healthy' }),
    expect: 'PASS',
    check: (r) => [
      [r.report.wedge.turns >= 30 && r.report.wedge.ok === r.report.wedge.turns, `all ${r.report.wedge.turns} turns completed (want ≥ 30, none wedged/errored)`],
      [r.report.memory.sessions.every((s) => s.slopeMBPerMin != null), 'every session has a slope'],
      [r.report.processes.survivorsAfterDelete.total === 0, 'no survivors'],
    ],
  },
  'abort-runner': {
    // The RUNNER's own D7 check: a per-run tightening that only the runner applies (preflight passes, the first in-flight sample trips).
    run: () => runCampaign({ repo: REPO, params: { ...base, sessions: 2, durationSec: 120 }, runnerCapsOverride: { maxLoad1: 0.001 }, outDir, label: 'abort-runner' }),
    expect: 'ABORTED',
    check: (r) => [
      [r.report.aborted?.reason === 'high-load' && !/parent watchdog/.test(r.report.aborted.detail), `the RUNNER named the cap itself: ${r.report.aborted?.reason} — ${r.report.aborted?.detail}`],
      [r.report.processes.survivorsAfterDelete.total === 0, 'torn down gracefully: the delete census ran and found 0'],
    ],
  },
  'abort-watchdog': {
    run: () => {
      const t0 = Date.now();
      return runCampaign({ repo: REPO, params: { ...base, sessions: 2, durationSec: 180 }, outDir, label: 'abort-watchdog',
        readResources: () => ({ memAvailKB: readMemAvailKB(), load1: Date.now() - t0 > 40_000 ? 99 : Math.min(readLoad1(), 5) }) });
    },
    expect: 'ABORTED',
    check: (r) => [
      [r.report.aborted?.reason === 'high-load' && /parent watchdog/.test(r.report.aborted.detail), `the PARENT watchdog named it: ${r.report.aborted?.reason} — ${r.report.aborted?.detail}`],
      [r.report.processes.survivorsAfterDelete.total === 0, 'torn down gracefully: 0 survivors'],
      [(r.report.aborted?.tSec ?? -1) > 0, `the abort is stamped with elapsed time (${r.report.aborted?.tSec} s), not -1`],
    ],
  },
  'abort-yield': {
    run: () => {
      const ac = new AbortController();
      setTimeout(() => ac.abort({ reason: 'user-active', detail: 'the Orchestra window is focused' }), 45_000);
      return runCampaign({ repo: REPO, params: { ...base, sessions: 2, durationSec: 180 }, outDir, label: 'abort-yield', signal: ac.signal });
    },
    expect: 'ABORTED',
    check: (r) => [
      [r.report.aborted?.reason === 'user-active', `the caller's reason is preserved: ${r.report.aborted?.reason}`],
      [r.report.processes.survivorsAfterDelete.total === 0, 'torn down gracefully: 0 survivors'],
      [r.report.wedge.turns >= 1, 'partial rates are still reported'],
    ],
  },
};
if (want !== 'all' && !ARMS[want]) { console.error(`unknown arm: ${want} (have: ${Object.keys(ARMS).join(', ')})`); process.exit(2); }

let bad = 0, voided = 0;
for (const [name, arm] of Object.entries(ARMS)) {
  if (want !== 'all' && want !== name) continue;
  console.log(`== arm ${name} (expect ${arm.expect}) — free ${(readMemAvailKB() / 1048576).toFixed(1)} GB, load ${readLoad1()}`);
  const res = await arm.run();
  if (res.refused) { voided++; console.log(`   VOID — refused: ${res.refused.join(' | ')}`); continue; }
  const r = res;
  console.log(`   terminator ${r.terminator} (rc ${r.rc}) · ${r.files.json}`);
  if (r.terminator !== arm.expect) {
    if (['VOID', 'ABORTED', 'BROKE'].includes(r.terminator) && arm.expect !== r.terminator) {
      // The machine (or the run) did not let the arm measure: NOT a verdict on the detector.
      const why = r.report.aborted ? `aborted (${r.report.aborted.reason}: ${r.report.aborted.detail})` : r.terminator === 'VOID' ? r.report.verdicts.filter((v) => !v.ok && v.kind === 'instrument').map((v) => v.message).join(' | ') : r.report.error;
      voided++; console.log(`   VOID — expected ${arm.expect}, got ${r.terminator}: ${why}`); continue;
    }
    bad++; console.log(`   UNEXPECTED — expected ${arm.expect}, got ${r.terminator}: ${r.report.verdicts?.filter((v) => !v.ok).map((v) => v.message).join(' | ')}`); continue;
  }
  let armBad = false;
  for (const [ok, msg] of arm.check(r)) { console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) armBad = true; }
  if (armBad) bad++;
  console.log(`   ${armBad ? 'UNEXPECTED' : 'AS EXPECTED'}`);
}
const left = otherRunnerAlive();
if (left) { bad++; console.log(`SURVIVOR: a soak runner (pid ${left}) is still alive after the self-test`); }
fs.rmSync(outDir, { recursive: true, force: true });
const status = voided ? 'VOID' : bad ? 'FAIL' : want !== 'all' ? 'PARTIAL' : 'PASS';
console.log(`SOAK-SELFTEST: ${status}`);
process.exit(status === 'VOID' ? 3 : status === 'FAIL' ? 1 : 0);
