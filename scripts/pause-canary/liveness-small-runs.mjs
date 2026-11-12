#!/usr/bin/env node
// #438 — « a child idle between turns raises no false liveness escalation over 10 UNMUTATED runs ». Runs src/main/liveness-small-run.test.ts for seeds 1..10, each in a fresh process
// (turn count / dropped posttools / lost stop differ per seed), then the MUTANTS that must turn it red (a scratch edit of production source, restored byte-exact + cmp'd).
//   node scripts/pause-canary/liveness-small-runs.mjs [--runs 10] [--no-mutants]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const RUNS = Number(opt('runs', '10'));
const TEST = 'src/main/liveness-small-run.test.ts';
const run = (seed) => {
  const r = spawnSync(process.execPath, ['--test', '--experimental-strip-types', TEST], { cwd: REPO, encoding: 'utf8', env: { ...process.env, LIVENESS_SEED: String(seed) } });
  const n = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(r.stdout)?.[1] ?? NaN);
  return { seed, pass: n('pass'), fail: n('fail'), skipped: n('skipped'), rc: r.status, out: r.stdout };
};
// every instrument must be able to say FAIL: each mutant edits ONE production clause and the suite must go red (restored byte-exact)
const MUTANTS = [
  { name: 'stale-window-halved', file: 'src/shared/bus-liveness.ts', from: 'if (silentForMs <= STALE_AFTER_MS) {', to: 'if (silentForMs <= STALE_AFTER_MS / 2) {', why: 'a child idle 5 min is escalated (false escalation inside the window)' },
  { name: 'done-released-blind', file: 'src/main/bus-liveness.ts', from: "wd.kind = 'worker_done'", to: "wd.kind = 'worker_donX'", why: 'a finished child is escalated for ever' },
  { name: 'no-coordinator-of-child', file: 'src/shared/run-position.ts', from: 'return parent && parent.id !== ws.id ? parent : undefined;', to: 'return undefined;', why: 'the child has no coordinator: the positive control (a silent child IS escalated to P) goes red' },
];
let bad = 0;
const rows = [];
for (let seed = 1; seed <= RUNS; seed++) {
  const r = run(seed);
  const ok = r.pass === 4 && r.fail === 0 && r.skipped === 0 && r.rc === 0;
  if (!ok) bad++;
  rows.push(`unmutated seed ${seed}: pass ${r.pass} fail ${r.fail} skipped ${r.skipped} rc ${r.rc} → ${ok ? 'CLEAN (0 escalation in the window, 1 positive control)' : 'RED'}`);
  console.log(rows[rows.length - 1]);
}
if (!args.includes('--no-mutants')) {
  for (const m of MUTANTS) {
    const f = path.join(REPO, m.file);
    const orig = fs.readFileSync(f);
    const text = orig.toString('utf8');
    const hits = text.split(m.from).length - 1;
    if (hits !== 1) { console.log(`mutant ${m.name}: ANCHOR ${hits}× in ${m.file} — VOID`); bad++; continue; }
    let r;
    try { fs.writeFileSync(f, text.replace(m.from, m.to)); r = run(1); } finally { fs.writeFileSync(f, orig); }
    const same = Buffer.compare(fs.readFileSync(f), orig) === 0;
    const killed = r.fail > 0;
    if (!killed || !same) bad++;
    console.log(`mutant ${m.name}: fail ${r.fail} of ${r.pass + r.fail} → ${killed ? 'KILLED' : 'SURVIVED'}; restored byte-exact: ${same} (${m.why})`);
  }
}
console.log(`LIVENESS-SMALL-RUNS ${bad === 0 ? 'PASS' : 'FAIL'} — ${RUNS} unmutated runs${args.includes('--no-mutants') ? '' : ` + ${MUTANTS.length} mutants`}`);
process.exit(bad === 0 ? 0 : 1);
