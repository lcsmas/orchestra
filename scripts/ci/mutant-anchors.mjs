#!/usr/bin/env node
// #665 — a PR that moves code a mutant anchors on is caught HERE, in seconds, not after the merge: for every RUNS_IN_CI mutant rig the PR's paths select, read its mutant list (no rig run)
// and check each anchor still occurs exactly once in the PR tree. A stale anchor fails the step and names the rig, the mutant and the file.
//   node --experimental-strip-types --no-warnings scripts/ci/mutant-anchors.mjs [--all] [--root <tree>] [--registry <file>] [--no-build]
//   (default) the mutant rigs the changed files select — scripts/ci/selection.mjs, the selection of the rig groups, minus the #623 move of mutant rigs out of a PR run
//   --all     every script of the registry     --root  check another tree (the pre-merge trees of the #665 proof)     --no-build  trust dist-electron/cli.js as it is
// Registry scripts/ci/mutant-anchors.json: `check: "own"` = the rig's own `--check-anchors` dry mode (reused as is); otherwise its list is read by scripts/lib/mutant-anchors.mjs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMutantRig, readRigFile } from '../../src/shared/ci-rigs.ts';
import { createWalker, repoTree } from '../../src/shared/ci-closure.ts';
import { currentSelection } from './selection.mjs';
import { anchorsOf, loadLists, staleAnchors } from '../lib/mutant-anchors.mjs';

const tool = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const flag = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const root = path.resolve(flag('--root') ?? tool);
export const registry = JSON.parse(fs.readFileSync(path.resolve(flag('--registry') ?? path.join(tool, 'scripts', 'ci', 'mutant-anchors.json')), 'utf8'));

/** Every anchor of one registered script, read in tree `rootDir`: [{ id, file, find }]. */
export async function scriptAnchors(rootDir, script, spec) {
  const items = spec.lists.map((l) => (typeof l === 'string' ? { name: l } : l));
  const lists = await loadLists(tool, rootDir, script, items.map((l) => l.name));
  const out = [];
  for (const { name, dir = spec.dir, file = spec.file } of items) {
    const list = lists[name];
    if (!Array.isArray(list) || !list.length) throw new Error(`${script}: ${name} is not a non-empty array`);
    list.forEach((entry, i) => out.push(...anchorsOf(entry, i, { dir, file, root: rootDir })));
  }
  return out;
}

/** The rig's own dry check (`--check-anchors`: no mutation, no run): [] when it passes, else its ANCHOR-BAD lines. */
export function ownCheck(rootDir, script) {
  const file = path.join(rootDir, script);
  if (!fs.existsSync(file)) return [`${script}: the script does not exist in this tree`];
  if (!fs.readFileSync(file, 'utf8').includes("'--check-anchors'")) return [`${script}: registry says it has its own --check-anchors, the script does not — add it, or give the registry its \`lists\``];
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', file, '--check-anchors'], { cwd: rootDir, encoding: 'utf8', timeout: 120_000 });
  if (r.status === 0) return [];
  const bad = `${r.stdout}\n${r.stderr}`.split('\n').filter((l) => /ANCHOR-BAD|✗|PATTERN-GONE|REFUSED|stale|BAD/.test(l) && !/^ANCHORS: /.test(l));
  return bad.length ? bad.map((l) => l.trim()) : [`${script} --check-anchors exited ${r.status}: ${`${r.stdout}${r.stderr}`.trim().split('\n').slice(-3).join(' | ')}`];
}

const verdict = async () => {
  const t0 = Date.now();
  const read = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return null; } };
  const problems = []; const chosen = new Map(); // script → the rigs that selected it
  if (process.argv.includes('--all')) for (const s of Object.keys(registry.scripts)) { if (fs.existsSync(path.join(root, s))) chosen.set(s, ['--all']); }
  else {
    const rigFile = readRigFile(root);
    const rigs = rigFile.rigs.filter((r) => r.class === 'RUNS_IN_CI' && isMutantRig(r.id));
    const sel = currentSelection(root, rigFile, { keepMutants: true });
    const ran = new Set(sel.ran.map((r) => r.id));
    const walker = createWalker(repoTree(root), JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts ?? {});
    const picked = rigs.filter((r) => ran.has(r.id));
    for (const rig of picked) {
      const files = walker.closure(rig.command).files;
      const ss = Object.keys(registry.scripts).filter((s) => files.has(s));
      if (!ss.length && !(rig.id in registry.exempt)) problems.push(`${rig.id}: reaches no script of scripts/ci/mutant-anchors.json and is not in "exempt" — register where its mutant list lives, or exempt it with a reason`);
      for (const s of ss) chosen.set(s, [...(chosen.get(s) ?? []), rig.id]);
    }
    console.log(`[mutant-anchors] ${sel.mode === 'all' ? `every rig (${sel.fullReason})` : 'by path'}: ${picked.length} of ${rigs.length} mutant rigs selected → ${chosen.size} script(s)`);
  }
  if ([...chosen.keys()].some((s) => registry.scripts[s].build) && !process.argv.includes('--no-build')) {
    const b = spawnSync('pnpm', ['run', ...new Set([...chosen.keys()].map((s) => registry.scripts[s].build).filter(Boolean))], { cwd: root, encoding: 'utf8' });
    if (b.status !== 0) problems.push(`the bundle build failed (a rig anchored on dist-electron/cli.js cannot be checked): ${`${b.stdout}${b.stderr}`.trim().split('\n').slice(-4).join(' | ')}`);
  }
  let nAnchors = 0;
  for (const [script, ids] of chosen) {
    const spec = registry.scripts[script]; const who = ids.join(', ');
    try {
      if (spec.check === 'own') { for (const l of ownCheck(root, script)) problems.push(`${who} — ${script}: ${l}`); continue; }
      const anchors = await scriptAnchors(root, script, spec);
      nAnchors += anchors.length;
      for (const s of staleAnchors(anchors, read)) problems.push(`${who} — ${script}: mutant ${s.id} anchors ${s.missing ? `a file that does not exist (${s.file})` : `${s.n}× in ${s.file} (need ${s.min ? `≥ ${s.min}` : 'exactly 1'})`}: ${JSON.stringify(String(s.find)).slice(0, 140)}`);
    } catch (e) { problems.push(`${who} — ${script}: ${e.message}`); }
  }
  return { problems, nAnchors, scripts: chosen.size, wall: ((Date.now() - t0) / 1000).toFixed(1) };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const v = await verdict();
  if (v.problems.length) {
    for (const p of v.problems) console.log(`::error::mutant anchor — ${p}`);
    console.log(`[mutant-anchors] FAIL: ${v.problems.length} problem(s); ${v.nAnchors} anchors read over ${v.scripts} script(s) in ${v.wall}s`);
    process.exit(1);
  }
  console.log(`[mutant-anchors] OK: ${v.nAnchors} anchors read (+ the rigs' own checks) over ${v.scripts} script(s), each exactly once, ${v.wall}s`);
}
