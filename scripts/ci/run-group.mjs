#!/usr/bin/env node
// #568 (D5) — run ONE group of rigs in sequence on this runner: `node --experimental-strip-types scripts/ci/run-group.mjs <n>`.
// Each rig goes through run-job.mjs (retry on a dead compositor, per-rig timeout, counts, no-silent-green judge); a failing rig does NOT stop the group.
// The job summary gets ONE per-rig table (pass/fail, counts, duration); the step fails at the end if any rig was red. The per-rig result files land in CI_RESULT_DIR.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignGroups, readRigFile } from '../../src/shared/ci-rigs.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const n = Number(process.argv[2]);
const file = readRigFile(root);
const ids = assignGroups(file)[n - 1];
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
const md = [`### Rig group ${n}: ${bad.length ? `❌ ${bad.length} of ${rows.length} red` : `✅ ${rows.length} rigs green`} (${Math.round((Date.now() - t0) / 60000)} min)`, '', '| | rig | run | passed | failed | skipped | wall |', '|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.ok ? '✅' : '❌'} | \`${r.id}\` | ${r.res?.counts.run ?? '—'} | ${r.res?.counts.pass ?? '—'} | ${r.res?.counts.fail ?? '—'} | ${r.res?.counts.skipped ?? '—'} | ${r.res ? `${r.res.wallSec}s${r.res.attempts > 1 ? ` (${r.res.attempts} attempts)` : ''}${r.res.armRetries > 0 ? ` (${r.res.armRetries} arm re-runs)` : ''}` : '—'} |${r.ok ? '' : ` ${r.res?.why ?? 'no result'}`}`), ''].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
console.log(md);
process.exitCode = bad.length ? 1 : 0;
