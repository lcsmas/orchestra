#!/usr/bin/env node
// #568 — helper CLI over .github/ci-rigs.json (logic in src/shared/ci-rigs.ts).
//   rigs.mjs matrix            → JSON {include:[{group,count}]}: the RUNS_IN_CI rigs spread over `groups` jobs (fails if there are none)
//   rigs.mjs shards            → JSON {include:[{shard,shards}]}: the suite shard jobs (`suiteShards` of the file; #594)
//   rigs.mjs assign            → writes the balanced `group` of every RUNS_IN_CI rig into .github/ci-rigs.json (from its measured wallSec)
//   rigs.mjs draft             → rewrites .github/ci-rigs.json with EVERY required rig as RUNS_IN_CI (discovery input — then classified from runner logs)
//   rigs.mjs select [--changed-file F] [--base REV] [--full REASON]  (#595) → ONE JSON line: the path selection (which RUNS_IN_CI rigs run / are skipped and why) for the changed files of F
//                                (one path per line; default `git diff REV HEAD`, REV = $CI_BASE or HEAD^1); an unreadable list, a shared or unclaimed file, or --full ⇒ every rig. run-group.mjs and `summary` compute the same selection.
//   rigs.mjs paths [--write] [id…] → the declared `paths` each rig's own command needs (closure walk, src/shared/ci-closure.ts); --write regenerates them in .github/ci-rigs.json (keeps `pathsExtra`)
//   rigs.mjs summary <dir>     → the final table (per-job counts from <dir>/*.json + the needs verdicts in $NEEDS_JSON) + the LOCAL_ONLY list; exit 1 on any red/missing job.
//                                This IS the check named `suite` (#594): red when any suite shard is red, missing, cancelled or ran 0 tests (`judgeShards`), or any other job is.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignGroups, isMutantRig, judgeShards, readRigFile, requiredRigIds, suiteShardsOf, validateRigs } from '../../src/shared/ci-rigs.ts';
import { repoTree } from '../../src/shared/ci-closure.ts';
import { currentSelection, pathSelectionOn } from './selection.mjs';
import { generatePaths, renderSelection, selectRigs, toWire } from '../../src/shared/ci-paths.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const slug = (id) => id.replace(/[^\w.-]+/g, '_');
const [cmd, arg] = process.argv.slice(2);
const flag = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };

if (cmd === 'select') {
  const file = readRigFile(root);
  const problems = validateRigs(file, requiredRigIds(root).ids);
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log(JSON.stringify(toWire(currentSelection(root, file, { changedFile: flag('--changed-file'), base: flag('--base'), full: flag('--full') }))));
} else if (cmd === 'matrix') {
  const file = readRigFile(root);
  const problems = validateRigs(file, requiredRigIds(root).ids);
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  const groups = assignGroups(file);
  const include = groups.map((ids, i) => ({ group: i + 1, count: ids.length })).filter((g) => g.count > 0);
  if (!include.length || groups.reduce((n, g) => n + g.length, 0) !== file.rigs.filter((r) => r.class === 'RUNS_IN_CI').length) { console.error('::error::no RUNS_IN_CI rig (or a rig outside every group): an empty matrix would be a silent green'); process.exit(1); }
  console.log(JSON.stringify({ include }));
} else if (cmd === 'shards') {
  const n = suiteShardsOf(readRigFile(root));
  console.log(JSON.stringify({ include: Array.from({ length: n }, (_, i) => ({ shard: i + 1, shards: n })) }));
} else if (cmd === 'assign') {
  const file = readRigFile(root);
  // #623: two phases — the non-mutant rigs balanced over the first `prGroups` groups, then the mutant rigs (skipped on a pull_request) onto the lightest of all `groups`.
  const N = file.groups ?? 4, K = Math.min(file.prGroups ?? N, N);
  const w = (r) => r.wallSec ?? 300;
  const load = Array(N).fill(0);
  for (const r of file.rigs) delete r.group;
  const ci = file.rigs.filter((r) => r.class === 'RUNS_IN_CI');
  const place = (rs, upTo) => { for (const r of rs.sort((a, b) => w(b) - w(a) || a.id.localeCompare(b.id))) { const g = load.indexOf(Math.min(...load.slice(0, upTo))); r.group = g + 1; load[g] += w(r); } };
  place(ci.filter((r) => !isMutantRig(r.id)), K);
  place(ci.filter((r) => isMutantRig(r.id)), N);
  const groups = assignGroups(file);
  file.groups = N;
  fs.writeFileSync(path.join(root, '.github', 'ci-rigs.json'), JSON.stringify(file, null, 1) + '\n');
  console.log(groups.map((ids, i) => `group ${i + 1}: ${ids.length} rigs, ${Math.round(ids.reduce((n, id) => n + (file.rigs.find((r) => r.id === id).wallSec ?? 300), 0) / 60)} min`).join('\n'));
} else if (cmd === 'draft') {
  const { ids, commands } = requiredRigIds(root);
  const rigs = ids.map((id) => ({ id, command: commands[id] !== undefined ? `pnpm run ${id}` : `${id.endsWith('.sh') ? 'bash' : 'node'} ${id}`, class: 'RUNS_IN_CI', reason: 'UNMEASURED (discovery draft)' }));
  fs.writeFileSync(path.join(root, '.github', 'ci-rigs.json'), JSON.stringify({ _doc: 'Every rig is RUNS_IN_CI or LOCAL_ONLY + reason (#568). Guard: src/shared/ci-rigs.test.ts. Read by the matrix + summary of .github/workflows/ci.yml.', rigs }, null, 1) + '\n');
  console.log(`${rigs.length} rigs`);
} else if (cmd === 'paths') {
  const file = readRigFile(root);
  const tree = repoTree(root);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  const write = process.argv.includes('--write');
  const only = process.argv.slice(3).filter((a) => !a.startsWith('--'));
  const gen = generatePaths(file, tree, pkg);
  if (write) {
    file.pathSets = gen.pathSets;
    for (const r of file.rigs) if (!only.length || only.includes(r.id)) r.paths = gen.paths[r.id];
    const order = ['_doc', 'groups', 'prGroups', 'suiteShards', 'sharedPaths', 'noRigPaths', 'pathSets', 'rigs'];
    const out = {}; for (const k of order) if (file[k] !== undefined) out[k] = file[k]; for (const k of Object.keys(file)) if (!(k in out)) out[k] = file[k];
    fs.writeFileSync(path.join(root, '.github', 'ci-rigs.json'), JSON.stringify(out, null, 1) + '\n');
    console.log(`wrote pathSets (${Object.keys(gen.pathSets).join(', ')}) and paths for ${only.length || file.rigs.length} rig(s)`);
  } else for (const r of file.rigs) if (!only.length || only.includes(r.id)) console.log(`${r.id}: ${gen.paths[r.id].length} path entries${only.length ? `\n${gen.paths[r.id].map((g) => `  ${g}`).join('\n')}` : ''}`);
} else if (cmd === 'summary') {
  const dir = arg;
  const results = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : [];
  const needs = JSON.parse(process.env.NEEDS_JSON || '{}');
  const file = readRigFile(root);
  const sel = pathSelectionOn() ? toWire(currentSelection(root, file)) : null;
  const allCi = file.rigs.filter((r) => r.class === 'RUNS_IN_CI').map((r) => r.id);
  const rigsExpected = sel ? allCi.filter((id) => sel.ids.includes(id)) : allCi;
  const lines = []; let bad = 0;
  const row = (r) => { const t = r.tolerated ?? []; const failed = t.length ? `${r.counts.fail + t.length} (tolerated: ${t.map((x) => x.slice(0, 60)).join(' · ')} — NOT covered by CI)` : r.counts.fail; return `| ${r.ok ? '✅' : '❌'} | ${r.name} | ${r.counts.run} | ${r.counts.pass} | ${failed} | ${r.counts.skipped}${r.attempts > 1 || r.armRetries > 0 ? ` (${r.attempts > 1 ? `${r.attempts} attempts` : ''}${r.armRetries > 0 ? ` ${r.armRetries} arm re-runs` : ''})` : ''} | ${r.wallSec}s |${r.ok ? '' : ` ${r.why}`}`; };
  lines.push('## PR CI — per job', '', '| | job | run | passed | failed | skipped | wall |', '|---|---|---|---|---|---|---|');
  const tc = results.find((x) => x.name === 'typecheck');
  if (!tc) { bad++; lines.push('| ❌ | typecheck | — | — | — | — | — | NO RESULT (job failed before reporting, or was cancelled/skipped)'); } else { if (!tc.ok) bad++; lines.push(row(tc)); }
  // The suite shards (#594): each shard's own row, then ONE verdict over all of them — a missing / cancelled / red / empty shard is red.
  const nShards = suiteShardsOf(file);
  const shardRes = results.filter((x) => /^suite shard /.test(x.name));
  for (let i = 1; i <= nShards; i++) {
    const r = shardRes.find((x) => x.shard === i);
    if (r) lines.push(row(r)); else lines.push(`| ❌ | suite shard ${i}/${nShards} | — | — | — | — | — | NO RESULT (job failed before reporting, or was cancelled/skipped)`);
  }
  const sv = judgeShards(shardRes, nShards);
  if (!sv.ok) bad += sv.problems.length;
  const suiteLine = sv.ok ? `suite: ${sv.tests} tests over ${nShards} shard(s), every shard present and green` : `suite RED:\n- ${sv.problems.join('\n- ')}`;
  const rigRes = new Map(results.filter((x) => x.name.startsWith('rig:')).map((x) => [x.id, x]));
  for (const id of rigsExpected) {
    const r = rigRes.get(id);
    if (!r) { bad++; lines.push(`| ❌ | rig:${id} | — | — | — | — | — | NO RESULT`); } else { if (!r.ok) bad++; lines.push(row(r)); }
  }
  for (const [id] of rigRes) if (!rigsExpected.includes(id)) { bad++; lines.push(`| ❌ | rig:${id} | | | | | | ran but is not RUNS_IN_CI in ci-rigs.json`); }
  const badNeeds = Object.entries(needs).filter(([, v]) => v.result !== 'success');
  for (const [k, v] of badNeeds) { bad++; lines.push('', `**needs.${k}.result = ${v.result}** (must be success)`); }
  const local = file.rigs.filter((r) => r.class === 'LOCAL_ONLY');
  if (sel) lines.unshift(renderSelection(sel, allCi.length));
  lines.push('', `## LOCAL-ONLY rigs (${local.length}) — NOT run by CI; the verifier / owner runs them locally`, '', '| rig | reason |', '|---|---|', ...local.map((r) => `| \`${r.id}\` | ${String(r.reason).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`));
  lines.push('', suiteLine, '', bad ? `**❌ ${bad} problem(s)**` : `**✅ typecheck + ${nShards} suite shard(s) + ${rigsExpected.length} rigs green${sel && sel.mode === 'paths' ? ` (${sel.skipped.length} rigs SKIPPED BY PATH — see the selection above; the release gate runs them all)` : ''}; ${local.length} local-only rigs listed above**`);
  const md = lines.join('\n') + '\n';
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(md);
  process.exit(bad ? 1 : 0);
} else { console.error('usage: rigs.mjs select | matrix | shards | paths | assign | draft | summary <dir>'); process.exit(2); }
