/**
 * Pure helpers for the host side of "import to sandbox" (provisioning a
 * container-owned /workspace checkout). No electron / fs / net imports so the
 * strip-types test runner can exercise them directly; the I/O lives in
 * src/main/sandbox-import.ts.
 */

/** meta.json entry of the import payload tar — must match the shim's
 *  ImportMeta (sandbox/shim/shim-import.ts). */
export interface ImportMeta {
  session: string;
  branch: string;
  baseBranch?: string;
  originUrl?: string;
}

/**
 * Map a sandbox WS endpoint to the shim's admin-HTTP URL for a route.
 * The shim serves WS upgrades and plain HTTP on the SAME port, so only the
 * scheme changes: ws→http, wss→https. Any path on the endpoint is discarded
 * (the shim's admin routes are absolute).
 */
export function endpointToHttpUrl(endpoint: string, route: string): string {
  const u = new URL(endpoint);
  if (u.protocol === 'ws:') u.protocol = 'http:';
  else if (u.protocol === 'wss:') u.protocol = 'https:';
  else if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`unsupported sandbox endpoint scheme: ${u.protocol}`);
  }
  u.pathname = route.startsWith('/') ? route : `/${route}`;
  u.search = '';
  return u.toString();
}

/** Parse `git … -z` NUL-delimited output into a clean path list. */
export function parseZList(output: string): string[] {
  return output.split('\0').filter((p) => p.length > 0);
}

/**
 * Decide which paths ride the overlay (the tar's worktree/ entry): files git
 * doesn't carry in the bundle. Input lists come from
 *   `git ls-files --others --exclude-standard -z`  (untracked, not ignored)
 *   `git diff --name-only -z HEAD`                 (uncommitted modifications)
 * plus the hook dirs, which are gitignored on purpose but MUST move with the
 * workspace (the shim spawn path assumes hooks exist in /workspace).
 * Deduplicated, order-stable.
 */
export function overlayPaths(untracked: string[], modified: string[], hookDirs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...untracked, ...modified, ...hookDirs]) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** The gitignored dirs that must ride the overlay for the sandbox agent to
 *  work: Orchestra's hook scripts and Claude's per-worktree settings. */
export const HOOK_DIRS = ['.orchestra', '.claude'] as const;
