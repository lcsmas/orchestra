#!/usr/bin/env node
// #568 — helper CLI over .github/ci-rigs.json (logic in src/shared/ci-rigs.ts).
//   rigs.mjs matrix            → JSON {include:[{group,count}]}: the RUNS_IN_CI rigs spread over `groups` jobs (fails if there are none)
//   rigs.mjs assign            → writes the balanced `group` of every RUNS_IN_CI rig into .github/ci-rigs.json (from its measured wallSec)
//   rigs.mjs draft             → rewrites .github/ci-rigs.json with EVERY required rig as RUNS_IN_CI (discovery input — then classified from runner logs)
//   rigs.mjs summary <dir>     → the final table (per-job counts from <dir>/*.json + the needs verdicts in $NEEDS_JSON) + the LOCAL_ONLY list; exit 1 on any red/missing job
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignGroups, readRigFile, requiredRigIds, validateRigs } from '../../src/shared/ci-rigs.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const slug = (id) => id.replace(/[^\w.-]+/g, '_');
const [cmd, arg] = process.argv.slice(2);

if (cmd === 'matrix') {
  const file = readRigFile(root);
  const problems = validateRigs(file, requiredRigIds(root).ids);
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  const groups = assignGroups(file);
  const include = groups.map((ids, i) => ({ group: i + 1, count: ids.length })).filter((g) => g.count > 0);
  if (!include.length || groups.reduce((n, g) => n + g.length, 0) !== file.rigs.filter((r) => r.class === 'RUNS_IN_CI').length) { console.error('::error::no RUNS_IN_CI rig (or a rig outside every group): an empty matrix would be a silent green'); process.exit(1); }
  console.log(JSON.stringify({ include }));
} else if (cmd === 'assign') {
  const file = readRigFile(root);
  const groups = assignGroups({ ...file, rigs: file.rigs.map(({ group: _g, ...r }) => r) });
  for (const r of file.rigs) { delete r.group; const g = groups.findIndex((ids) => ids.includes(r.id)); if (g >= 0) r.group = g + 1; }
  file.groups = file.groups ?? groups.length;
  fs.writeFileSync(path.join(root, '.github', 'ci-rigs.json'), JSON.stringify(file, null, 1) + '\n');
  console.log(groups.map((ids, i) => `group ${i + 1}: ${ids.length} rigs, ${Math.round(ids.reduce((n, id) => n + (file.rigs.find((r) => r.id === id).wallSec ?? 300), 0) / 60)} min`).join('\n'));
} else if (cmd === 'draft') {
  const { ids, commands } = requiredRigIds(root);
  const rigs = ids.map((id) => ({ id, command: commands[id] !== undefined ? `pnpm run ${id}` : `${id.endsWith('.sh') ? 'bash' : 'node'} ${id}`, class: 'RUNS_IN_CI', reason: 'UNMEASURED (discovery draft)' }));
  fs.writeFileSync(path.join(root, '.github', 'ci-rigs.json'), JSON.stringify({ _doc: 'Every rig is RUNS_IN_CI or LOCAL_ONLY + reason (#568). Guard: src/shared/ci-rigs.test.ts. Read by the matrix + summary of .github/workflows/ci.yml.', rigs }, null, 1) + '\n');
  console.log(`${rigs.length} rigs`);
} else if (cmd === 'summary') {
  const dir = arg;
  const results = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : [];
  const needs = JSON.parse(process.env.NEEDS_JSON || '{}');
  const file = readRigFile(root);
  const rigsExpected = file.rigs.filter((r) => r.class === 'RUNS_IN_CI').map((r) => r.id);
  const lines = []; let bad = 0;
  const row = (r) => { const t = r.tolerated ?? []; const failed = t.length ? `${r.counts.fail + t.length} (tolerated: ${t.map((x) => x.slice(0, 60)).join(' · ')} — NOT covered by CI)` : r.counts.fail; return `| ${r.ok ? '✅' : '❌'} | ${r.name} | ${r.counts.run} | ${r.counts.pass} | ${failed} | ${r.counts.skipped}${r.attempts > 1 || r.armRetries > 0 ? ` (${r.attempts > 1 ? `${r.attempts} attempts` : ''}${r.armRetries > 0 ? ` ${r.armRetries} arm re-runs` : ''})` : ''} | ${r.wallSec}s |${r.ok ? '' : ` ${r.why}`}`; };
  lines.push('## PR CI — per job', '', '| | job | run | passed | failed | skipped | wall |', '|---|---|---|---|---|---|---|');
  for (const n of ['typecheck', 'suite']) {
    const r = results.find((x) => x.name === n);
    if (!r) { bad++; lines.push(`| ❌ | ${n} | — | — | — | — | — | NO RESULT (job failed before reporting, or was cancelled/skipped)`); } else { if (!r.ok) bad++; lines.push(row(r)); }
  }
  const rigRes = new Map(results.filter((x) => x.name.startsWith('rig:')).map((x) => [x.id, x]));
  for (const id of rigsExpected) {
    const r = rigRes.get(id);
    if (!r) { bad++; lines.push(`| ❌ | rig:${id} | — | — | — | — | — | NO RESULT`); } else { if (!r.ok) bad++; lines.push(row(r)); }
  }
  for (const [id] of rigRes) if (!rigsExpected.includes(id)) { bad++; lines.push(`| ❌ | rig:${id} | | | | | | ran but is not RUNS_IN_CI in ci-rigs.json`); }
  const badNeeds = Object.entries(needs).filter(([, v]) => v.result !== 'success');
  for (const [k, v] of badNeeds) { bad++; lines.push('', `**needs.${k}.result = ${v.result}** (must be success)`); }
  const local = file.rigs.filter((r) => r.class === 'LOCAL_ONLY');
  lines.push('', `## LOCAL-ONLY rigs (${local.length}) — NOT run by CI; the verifier / owner runs them locally`, '', '| rig | reason |', '|---|---|', ...local.map((r) => `| \`${r.id}\` | ${String(r.reason).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`));
  lines.push('', bad ? `**❌ ${bad} problem(s)**` : `**✅ all ${2 + rigsExpected.length} jobs green; ${local.length} local-only rigs listed above**`);
  const md = lines.join('\n') + '\n';
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(md);
  process.exit(bad ? 1 : 0);
} else { console.error('usage: rigs.mjs matrix | draft | summary <dir>'); process.exit(2); }
