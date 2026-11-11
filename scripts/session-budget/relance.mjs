// Relance rig (#427): the PRODUCTION Relance over the REAL session path + real `claude` CLI against the fake API (zero tokens). Five members each launch DETACHED scripts through the real Bash tool and end their
// turn; the scripts then end, and the clauses are judged on what the fleet observes — a Relance turn in the member's conversation, how many, what it says:
//   basic       one script ends ⇒ exactly ONE turn, naming it                     survivor   one of two processes ends while a server keeps running ⇒ the turn names the script AND lists the server as still running
//   group       three scripts end 2 s apart ⇒ ONE turn naming all three            veille     the member was put in Veille (its session stopped, its script alive) ⇒ the Relance brings it back: the session is live and resumed
//   solo        a member WITHOUT a coordinator ⇒ no turn                            baseline   nothing is sent while the scripts are alive (and nothing for what was alive when the mechanism started)
//   ended       the rig's scripts really ended and the fake kernel really listed them (a control that proves the arm could have fired)
// `--proof` adds the CONTROL arm (mechanism never started: nobody gets a turn, the scripts ended all the same) and the must-FAIL mutant arms.
//   node scripts/session-budget/relance.mjs [--proof] [--verbose]
import path from 'node:path';
import { runRelanceArm, ensureBuilt } from './harness.mjs';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const proof = process.argv.includes('--proof');

const endedPart = (text) => text.split('Still running:')[0];
const runningPart = (text) => text.split('Still running:')[1] ?? '';

export function judgeRelance(r) {
  const s = r.scenarios ?? {};
  const t = (m) => s[m]?.text ?? '';
  return {
    baseline: Object.values(r.baselineTurns ?? { x: 1 }).every((n) => n === 0),
    ended: r.scriptsEnded === true && Object.values(r.listedEver ?? {}).length >= 5 && r.aliveBefore?.basic === true && r.aliveBefore?.group === true,
    basic: s.basic?.relances === 1 && /RELSCRIPT-basic-1/.test(t('basic')),
    survivor: s.survivor?.relances === 1 && /RELSCRIPT-survivor-1\b/.test(endedPart(t('survivor'))) && !/RELSCRIPT-survivor-server/.test(endedPart(t('survivor'))) && /RELSCRIPT-survivor-server/.test(runningPart(t('survivor'))) && r.survivorServerAlive === true,
    group: s.group?.relances === 1 && [1, 2, 3].every((k) => new RegExp(`RELSCRIPT-group-${k}\\b`).test(t('group'))),
    veille: s.veille?.relances === 1 && s.veille?.sessionLiveBefore === false && s.veille?.sessionLiveAfter === true && s.veille?.resumedConversation === true,
    solo: s.solo?.relances === 0,
  };
}
/** The control: same scenario, mechanism never started ⇒ the scripts end (proven) and NOBODY gets a turn. */
export function judgeControl(r) {
  const s = r.scenarios ?? {};
  return {
    ended: r.scriptsEnded === true && Object.values(r.listedEver ?? {}).length >= 5,
    'nobody-gets-a-turn': ['basic', 'survivor', 'group', 'veille', 'solo'].every((m) => s[m]?.relances === 0),
  };
}

ensureBuilt(repo);
let bad = 0;
async function arm(label, o, judge, wantFail) {
  const res = await runRelanceArm({ repo, arm: label, timeoutMs: 240_000, ...o });
  const r = res.relance;
  if (res.void || res.error || !r || r.error) {
    bad++;
    console.log(`${label}: BROKEN ${res.error ?? r?.error ?? 'no result'}${res.root ? ` (root ${res.root})` : ''}`);
    return;
  }
  const v = judge(r);
  const failed = Object.entries(v).filter(([, ok]) => !ok).map(([k]) => k);
  const ok = JSON.stringify(failed) === JSON.stringify(wantFail);
  if (!ok) bad++;
  console.log(`${label}: ${failed.length ? `FAIL [${failed.join(', ')}]` : 'PASS'} (${ok ? 'expected' : `UNEXPECTED — wanted ${wantFail.length ? `FAIL [${wantFail.join(', ')}]` : 'PASS'}`})`);
  if (!ok || process.argv.includes('--verbose')) console.log(`  ${JSON.stringify(r)}`);
}
await arm('relance', {}, judgeRelance, []);
if (proof) {
  await arm('relance-control-off', { relance: false }, judgeControl, []);
}
console.log(bad ? `relance: DIRTY (${bad})` : 'relance: CLEAN');
process.exit(bad ? 1 : 0);
