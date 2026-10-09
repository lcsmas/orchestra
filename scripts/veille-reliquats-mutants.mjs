// #326 — in-place mutant harness for Veille and Reliquats. One mutant at a time: byte-exact backup → apply → run the tests that must go red → restore from the backup → `cmp`. A mutant that stays GREEN is a gap.
// Positive control first (the unmutated tree must be GREEN) so a red means the mutant, not a broken base.
//
//   node scripts/veille-reliquats-mutants.mjs              every mutant against the unit tests
//   node scripts/veille-reliquats-mutants.mjs --check      only verify every anchor matches exactly once
//   node scripts/veille-reliquats-mutants.mjs --rig [ids]  the rig-marked mutants against scripts/e2e-hibernate-wake.mjs reliquat_* (light: stub CLI + `sleep` orphans in a fake scope; no docker/browser/app)
//   node scripts/veille-reliquats-mutants.mjs V1 J4        a subset by id

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VT, VT_RIG_ARM, veilleMutants } from './veille-reliquats-mutants.list.mjs';

const REPO = path.resolve(process.env.SUBJECT_REPO ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const MUTANTS = veilleMutants(VT);
const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith('--'));
const todo = MUTANTS.filter((m) => !only.length || only.includes(m[0]));

function apply(file, edits) {
  const abs = path.join(REPO, file);
  const orig = fs.readFileSync(abs);
  let text = orig.toString('utf8');
  for (const [find, repl] of edits) {
    const n = text.split(find).length - 1;
    if (n !== 1) return { err: `anchor matched ${n}x (need exactly 1): ${find.slice(0, 90)}` };
    text = text.replace(find, () => repl);
  }
  return { abs, orig, mutated: text };
}

/** One child in its OWN process group, SIGKILLed whole at the deadline (a mutant that makes a test HANG must read as red, not wedge the sweep). */
function run(argv, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: REPO, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const num = (k) => Number((out.match(new RegExp(`^# ${k} (\\d+)`, 'm')) ?? [])[1] ?? NaN);
      resolve({ rc: timedOut ? 124 : code, timedOut, pass: num('pass'), fail: num('fail'), skipped: num('skipped'), out });
    });
  });
}
const runTests = (tests, ms = 180000) => run(['--experimental-strip-types', '--test', ...tests], ms);
const runArm = async (arm) => {
  const r = await run(['--experimental-strip-types', '--import', './scripts/.r2-register.mjs', 'scripts/e2e-hibernate-wake.mjs', arm], 120000);
  let j = null;
  try { j = JSON.parse(r.out.trim().split('\n').pop()); } catch { /* no JSON */ }
  return { ok: j?.ok === true, json: j, raw: r };
};

if (args.includes('--check')) {
  let bad = 0;
  for (const [id, file, edits] of todo) {
    const a = apply(file, edits);
    if (a.err) { console.log(`${id}: ANCHOR PROBLEM — ${a.err}`); bad++; } else if (a.mutated === a.orig.toString('utf8')) { console.log(`${id}: NO-OP mutant`); bad++; }
  }
  console.log(bad ? `${bad} bad mutant(s)` : `all ${todo.length} anchors match exactly once and change the file`);
  process.exit(bad ? 1 : 0);
}

async function guarded(a, fn) {
  try {
    fs.writeFileSync(a.abs, a.mutated);
    return await fn();
  } finally {
    fs.writeFileSync(a.abs, a.orig); // byte-exact restore …
    if (!fs.readFileSync(a.abs).equals(a.orig)) throw new Error(`RESTORE MISMATCH for ${a.abs}`); // … proven by comparison
  }
}

if (args.includes('--rig')) {
  const ids = Object.keys(VT_RIG_ARM).filter((id) => !only.length || only.includes(id));
  const base = {};
  for (const arm of new Set(ids.map((id) => VT_RIG_ARM[id]))) {
    base[arm] = await runArm(arm);
    console.log(`RIG POSITIVE CONTROL ${arm}: ok=${base[arm].ok}`);
    if (!base[arm].ok) { console.log('rig arm not green on the unmutated tree — refusing'); process.exit(2); }
  }
  let alive = 0;
  for (const id of ids) {
    const [, file, edits, , note] = MUTANTS.find((m) => m[0] === id);
    const a = apply(file, edits);
    if (a.err) { console.log(`${id}: ${a.err}`); alive++; continue; }
    const r = await guarded(a, () => runArm(VT_RIG_ARM[id]));
    const killed = !r.ok;
    if (!killed) alive++;
    console.log(`${id.padEnd(3)} ${killed ? 'KILLED  ' : 'SURVIVED'} rig:${VT_RIG_ARM[id]}  — ${note}`);
  }
  console.log(`rig mutants: ${ids.length - alive} killed / ${ids.length}`);
  process.exit(alive ? 1 : 0);
}

const allTests = [...new Set(MUTANTS.flatMap((m) => m[3]))];
const base = await runTests(allTests, 300000);
console.log(`POSITIVE CONTROL (unmutated): rc=${base.rc} pass=${base.pass} fail=${base.fail} skipped=${base.skipped}`);
if (base.rc !== 0 || base.skipped !== 0) { console.log('base is not green — refusing to judge mutants'); process.exit(2); }
let survived = 0;
for (const [id, file, edits, tests, note] of todo) {
  const a = apply(file, edits);
  if (a.err) { console.log(`${id.padEnd(3)} ANCHOR-ERROR ${a.err}`); survived++; continue; }
  const r = await guarded(a, () => runTests(tests));
  const verdict = r.rc !== 0 ? 'KILLED' : 'SURVIVED';
  if (verdict === 'SURVIVED') survived++;
  console.log(`${id.padEnd(3)} ${verdict.padEnd(9)} rc=${r.rc}${r.timedOut ? ' (HUNG→killed)' : ''} pass=${r.pass} fail=${r.fail}  ${file}  — ${note}`);
}
const post = await runTests(allTests, 300000);
console.log(`\n${todo.length - survived} killed / ${todo.length}; POST-RESTORE (tree back to base): rc=${post.rc} pass=${post.pass} fail=${post.fail} skipped=${post.skipped}`);
process.exit(survived || post.rc !== 0 ? 1 : 0);
