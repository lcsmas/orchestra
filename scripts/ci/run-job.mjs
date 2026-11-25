#!/usr/bin/env node
// #568 — run ONE CI job command, count its tests/arms, write the step summary + a result file, judge it (no silent green).
//   node --experimental-strip-types scripts/ci/run-job.mjs rig <id>      a rig from .github/ci-rigs.json
//   node --experimental-strip-types scripts/ci/run-job.mjs suite <tap-log>  verdict on a finished `pnpm run test > <tap-log>` (env SUITE_OUTCOME = that step's outcome, SUITE_T0 = its start, epoch s): TAP summary, skips vs .github/ci-skips.json.
//     The suite is run by a plain `run: pnpm run test > …` step on purpose: `orchestra fanout gate` derives the suite check only from a plain runner step.
//   node --experimental-strip-types scripts/ci/run-job.mjs typecheck     `npx tsc --noEmit`
// Env: CI_RESULT_DIR (default $RUNNER_TEMP/ci-result) gets <job>.json; CI_DISCOVERY=1 never fails the step (the verdict is in the JSON).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge, parseRigCounts, parseTapSummary, readRigFile, stripAnsi, tapFails, tapSkips } from '../../src/shared/ci-rigs.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [kind, arg] = process.argv.slice(2);
const resultDir = process.env.CI_RESULT_DIR || path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'ci-result');
fs.mkdirSync(resultDir, { recursive: true });

let name; let command; let timeoutMin = 10; let entry;
if (kind === 'rig') {
  entry = readRigFile(root).rigs.find((r) => r.id === arg);
  if (!entry) { console.error(`::error::no rig "${arg}" in .github/ci-rigs.json`); process.exit(2); }
  name = `rig:${arg}`; command = entry.pre ? `${entry.pre} && ${entry.command}` : entry.command; timeoutMin = entry.timeoutMin ?? 10;
} else if (kind === 'suite') { name = 'suite'; command = 'pnpm run test'; }
else if (kind === 'typecheck') { name = 'typecheck'; command = 'npx tsc --noEmit'; timeoutMin = 15; }
else { console.error('usage: run-job.mjs rig <id> | suite <tap-log> | typecheck'); process.exit(2); }

const t0 = Date.now();
let log; let exit; let timedOut = false; let wallSec;
if (kind === 'suite') {
  // The suite already ran in the previous step (its stdout+stderr went to <tap-log>): a missing/empty log is red, never green.
  const file = arg;
  log = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  exit = process.env.SUITE_OUTCOME === 'success' ? 0 : 1;
  wallSec = process.env.SUITE_T0 ? Math.round(Date.now() / 1000 - Number(process.env.SUITE_T0)) : 0;
  // the whole TAP stream stays readable in the job log
  // a digest, not the 2.8 MB stream (the full TAP file is uploaded as an artifact): failing/skipped tests + the last lines.
  const digest = stripAnsi(log).split('\n').filter((l) => /^\s*(not ok|ok \d+ - .*# (SKIP|TODO)|# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms))/.test(l)).join('\n');
  console.log(`::group::pnpm run test — digest (${log.length} bytes of TAP)\n${digest}\n::endgroup::`);
  console.log(`::group::pnpm run test — last 120 lines\n${stripAnsi(log).split('\n').slice(-120).join('\n')}\n::endgroup::`);
} else {
  // A contained rig whose headless sway never came up ("[rig] ABORT: could not set the marker…" / "my sway never created…") ran NO arm: that is runner startup flake, retried (max 3 attempts).
  // Any other outcome — a red arm included — is final. The attempt count is printed and written to the summary.
  const SWAY_FLAKE = /\[rig\] ABORT: (could not set the marker on my own output|my sway never created)/;
  var attempts = 0;
  for (;;) {
  attempts++;
  const chunks = [];
  const child = spawn('bash', ['-o', 'pipefail', '-c', command], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: 'true' } });
  const sink = (b) => { chunks.push(b); process.stdout.write(b); };
  child.stdout.on('data', sink); child.stderr.on('data', sink);
  const killer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000); }, timeoutMin * 60_000);
  exit = await new Promise((res) => child.on('close', (code, sig) => res(code ?? (sig ? 128 : 1))));
  clearTimeout(killer);
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is already gone */ } // reap what the rig left behind (daemons, sway, electron) so the NEXT rig of this runner starts clean
  log = Buffer.concat(chunks).toString('utf8');
  wallSec = Math.round((Date.now() - t0) / 1000);
  if (exit !== 0 && kind === 'rig' && attempts < 3 && SWAY_FLAKE.test(stripAnsi(log))) { console.log(`::warning::${name}: compositor start-up flake, retrying (attempt ${attempts + 1}/3)`); continue; }
  // Any other red (not a timeout): ONE fresh re-run. A timing clause that flakes once on a shared runner passes on a fresh process; a real regression is red twice.
  // Both attempts are printed and the attempt count lands in the table, so a green-on-retry is visible and countable.
  if (exit !== 0 && kind === 'rig' && !timedOut && attempts < 2 && !/each-arm\.mjs/.test(command)) { console.log(`::warning::${name}: red on attempt ${attempts} (exit ${exit}), re-running once on a fresh process`); continue; }
  break;
  }
}

let counts; let verdict; let skipNote = '';
if (kind === 'typecheck') {
  // tsc prints nothing on success: the positive terminator is exit 0 (a count of "checked files" is not exposed), so the arm count is 1 = this run.
  counts = { run: 1, pass: exit === 0 ? 1 : 0, fail: exit === 0 ? 0 : 1, skipped: 0, source: 'tsc exit code' };
  verdict = judge(timedOut ? 124 : exit, counts);
} else if (kind === 'suite') {
  const tap = parseTapSummary(log);
  if (!tap) { counts = { run: 0, pass: 0, fail: 0, skipped: 0, source: 'NO TAP summary in the log (truncated or reporter changed)' }; verdict = { ok: false, why: 'no TAP summary: the run did not complete' }; }
  else {
    counts = tap;
    const allow = JSON.parse(fs.readFileSync(path.join(root, '.github', 'ci-skips.json'), 'utf8')).skips;
    const bad = allow.filter((s) => !s.name?.trim() || !s.reason?.trim());
    const skips = tapSkips(log);
    const allowed = skips.filter((s) => allow.some((a) => a.name === s.name && a.reason?.trim()));
    // knownFail: tests that are red on the runner for a reason of the runner (listed with it); tolerated ONLY when every failed test is listed and none other failed.
    const known = JSON.parse(fs.readFileSync(path.join(root, '.github', 'ci-skips.json'), 'utf8')).knownFail ?? [];
    const fails = tapFails(log);
    const tolerated = fails.length > 0 && fails.length === counts.fail && fails.every((f) => known.some((k) => k.name === f && k.reason?.trim()));
    if (tolerated) { var toleratedNames = fails; counts = { ...counts, pass: counts.pass, fail: 0, source: `TAP summary (${fails.length} known-fail tolerated)` }; skipNote += `\n\nKnown-fail tests tolerated (.github/ci-skips.json knownFail):\n` + fails.map((f) => `- ${f}`).join('\n'); }
    verdict = bad.length ? { ok: false, why: `ci-skips.json entry without name/reason` } : judge(timedOut ? 124 : tolerated && exit === 1 ? 0 : exit, counts, { skippedAllowed: allowed.length });
    if (skips.length) skipNote = '\n\nSkipped tests:\n' + skips.map((s) => `- ${allowed.includes(s) ? '(allow-listed) ' : ''}${s.name}${s.reason ? ` — ${s.reason}` : ''}`).join('\n');
  }
} else {
  counts = parseRigCounts(log, entry);
  verdict = judge(timedOut ? 124 : exit, counts);
}
if (timedOut) verdict = { ok: false, why: `timed out after ${timeoutMin} min` };

const tail = stripAnsi(log).split('\n').filter((l) => l.trim()).slice(-25).join('\n');
const armRetries = [...stripAnsi(log).matchAll(/^ARM .*, (\d+) attempts\)/gm)].reduce((n, m) => n + Number(m[1]) - 1, 0);
const result = { name, attempts: typeof attempts === 'number' ? attempts : 1, armRetries, tolerated: typeof toleratedNames !== 'undefined' ? toleratedNames : [], id: kind === 'rig' ? arg : name, command, exit, timedOut, wallSec, counts, ok: verdict.ok, why: verdict.why, tail };
fs.writeFileSync(path.join(resultDir, `${name.replace(/[^\w.-]+/g, '_')}.json`), JSON.stringify(result, null, 1));
const md = `### ${verdict.ok ? '✅' : '❌'} ${name}\n\n| run | passed | failed | skipped | wall | source |\n|---|---|---|---|---|---|\n| ${counts.run} | ${counts.pass} | ${counts.fail} | ${counts.skipped} | ${wallSec}s${typeof attempts === 'number' && attempts > 1 ? ` (${attempts} attempts)` : ''}${armRetries > 0 ? ` (${armRetries} arm re-run${armRetries > 1 ? 's' : ''})` : ''} | ${counts.source} |\n\n${verdict.ok ? '' : `**${verdict.why}**\n\n\`\`\`\n${tail}\n\`\`\`\n`}${skipNote}\n`;
if (process.env.GITHUB_STEP_SUMMARY && !(process.env.CI_GROUP === '1' && verdict.ok)) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md); // a group prints ONE table; only a red rig adds its tail
console.log(`\n[ci] ${name}: ${verdict.ok ? 'OK' : 'FAIL'} — ${verdict.why} (run=${counts.run} pass=${counts.pass} fail=${counts.fail} skipped=${counts.skipped}, ${wallSec}s)`);
process.exitCode = verdict.ok || process.env.CI_DISCOVERY === '1' ? 0 : 1; // not process.exit(): pending piped stdout would be cut (the verdict line was lost once)
