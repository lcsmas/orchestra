// #595 — the ONE place the PR CI computes its rig selection from its environment (run-group.mjs `--plan` and rigs.mjs `summary`/`select` all call it, so every job of a run derives the same answer).
// Inputs (all from the run itself, none read live): the merge commit's diff against its first parent (`$CI_BASE`, default HEAD^1), `$CI_FULL_REASON` (set by the workflow for the `ci-full`
// label), and `$CI_PATH_SELECTION=1` (set by the workflow for pull_request events only). Anything else — a dispatch, a local run — selects every rig.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { selectRigs } from '../../src/shared/ci-paths.ts';
import { isMutantRig } from '../../src/shared/ci-rigs.ts';
import { createWalker, repoTree } from '../../src/shared/ci-closure.ts';

export const pathSelectionOn = () => process.env.CI_PATH_SELECTION === '1';

/** @returns {import('../../src/shared/ci-paths.ts').Selection} */
export function currentSelection(root, file, o = {}) {
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 27 }).toString();
  const full = o.full || process.env.CI_FULL_REASON || (o.changedFile || o.base || pathSelectionOn() ? null : 'path selection is off here (no pull_request context): every rig');
  const base = o.base || process.env.CI_BASE || 'HEAD^1';
  let changed = null;
  try { changed = o.changedFile ? fs.readFileSync(o.changedFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : git('diff', '--name-only', '--no-renames', '-z', base, 'HEAD').split('\0').filter(Boolean); } catch { changed = null; }
  let walker;
  const ctx = {
    before: (p) => { try { return git('show', `${base}:${p}`); } catch { return null; } },
    after: (p) => { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch { return null; } },
    // a rig reaches a package.json script through its command AND the script files it runs (review F6): the closure walk of the head tree, built only when package.json changed
    scriptsReachedBy: (rig) => {
      walker ??= createWalker(repoTree(root), JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts ?? {});
      return walker.closure(rig.command).scripts;
    },
  };
  const sel = selectRigs(file, changed, full, ctx);
  // #623: on a pull_request a mutant rig never runs or blocks (it runs on push to master + nightly, mutants.yml); only an explicit full run (`ci-full` label) keeps it.
  if (pathSelectionOn() && !process.env.CI_FULL_REASON && !o.full) {
    const why = 'mutant rig: runs on push to master + nightly (mutants.yml), never on a pull_request (#623)';
    const moved = sel.ran.filter((r) => isMutantRig(r.id));
    if (moved.length) return { ...sel, mode: 'paths', ran: sel.ran.filter((r) => !isMutantRig(r.id)), skipped: [...sel.skipped.filter((r) => !isMutantRig(r.id)), ...moved.map((r) => ({ id: r.id, why }))] };
  }
  return sel;
}
