// Per-workspace, DISK-backed TMPDIR for every local agent session. On hosts where /tmp is a tmpfs
// it is RAM: agents' rigs and test fixtures filled 14 GB of it (2026-10-12). Pure: paths + decisions only.
import { createHash } from 'node:crypto';

/** Env var Orchestra sets beside TMPDIR: marks "TMPDIR is ours" (the /tmp guard keys on it). */
export const AGENT_TMPDIR_ENV = 'ORCHESTRA_AGENT_TMPDIR';

/** Chromium's `<TMPDIR>/org.chromium.Chromium.XXXXXX/SingletonSocket` must fit AF_UNIX's 108 bytes:
 *  headless Chromium dumped core at a 65-byte TMPDIR, ran at 60 (measured 2026-10-12). Longer ⇒ not set. */
export const AGENT_TMPDIR_MAX_LEN = 60;

/** `/var/tmp/orch-<uid>-<6 hex of the Orchestra home>`: /var/tmp is disk (FHS) and survives reboots;
 *  the home hash keeps a dev/rig instance from sweeping the packaged app's dirs. */
export function agentTmpRoot(uid: number, orchestraHome: string, base = '/var/tmp'): string {
  const h = createHash('sha256').update(orchestraHome).digest('hex').slice(0, 6);
  return `${base.replace(/\/+$/, '')}/orch-${uid}-${h}`;
}

/** The dir NAME for a workspace: 12 hex of its id (short — see AGENT_TMPDIR_MAX_LEN). */
export function agentTmpName(wsId: string): string {
  const compact = wsId.toLowerCase().replace(/[^0-9a-z]/g, '');
  return compact.length >= 12 ? compact.slice(0, 12) : createHash('sha256').update(wsId).digest('hex').slice(0, 12);
}

export function agentTmpDir(root: string, wsId: string): string {
  return `${root}/${agentTmpName(wsId)}`;
}

/** Entries of the root to remove at boot: names no known workspace maps to. An empty workspace list
 *  removes NOTHING (an unreadable/empty store must never wipe the live fleet's temp dirs). */
export function planAgentTmpSweep(entries: string[], workspaceIds: string[]): string[] {
  if (workspaceIds.length === 0) return [];
  const live = new Set(workspaceIds.map(agentTmpName));
  return entries.filter((n) => /^[0-9a-z]{12}$/.test(n) && !live.has(n));
}
