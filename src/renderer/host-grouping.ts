/**
 * Pure helpers for grouping a repo's workspaces by the machine they run on
 * (the per-node sidebar sections). Split out of Sidebar.tsx so they can be unit
 * tested without rendering React, and so the grouping rules live in one place.
 */

import type { Workspace, WorkspaceHost } from '../shared/types';

/** Stable key for the machine a workspace runs on: `'local'` for the local
 *  node-pty default (host absent or kind 'local'), or `sandbox:<endpoint>` for a
 *  sandbox-hosted one. Used to group a repo's workspaces by node and to persist
 *  per-node collapse state. */
export function hostKeyOf(ws: Pick<Workspace, 'host'>): string {
  return ws.host?.kind === 'sandbox' ? `sandbox:${ws.host.endpoint}` : 'local';
}

/** Human label for a node header. Local is "This machine"; a sandbox shows its
 *  endpoint host (the ws:// URL's host:port), falling back to the raw endpoint
 *  string when it isn't a parseable URL. */
export function hostLabel(hostKey: string): string {
  if (hostKey === 'local') return 'This machine';
  const endpoint = hostKey.slice('sandbox:'.length);
  try {
    const u = new URL(endpoint);
    return u.host || endpoint;
  } catch {
    return endpoint;
  }
}

/**
 * Order a repo's workspaces into per-node groups WITHOUT reordering within a
 * node (the user's drag order is preserved inside each group). Local always
 * sorts first; sandbox nodes follow in first-seen order. Returns null when every
 * workspace is local — the caller then renders the flat list unchanged, so the
 * common single-machine case shows no node headers at all.
 */
export function groupByHost<T extends Pick<Workspace, 'host'>>(
  items: T[],
): Array<{ key: string; items: T[] }> | null {
  const order: string[] = [];
  const groups = new Map<string, T[]>();
  for (const w of items) {
    const k = hostKeyOf(w);
    let g = groups.get(k);
    if (!g) {
      g = [];
      groups.set(k, g);
      order.push(k);
    }
    g.push(w);
  }
  // Nothing remote → no grouping; preserve the flat rendering exactly.
  if (!order.some((k) => k !== 'local')) return null;
  order.sort((a, b) => (a === 'local' ? -1 : b === 'local' ? 1 : 0));
  return order.map((key) => ({ key, items: groups.get(key)! }));
}

/** Re-export for callers that build a sandbox host inline. */
export type { WorkspaceHost };
