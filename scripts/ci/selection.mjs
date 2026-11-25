// #595 — the ONE place the PR CI computes its rig selection from its environment (run-group.mjs `--plan` and rigs.mjs `summary`/`select` all call it, so every job of a run derives the same answer).
// Inputs (all from the run itself, none read live): the merge commit's diff against its first parent (`$CI_BASE`, default HEAD^1), `$CI_FULL_REASON` (set by the workflow for the `ci-full`
// label), and `$CI_PATH_SELECTION=1` (set by the workflow for pull_request events only). Anything else — a dispatch, a local run — selects every rig.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { selectRigs } from '../../src/shared/ci-paths.ts';

export const pathSelectionOn = () => process.env.CI_PATH_SELECTION === '1';

/** @returns {import('../../src/shared/ci-paths.ts').Selection} */
export function currentSelection(root, file, o = {}) {
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 27 }).toString();
  const full = o.full || process.env.CI_FULL_REASON || (o.changedFile || o.base || pathSelectionOn() ? null : 'path selection is off here (no pull_request context): every rig');
  const base = o.base || process.env.CI_BASE || 'HEAD^1';
  let changed = null;
  try { changed = o.changedFile ? fs.readFileSync(o.changedFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : git('diff', '--name-only', '--no-renames', '-z', base, 'HEAD').split('\0').filter(Boolean); } catch { changed = null; }
  const ctx = {
    before: (p) => { try { return git('show', `${base}:${p}`); } catch { return null; } },
    after: (p) => { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch { return null; } },
  };
  return selectRigs(file, changed, full, ctx);
}
