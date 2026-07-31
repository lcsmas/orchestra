// Pure ranking for the Jump Palette (Ctrl/Cmd+J): fuzzy subsequence scoring
// plus most-recently-used ordering. Lives in src/shared so it is node-testable
// without Electron/React.

/** Case-insensitive greedy fuzzy-subsequence score.
 *
 * Returns `null` when `query` is not a subsequence of `target`; otherwise a
 * score where consecutive runs and word-boundary hits (start of string, or
 * after `- _ / . space`) rank above scattered matches, with a light length
 * penalty so a short target beats a sprawling one at equal match quality.
 * Empty query scores 0 (matches everything equally — callers use MRU order). */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let prevMatch = -2;
  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    let found = -1;
    for (; ti < t.length; ti++) {
      if (t[ti] === c) {
        found = ti;
        break;
      }
    }
    if (found === -1) return null;
    score += 2;
    if (found === prevMatch + 1) score += 3; // consecutive run
    if (found === 0 || /[-_/ .]/.test(t[found - 1])) score += 4; // word boundary
    prevMatch = found;
    ti = found + 1;
  }
  return score - t.length * 0.05;
}

export interface JumpTarget {
  id: string;
  /** Branch / display name — the primary match field. */
  branch: string;
  /** Repo basename ('scratch'/'orchestrator' for non-git) — secondary field. */
  repoLabel: string;
  createdAt: number;
}

/** Order palette rows.
 *
 * Empty query → most-recently-opened first (`mruIds`, newest first — the
 * session's open-history stack), then everything never opened this session by
 * `createdAt` desc. Non-empty query → fuzzy score over branch (full weight)
 * and repo label (×0.8 — matching the repo should surface its workspaces
 * without outranking a same-quality branch hit), non-matches dropped, with a
 * small MRU bonus so the workspace you just left wins ties. */
export function rankJumpTargets(
  query: string,
  targets: JumpTarget[],
  mruIds: string[],
): JumpTarget[] {
  const mruIndex = new Map(mruIds.map((id, i) => [id, i] as const));
  if (!query.trim()) {
    return [...targets].sort((a, b) => {
      const ai = mruIndex.get(a.id) ?? Infinity;
      const bi = mruIndex.get(b.id) ?? Infinity;
      if (ai !== bi) return ai - bi;
      return b.createdAt - a.createdAt;
    });
  }
  return targets
    .map((t) => {
      const branchScore = fuzzyScore(query, t.branch);
      const repoScore = fuzzyScore(query, t.repoLabel);
      const s = Math.max(branchScore ?? -Infinity, repoScore === null ? -Infinity : repoScore * 0.8);
      if (s === -Infinity) return null;
      const idx = mruIndex.get(t.id);
      const recency = idx === undefined ? 0 : Math.max(0, 2 - idx * 0.25);
      return { t, s: s + recency };
    })
    .filter((x): x is { t: JumpTarget; s: number } => x !== null)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.t);
}
