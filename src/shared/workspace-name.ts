import path from 'node:path';
import { isScratchLike, type Workspace } from './types.ts';

/** The sidebar display name for a workspace on a given branch — the single
 * answer to "what goes before the ` · `".
 *
 * Split out because the rename path used to hardcode it in two places and got
 * it wrong in both: the scratch branch wrote `scratch · ` unconditionally (so
 * an orchestrator's first auto-rename silently demoted its own display name,
 * undoing what `/promote` had just set), and the git branch wrote
 * `<repoName> · ` unconditionally (which would strip the coordinator prefix
 * from an orchestrator that owns a repo).
 *
 * The KIND decides the prefix, never the git-ness: a coordinator keeps its
 * identity whether or not it owns a checkout. Only a plain worktree is named
 * after its repo. */
export function workspaceDisplayName(
  ws: Pick<Workspace, 'kind' | 'repoPath'>,
  branch: string,
): string {
  if (ws.kind === 'orchestrator') return `orchestrator · ${branch}`;
  if (ws.kind === 'scratch') return `scratch · ${branch}`;
  // A git worktree (promoted or not) is filed under its repo, so it reads best
  // named after it. `isScratchLike` guards the degenerate case of a worktree
  // record with no repoPath, where `path.basename('')` would yield ''.
  if (isScratchLike(ws) || !ws.repoPath) return `scratch · ${branch}`;
  return `${path.basename(ws.repoPath)} · ${branch}`;
}
