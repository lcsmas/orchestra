// Vague-endormie rig (#428): the PRODUCTION asleep-vague sweep over the REAL session path (real `sdkSend` → keeper → real `claude` CLI against the fake API, zero tokens) with a REAL bus file.
// Five vagues (a coordinator + one member each), delays shortened to quiet 10 s / process bound 45 s; the clauses are judged on what the fleet observes — a Relance turn in the COORDINATOR's conversation:
//   asleep      a member idle with an unfinished task, nothing alive ⇒ the coordinator gets ONE Relance naming the task, since when and the member's last activity (and `bus-status`'s view says asleep + since)
//   episode     the same vague stays asleep for two more delays ⇒ still ONE Relance; a member resuming ENDS the episode; it falls quiet again ⇒ a second, NEW episode ⇒ a second Relance
//   active      a member runs a turn for 26 s (longer than the delay) ⇒ nobody is told while it runs; told once it has been quiet for the delay
//   process     a live detached script protects the vague (member quiet LONGER than the delay, script alive ⇒ no turn) until 45 s of inactivity, then the coordinator is told and the Relance NAMES the script
//   finished    the member reported done on the real bus ⇒ never told      untasked   a hand-made workspace with no dispatched task ⇒ never told
// `--proof` adds the CONTROL arm (mechanism never started: nobody gets a turn although every vague was quiet past the delay and the process bound lapsed) and the must-FAIL mutant arms (load-time edits of the
// shipped source: the arm named for the clause must go RED).
//   node scripts/session-budget/vague-endormie.mjs [--proof] [--verbose]
import path from 'node:path';
import { runVagueArm, ensureBuilt } from './harness.mjs';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const proof = process.argv.includes('--proof');

export function judgeVague(r) {
  const s = r.sample ?? {};
  const t = (x) => x ?? '';
  return {
    // the fixture could have fired: the member of b / d / e had been quiet for longer than the delay when sampled, and b's script was really alive
    sampled: s.aTold === true && s.quietAgeMs?.b > r.quietMs && s.quietAgeMs?.d > r.quietMs && s.quietAgeMs?.e > r.quietMs && s.bScriptAlive === true && r.scriptAliveAtStart === true,
    asleep: r.vagues?.a?.relances >= 1 && /TASK-a: finish the a fix and push/.test(t(r.aText)) && /asleep since \d\d:\d\d:\d\d UTC/.test(t(r.aText)) && /impl-a — .* last activity \d\d:\d\d:\d\d UTC/.test(t(r.aText)) && r.aCoordinatorSessionLive === true && r.aView?.nudgedAt != null && Array.isArray(r.aView?.unfinished) && r.aView.unfinished.length === 1 && typeof r.aView?.since === 'number',
    episode: r.aBeforeResume === 1 && r.aEpisodeStillOpen === true && r.aEpisodeEndedByResume === true && r.aSecondEpisodeTold === true && r.aFinal === 2,
    active: s.cStatus === 'running' && s.turns?.c === 0 && r.cToldAfterQuiet === true && r.vagues?.c?.relances === 1,
    process: s.turns?.b === 0 && r.bToldAfterBound === true && r.vagues?.b?.relances === 1 && /VAGSCRIPT-b-1/.test(t(r.bText)) && /Processes still alive:/.test(t(r.bText)) && r.bQuietAgeAtTold >= r.processMs - 1500,
    finished: r.vagues?.d?.relances === 0 && r.vagues?.d?.coordinatorTurnEnds === 0,
    untasked: r.vagues?.e?.relances === 0 && r.vagues?.e?.coordinatorTurnEnds === 0,
  };
}
/** The control: same fixture, mechanism never started ⇒ every vague was quiet past the delay (proven), b's script outlived the process bound (proven), and NOBODY got a turn. */
export function judgeControl(r) {
  const q = r.finalQuietAgeMs ?? {};
  return {
    'could-have-fired': ['a', 'b', 'c', 'd', 'e'].every((v) => q[v] > r.quietMs * 2) && q.b > r.processMs && r.bScriptAlive === true,
    'nobody-gets-a-turn': ['a', 'b', 'c', 'd', 'e'].every((v) => r.vagues?.[v]?.relances === 0 && r.vagues?.[v]?.coordinatorTurnEnds === 0),
  };
}
// the mutant arms: load-time edits of the shipped source (mutants.mjs); each must turn ONLY the named clauses red
export const MUTANT_ARMS = [
  ['vague-no-episode', ['episode']],
  ['vague-ignore-process', ['process']],
  ['vague-ignore-active', ['active']],
  ['vague-coordinator-resume-ends', ['episode']],
];

ensureBuilt(repo);
let bad = 0;
async function arm(label, o, judge, wantFail) {
  const res = await runVagueArm({ repo, arm: label, timeoutMs: 280_000, ...o });
  const r = res.vague;
  if (res.void || res.error || !r || r.error) {
    bad++;
    console.log(`${label}: BROKEN ${res.error ?? r?.error ?? 'no result'}${res.root ? ` (root ${res.root})` : ''}`);
    if (r) console.log(`  ${JSON.stringify(r)}`);
    return;
  }
  const v = judge(r);
  const failed = Object.entries(v).filter(([, ok]) => !ok).map(([k]) => k);
  const ok = wantFail === 'pass' ? failed.length === 0 : wantFail.every((w) => failed.includes(w));
  if (!ok) bad++;
  console.log(`${label}: ${failed.length ? `FAIL [${failed.join(', ')}]` : 'PASS'} (${ok ? 'expected' : `UNEXPECTED — wanted ${wantFail === 'pass' ? 'PASS' : `FAIL incl. [${wantFail.join(', ')}]`}`})`);
  if (!ok || process.argv.includes('--verbose')) console.log(`  ${JSON.stringify(r)}`);
}
await arm('vague', {}, judgeVague, 'pass');
if (proof) {
  await arm('vague-control-off', { vague: false }, judgeControl, 'pass');
  for (const [m, want] of MUTANT_ARMS) await arm(m, { mutant: m }, judgeVague, want);
}
console.log(bad ? `vague: DIRTY (${bad})` : 'vague: CLEAN');
process.exit(bad ? 1 : 0);
