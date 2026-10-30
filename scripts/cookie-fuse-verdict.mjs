// Re-derive the #407 verdict from the committed raw records (ledger #409 M3):
//   node --experimental-strip-types scripts/cookie-fuse-verdict.mjs docs/evidence/407-cookie-fuse.jsonl [--json]
// Exit 0 = GO / GO-WITH-COST, 1 = NO-GO / HARD-NO-GO, 2 = UNVERIFIED or unreadable input.
import fs from 'node:fs';
import { computeVerdict } from '../src/shared/cookie-fuse-verdict.ts';

const file = process.argv[2];
if (!file || file.startsWith('--')) { console.error('usage: cookie-fuse-verdict.mjs <records.jsonl> [--json]'); process.exit(2); }
const recs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l, i) => { try { return JSON.parse(l); } catch { throw new Error(`${file}:${i + 1}: not JSON`); } });
const v = computeVerdict(recs);
if (process.argv.includes('--json')) { console.log(JSON.stringify(v, null, 2)); }
else {
  const runs = [...new Set(recs.filter((r) => typeof r.run === 'number').map((r) => r.run))].sort();
  console.log(`records: ${recs.length} · runs: ${runs.join(',')} · controls: ${recs.filter((r) => r.kind === 'control').length} (${recs.filter((r) => r.kind === 'control' && !r.ok).length} red)`);
  console.log(`VERDICT: ${v.verdict}   [all scopes ${v.scopes.all} · host scope only ${v.scopes.host}]`);
  for (const r of v.reasons) console.log(`  - ${r}`);
  console.log(`H1 ${v.hard.H1.fired ? 'FIRED' : 'clear'} · H2 ${v.hard.H2.fired ? 'FIRED' : 'clear'} · H3 ${v.hard.H3.fired ? 'FIRED' : 'clear'} · H4 ${v.hard.H4.fired ? 'FIRED' : 'clear'}  |  (a) ${v.go.a.fired ? 'FAIL' : 'ok'} · (b) ${v.go.b.fired ? 'FAIL' : 'ok'} · (c) ${v.go.c.fired ? 'FAIL' : 'ok'} · (d) ${v.oneWay.measured ? 'documented' : 'NOT measured'}`);
  console.log(`cost (signed out until unlock): ${v.cost.signedOutUntilUnlock} · permanent loss: ${v.cost.permanentLoss} · (d) fuse-OFF reads the encrypted cookies: ${v.oneWay.fuseOffReadsEncrypted} · re-flip recovers: ${v.oneWay.reflipRecovers}`);
  console.log(JSON.stringify(v.numbers));
  // per-step table, straight from the records: what each boot could still read, and what the Cookies DB held before / after it
  const STEPS = [['A1', 'ON · unlocked, first start after the upgrade'], ['A2', 'ON · unlocked, A1 bytes restored (restore control)'], ['D1', 'fuse back OFF over A1 bytes'], ['D2', 'ON again after D1'], ['C2L', 'ON · LOCKED over A1 bytes'], ['C2U', 'ON · unlocked after C2L'],
    ['C2N', 'ON · no keyring over A1 bytes'], ['C2B', 'ON · basic_text over A1 bytes'], ['CL1', 'ON · locked, plaintext-only jar'], ['CN1', 'ON · no keyring, plaintext-only jar'], ['CB1', 'ON · basic_text, plaintext-only jar'], ['GL1', 'ON · GNOME desktop, locked, plaintext-only jar'], ['GU1', 'ON · GNOME desktop, UNLOCKED (can the arm reach libsecret at all?)'],
    ['X1', 'diag: A1 bytes minus all sealed rows but ONE, ON · locked'], ['X2', 'diag: the same DB, ON · unlocked'], ['X3', 'diag: A1 bytes minus ALL sealed rows, ON · locked'], ['X4', 'diag: A1 bytes, ON · locked, NO write'], ['X5', 'diag: ON · unlocked after X4'],
    ['Y1', 'diag: ON · basic_text from the first start'], ['Y1b', 'diag: ON · basic_text again (restart + write)'], ['Y2', 'diag: ON · unlocked over the v10-only jar'], ['Y3', 'diag: ON · locked'], ['Y4', 'diag: ON · no keyring']];
  const pre = (step, part) => recs.filter((r) => r.kind === 'jar' && r.phase === 'pre' && r.step === step && r.partition === part);
  const dbs = (step, part) => recs.filter((r) => r.kind === 'db' && r.step === step && r.partition === part);
  const span = (xs) => (xs.length === 0 ? 'n/a' : Math.min(...xs) === Math.max(...xs) ? String(xs[0]) : `${Math.min(...xs)}–${Math.max(...xs)}`);
  console.log('\nstep  partition  runs  old readable  new readable  login kept  DB rows before→after   what');
  for (const [step, what] of STEPS) for (const part of ['profile', 'login']) {
    const j = pre(step, part); if (j.length === 0) continue;
    const d = dbs(step, part);
    console.log(`${step.padEnd(5)} ${part.padEnd(10)} ${String(j.length).padEnd(5)} ${(span(j.map((x) => x.oldReadable)) + '/' + j[0].oldExpected).padEnd(13)} ${(span(j.map((x) => x.newReadable)) + '/' + j[0].newExpected).padEnd(13)} ${(j.every((x) => x.loginKept) ? 'yes' : j.some((x) => x.loginKept) ? 'some' : 'NO').padEnd(11)} ${(span(d.map((x) => x.fileBefore?.total ?? -1)) + '→' + span(d.map((x) => x.file?.total ?? -1))).padEnd(22)} ${what}`);
  }
}
process.exit(v.verdict === 'GO' || v.verdict === 'GO-WITH-COST' ? 0 : v.verdict === 'UNVERIFIED' ? 2 : 1);
