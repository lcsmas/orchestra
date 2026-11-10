// Bloc HTML rig (#418): the REAL session path + real `claude` CLI against the fake API (zero tokens). Seven clauses, each judged on the number of
// copies of the instruction in the context the MODEL received — the only place "the model was told" is observable:
//   new-on       a fresh session with the switch ON has it                       new-off      a fresh session with it OFF does not
//   resumed-on   OFF at first start, ON at resume ⇒ the resumed session has it   resumed-off  ON at first start, OFF at resume ⇒ still the one copy, none added
//   resumed-on-on ON at first start and still ON at resume (a Veille wake) ⇒ exactly one copy, never a growing pile
//   running-off  a LIVE session started OFF stays without it after a flip to ON   running-on   a LIVE session started ON keeps exactly one copy after a flip to OFF
//   sub-agent    the Agent tool's sub-agent request does not carry it (the main session's does)
// `--proof` adds the must-FAIL mutant arms (each must fail exactly its clauses).
//   node scripts/session-budget/bloc-html.mjs [--proof] [--verbose]
import path from 'node:path';
import { runBlocHtmlArm, ensureBuilt } from './harness.mjs';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const proof = process.argv.includes('--proof');

export function judgeBlocHtml(r) {
  return {
    'new-on': r.newOn === 1,
    'new-off': r.newOff === 0,
    'resumed-on': r.resumedOnBefore === 0 && r.resumedOn === 1,
    'resumed-off': r.resumedOffBefore === 1 && r.resumedOff === 1,
    'resumed-on-on': r.resumedOnOnBefore === 1 && r.resumedOnOn === 1,
    'running-off': r.runningOffBefore === 0 && r.runningOff === 0,
    'running-on': r.runningOnBefore === 1 && r.runningOn === 1,
    'sub-agent': r.subMain === 1 && r.subSeen === true && r.subAgent === 0,
  };
}

ensureBuilt(repo);
let bad = 0;
async function arm(label, mutant, wantFail) {
  const res = await runBlocHtmlArm({ repo, arm: label, mutant, timeoutMs: 150_000 });
  const r = res.bloc;
  if (res.void || res.error || !r || r.error) {
    bad++;
    console.log(`${label}: BROKEN ${res.error ?? r?.error ?? 'no result'}${res.root ? ` (root ${res.root})` : ''}`);
    return;
  }
  const v = judgeBlocHtml(r);
  const failed = Object.entries(v).filter(([, ok]) => !ok).map(([k]) => k);
  const ok = JSON.stringify(failed) === JSON.stringify(wantFail);
  if (!ok) bad++;
  console.log(`${label}: ${failed.length ? `FAIL [${failed.join(', ')}]` : 'PASS'} (${ok ? 'expected' : `UNEXPECTED — wanted ${wantFail.length ? `FAIL [${wantFail.join(', ')}]` : 'PASS'}`})`);
  if (!ok || process.argv.includes('--verbose')) console.log(`  copies of the instruction in the model's context: ${JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !['arm', 'mutant', 'needle'].includes(k))))}`);
}
await arm('bloc-html', null, []);
if (proof) {
  // The flag is set whatever the switch says: OFF sessions are told.
  await arm('bloc-html-mutant-env-always', 'bloc-html-env-always', ['new-off', 'resumed-on', 'running-off']);
  // The flag is never set: ON sessions are told nothing.
  await arm('bloc-html-mutant-env-never', 'bloc-html-env-never', ['new-on', 'resumed-on', 'resumed-off', 'resumed-on-on', 'running-on', 'sub-agent']);
  // The hook is never registered on SessionStart: the script exists, nothing runs it.
  await arm('bloc-html-mutant-hook-unwired', 'bloc-html-hook-unwired', ['new-on', 'resumed-on', 'resumed-off', 'resumed-on-on', 'running-on', 'sub-agent']);
}
console.log(bad ? `bloc-html: DIRTY (${bad})` : 'bloc-html: CLEAN');
process.exit(bad ? 1 : 0);
