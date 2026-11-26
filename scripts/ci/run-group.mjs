#!/usr/bin/env node
// #568 (D5) — run ONE group of rigs in sequence on this runner: `node --experimental-strip-types scripts/ci/run-group.mjs <n> [--ids=a,b]` (#595: only those selected by path).
// Each rig goes through run-job.mjs (retry on a dead compositor, per-rig timeout, counts, no-silent-green judge); a failing rig does NOT stop the group.
// The job summary gets ONE per-rig table (pass/fail, counts, duration); the step fails at the end if any rig was red. The per-rig result files land in CI_RESULT_DIR.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignGroups, mutantParts, readRigFile } from '../../src/shared/ci-rigs.ts';
import { currentSelection, pathSelectionOn } from './selection.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = readRigFile(root);
// #623: `run-group.mjs mutants --part=i/N` runs part i of the N mutant parts (mutants.yml: push to master + nightly) — every mutant rig, no path selection.
const partArg = process.argv.find((a) => a.startsWith('--part='));
const MUT = process.argv[2] === 'mutants';
const [partI, partN] = partArg ? partArg.slice(7).split('/').map(Number) : [0, 0];
const n = MUT ? partI : Number(process.argv[2]);
const inGroup = MUT ? mutantParts(file, partN)[partI - 1] : assignGroups(file)[n - 1];
// #595: under `CI_PATH_SELECTION=1` (a pull_request run) only the rigs the changed files select run; `--plan` just prints the verdict and sets the step output `run` so the job can skip its
// install + bundles when nothing of this group is selected. `--ids=a,b` runs a subset of the group (an id outside it is an error, never a silent drop).
const idsArg = process.argv.find((a) => a.startsWith('--ids='));
const wanted = idsArg ? idsArg.slice(6).split(',').filter(Boolean) : null;
if (wanted && inGroup) { const stray = wanted.filter((id) => !inGroup.includes(id)); if (stray.length) { console.error(`::error::--ids names ${stray.join(', ')}, which is not in group ${n}`); process.exit(2); } }
const sel = !MUT && (pathSelectionOn() || process.env.CI_FULL_REASON) ? currentSelection(root, file) : null;
const chosen = sel ? new Set(sel.ran.map((r) => r.id)) : null;
const ids = inGroup && (wanted || chosen) ? inGroup.filter((id) => (!wanted || wanted.includes(id)) && (!chosen || chosen.has(id))) : inGroup;
const out = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
if (sel && inGroup && inGroup.length > 0 && (ids ?? []).length === 0) {
  const msg = `group ${n}: no rig selected by path (${sel.mode === 'paths' ? `${sel.skipped.length} rigs skipped by path across the run` : sel.fullReason}) — nothing to run, the job is green`;
  console.log(msg); out('run', 'false');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Rig group ${n}: ⏭ ${msg}\n`);
  process.exit(0);
}
out('run', 'true');
if (process.argv.includes('--plan')) { console.log(`group ${n}: ${ids?.length ?? 0} rig(s) selected${sel ? ` (${sel.mode === 'all' ? sel.fullReason : 'by path'})` : ''}`); process.exit(0); }
if (!Number.isInteger(n) || !ids || ids.length === 0) { console.error(`::error::group ${process.argv[2]} is empty or does not exist — a job that runs no rig is red`); process.exit(2); }
const resultDir = process.env.CI_RESULT_DIR || path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'ci-result');
fs.mkdirSync(resultDir, { recursive: true });
const slug = (id) => `rig_${id.replace(/[^\w.-]+/g, '_')}`;
const rows = [];
const t0 = Date.now();
for (const id of ids) {
  console.log(`::group::[${rows.length + 1}/${ids.length}] ${id}`);
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(root, 'scripts/ci/run-job.mjs'), 'rig', id], { cwd: root, stdio: 'inherit', env: { ...process.env, CI_GROUP: '1', CI_DISCOVERY: '1' } });
  console.log('::endgroup::');
  const f = path.join(resultDir, `${slug(id)}.json`);
  let res = null;
  try { res = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* the runner died before writing: red below */ }
  rows.push({ id, ok: !!res?.ok && r.status === 0, res });
  if (res) console.log(`[group ${n}] ${res.ok ? 'ok ' : 'RED'} ${id} — ${res.why} (run=${res.counts.run} pass=${res.counts.pass} fail=${res.counts.fail} skipped=${res.counts.skipped}, ${res.wallSec}s)`);
  else console.log(`[group ${n}] RED ${id} — no result file (the rig runner itself failed)`);
}
const bad = rows.filter((r) => !r.ok);
const md = [`### ${MUT ? `Mutant part ${n}/${partN}` : `Rig group ${n}`}: ${bad.length ? `❌ ${bad.length} of ${rows.length} red` : `✅ ${rows.length} rigs green`} (${Math.round((Date.now() - t0) / 60000)} min)`, '', '| | rig | run | passed | failed | skipped | wall |', '|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.ok ? '✅' : '❌'} | \`${r.id}\` | ${r.res?.counts.run ?? '—'} | ${r.res?.counts.pass ?? '—'} | ${r.res?.counts.fail ?? '—'} | ${r.res?.counts.skipped ?? '—'} | ${r.res ? `${r.res.wallSec}s${r.res.attempts > 1 ? ` (${r.res.attempts} attempts)` : ''}${r.res.armRetries > 0 ? ` (${r.res.armRetries} arm re-runs)` : ''}` : '—'} |${r.ok ? '' : ` ${r.res?.why ?? 'no result'}`}`), ''].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
console.log(md);
process.exitCode = bad.length ? 1 : 0;
