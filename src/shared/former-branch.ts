// Former name of a renamed workspace (#384, spec #380 story 21) — pure: no Electron, no node:*.
// `Workspace.formerBranch` is the name before the LATEST rename; surfaced as "ex-<previous>" in
// `orchestra peers` and the sidebar row tooltip, so an old ledger / bus reference still finds the workspace.
import type { Workspace } from './types.ts';

/** Prefix of the rendered former name. */
export const EX_PREFIX = 'ex-';

/** "ex-<previous>", or '' when the workspace was never renamed (absent / blank field). */
export function exLabel(formerBranch: string | null | undefined): string {
  const f = (formerBranch ?? '').trim();
  return f ? `${EX_PREFIX}${f}` : '';
}

/** A tooltip with the former name appended (` · ex-<previous>`); the base text is returned UNCHANGED for a
 *  never-renamed workspace, so keep the existing "(locked)" / "double-click to rename" wording intact. */
export function withExLabel(title: string, formerBranch: string | null | undefined): string {
  const ex = exLabel(formerBranch);
  return ex ? `${title} · ${ex}` : title;
}

/** The `formerBranch` field to write for a rename `before` → `after` of `ws` (spread into the updated record).
 *  Recorded only on an ACTUAL name change of a workspace that is parent-named BEFORE (`ws.namedByParent`) or AFTER
 *  (`namedByParentAfter`: the pin this rename sets) — D3: a human-created workspace's two provisional self-renames
 *  record nothing. A later rename replaces the field with the latest previous name. `{}` = leave the record's
 *  field as it is (never `{formerBranch: undefined}`: `workspace:update` is a merge and nothing here clears it). */
export function formerBranchPatch(
  ws: Pick<Workspace, 'namedByParent'>,
  before: string,
  after: string,
  namedByParentAfter?: string,
): { formerBranch?: string } {
  if (!before || before === after) return {};
  if (!ws.namedByParent && !namedByParentAfter) return {};
  return { formerBranch: before };
}

/** `orchestra peers`: the per-peer `ex` column cells, or `null` when no peer was ever renamed — the caller then
 *  adds NO column, so a fleet without renames prints byte-identical to before (same convention as the `note` column). */
export function peersExColumn(peers: ReadonlyArray<{ formerBranch?: string | null }>): string[] | null {
  const cells = peers.map((p) => exLabel(p.formerBranch));
  return cells.some((c) => c !== '') ? cells : null;
}
